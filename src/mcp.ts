import * as http from 'node:http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { compactCatalog } from './api';
import { Orchestrator } from './orchestrator';
import { QuotaGuard } from './quota';

const asText = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });
const executionModeSchema = z.enum(['apply', 'plan', 'dry-run']);
const routingProfileSchema = z.enum(['eco', 'fast', 'quality', 'security', 'refactor']);

function buildMcp(orch: Orchestrator, quota: QuotaGuard): McpServer {
  const s = new McpServer({ name: 'francestudent-atg', version: '0.6.3' });

  s.registerTool('fs_delegate', {
    title: 'Déléguer à France Student [ATG]',
    description: 'Confie une tâche de code à France Student. En mode apply, les fichiers peuvent être écrits dans le workspace après validation ; plan et dry-run restent sans écriture. Asynchrone : renvoie un jobId, puis appelle fs_job_status.',
    inputSchema: {
      task: z.string().min(3).describe('Consigne précise. Préfixe [haiku]/[sonnet]/... pour forcer un modèle.'),
      files: z.array(z.string()).optional().describe('Chemins relatifs au workspace à joindre.'),
      model: z.string().optional(),
      priority: z.number().int().min(0).max(9).optional(),
      contextMode: z.enum(['minimal', 'targeted', 'smart']).optional(),
      executionMode: executionModeSchema.optional().describe('apply ecrit apres validation; plan et dry-run ne modifient aucun fichier.'),
      routingProfile: routingProfileSchema.optional().describe('Profil local de routage : eco, fast, quality, security ou refactor.'),
      parentJobId: z.string().optional().describe('Suite d\'un job : seul son résumé est réutilisé.'),
    },
  }, async a => {
    const job = orch.submit({ ...a, source: 'mcp' });
    return asText({ jobId: job.id, status: job.status, next: 'Appelle fs_job_status avec waitSeconds=45.' });
  });

  s.registerTool('fs_job_status', {
    title: 'État d\'un job [ATG]',
    description: 'Attend jusqu\'à waitSeconds que le job finisse, puis renvoie son état, son résumé et les fichiers écrits.',
    inputSchema: { jobId: z.string(), waitSeconds: z.number().min(0).max(45).optional() },
  }, async ({ jobId, waitSeconds }) => {
    const job = await orch.waitFor(jobId, (waitSeconds ?? 30) * 1000);
    return asText(job ? orch.publicView(job) : { error: 'jobId inconnu' });
  });

  s.registerTool('fs_apply_review', {
    title: 'Appliquer une proposition revue [ATG]',
    description: 'Applique un dry-run seulement apres revue explicite. Le VSIX ouvre le diff et peut encore demander confirmation selon les reglages.',
    inputSchema: { jobId: z.string() },
  }, async ({ jobId }) => asText(await orch.applyReview(jobId)));

  s.registerTool('fs_undo', {
    title: 'Restaurer un job [ATG]',
    description: 'Restaure les snapshots en memoire de cette session seulement. Refuse les fichiers modifies depuis l application et les signale dans changed.',
    inputSchema: { jobId: z.string() },
  }, async ({ jobId }) => asText(await orch.undo(jobId)));

  s.registerTool('fs_diagnostics', {
    title: 'Diagnostic France Student [ATG]',
    description: 'Etat reel de SecretStorage, derniere verification API, modeles, quota, MCP, session et dernier etat reseau observe. Ne retourne jamais la cle.',
    inputSchema: { refresh: z.boolean().optional().describe('Verifie quota et modeles maintenant (lecture seule).') },
  }, async ({ refresh }) => asText(refresh ? await orch.refreshDiagnostics() : await orch.diagnostics()));

  s.registerTool('fs_quota', {
    title: 'Quota France Student',
    description: 'Pourcentage de quota restant et seuil du coupe-circuit.',
    inputSchema: {},
  }, async () => {
    const q = await quota.snapshot(true);
    return asText({ remainingPct: q.remainingPct, cutoff: vscode.workspace.getConfiguration('francestudent').get('cutoffPercent') });
  });

  s.registerTool('fs_session', {
    title: 'Session France Student',
    description: 'Affiche, compacte ou renouvelle le chat direct persistant.',
    inputSchema: { action: z.enum(['status', 'compact', 'new']).default('status') },
  }, async ({ action }) => asText(await orch.session(action)));

  s.registerTool('fs_catalog', {
    title: 'Catalogue France Student',
    description: 'Lit seulement les modèles, la capacité de flux, les Skills, les Projects, les serveurs MCP distants ou les fichiers v2. La sortie est bornée pour économiser le contexte ; aucune ressource distante n’est créée ni modifiée.',
    inputSchema: {
      resource: z.enum(['all', 'models', 'streams', 'capacity', 'skills', 'projects', 'mcpServers', 'files']).default('all'),
    },
  }, async ({ resource }) => {
    const selected = resource === 'capacity' ? 'streams' : resource;
    const catalog = selected === 'all' ? await orch.catalog() : await orch.catalog(selected);
    return asText(compactCatalog(catalog));
  });

  s.registerTool('fs_cancel', {
    title: 'Annuler un job [ATG]',
    description: 'Annule un job en file ou en cours.',
    inputSchema: { jobId: z.string() },
  }, async ({ jobId }) => { orch.cancel(jobId); return asText({ ok: true }); });

  return s;
}

export async function startMcpServer(orch: Orchestrator, quota: QuotaGuard, token: string, port: number): Promise<vscode.Disposable> {
  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
      if (url.searchParams.get('token') !== token) { res.writeHead(401).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; } // mode stateless

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

      const server = buildMcp(orch, quota);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String((e as Error).message));
    }
  });
  await new Promise<void>((ok, ko) => { httpServer.once('error', ko); httpServer.listen(port, '127.0.0.1', ok); });
  orch.setMcpStatus('ready', `127.0.0.1:${port}`);
  return { dispose: () => { orch.setMcpStatus('not-started'); httpServer.close(); } };
}
