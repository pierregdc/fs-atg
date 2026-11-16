import * as http from 'node:http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Orchestrator } from './orchestrator';
import { QuotaGuard } from './quota';

const asText = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });

function buildMcp(orch: Orchestrator, quota: QuotaGuard): McpServer {
  const s = new McpServer({ name: 'francestudent-atg', version: '0.1.0' });

  s.registerTool('fs_delegate', {
    title: 'Déléguer à France Student [ATG]',
    description: 'Délègue une tâche de code à un agent France Student. Les fichiers sont écrits directement dans le workspace : ne recopie pas le code. Asynchrone : renvoie un jobId, puis appelle fs_job_status.',
    inputSchema: {
      task: z.string().min(3).describe('Consigne précise. Préfixe [haiku]/[sonnet]/... pour forcer un modèle.'),
      files: z.array(z.string()).optional().describe('Chemins relatifs au workspace à joindre.'),
      model: z.string().optional(),
      priority: z.number().int().min(0).max(9).optional(),
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

  s.registerTool('fs_quota', {
    title: 'Quota France Student',
    description: 'Pourcentage de quota restant et seuil du coupe-circuit.',
    inputSchema: {},
  }, async () => {
    const q = await quota.snapshot(true);
    return asText({ remainingPct: q.remainingPct, cutoff: vscode.workspace.getConfiguration('francestudent').get('cutoffPercent') });
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
  return { dispose: () => httpServer.close() };
}
