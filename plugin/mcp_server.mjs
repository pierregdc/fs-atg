import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ATG,
  fetchAgentsAndModels,
  fetchQuotaSnapshot,
  fsJson,
  loadState,
  parseFileBlocks,
  pickModel,
  resolveSafe,
  saveState,
  streamGeneration,
  stripFileBlocks,
  writeFileBlocks,
  writeLiveJobs,
} from './fs_core.mjs';

const INSTRUCTIONS = `Tu es un agent de code délégué par Antigravity ${ATG}.
- Commence par un résumé court (5 lignes max) de ce que tu as fait.
- Pour chaque fichier créé ou modifié, donne son contenu COMPLET dans ce format exact :
<<<FILE chemin/relatif/au/workspace
contenu
>>>END
- Aucun autre bloc de code. Aucun chemin hors du workspace.`;

const FINAL = new Set(['done', 'error', 'cancelled']);
const jobs = new Map();
const running = new Map();
const queue = [];
const listeners = new Set();

function notify() {
  const live = [...jobs.values()].map(publicView);
  writeLiveJobs(live);
  for (const fn of listeners) fn();
}

function publicView(j) {
  const end = j.endedAt ?? Date.now();
  return {
    jobId: j.id,
    title: j.title,
    status: j.status,
    model: j.model,
    route: j.routeReason,
    elapsedSec: j.startedAt ? Math.round((end - j.startedAt) / 1000) : 0,
    receivedChars: j.receivedChars,
    summary: j.summary,
    filesWritten: j.written ?? [],
    lastThoughts: (j.thoughts || []).slice(-3),
    error: j.error,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    usage: j.usage,
  };
}

function finishJob(job, status) {
  job.status = status;
  job.endedAt = Date.now();
  running.delete(job.id);
  jobs.delete(job.id);
  const st = loadState();
  st.history = [{ ...job, thoughts: job.thoughts.slice(-5) }, ...(st.history || [])].slice(0, 30);
  saveState(st);
  notify();
  pump();
}

async function runJob(job) {
  const ac = new AbortController();
  running.set(job.id, ac);
  job.status = 'running';
  job.startedAt = Date.now();
  notify();

  let thoughtBuf = '';
  const flushThought = () => {
    const t = thoughtBuf.trim();
    if (t) { job.thoughts.push(t); job.thoughts = job.thoughts.slice(-20); }
    thoughtBuf = '';
  };

  try {
    const st = loadState();
    const q = await fetchQuotaSnapshot(st);
    if (q?.remainingPct !== null && q.remainingPct < (st.cutoffPercent ?? 15)) {
      throw new Error(`Coupe-circuit : il reste ${q.remainingPct.toFixed(0)} % (seuil ${st.cutoffPercent} %).`);
    }

    const { ids, agentMap } = await fetchAgentsAndModels(st);
    const route = pickModel(job.task, ids, st, job.explicitModel);
    job.model = route.model;
    job.routeReason = route.reason;
    notify();

    let prompt = route.prompt;
    if (job.parentId) {
      const parent = st.history?.find((h) => h.id === job.parentId);
      if (parent) {
        prompt = `Contexte (tâche précédente « ${parent.title} ») :\n${parent.summary}\n` +
          `Fichiers touchés : ${(parent.written || []).join(', ') || 'aucun'}\n\nNouvelle demande : ${prompt}`;
      }
    }

    if (job.files?.length && job.workspaceRoot) {
      const fileChunks = [];
      for (const rel of job.files) {
        const { abs } = resolveSafe(job.workspaceRoot, rel);
        const content = readFileSync(abs, 'utf-8');
        fileChunks.push(`<<<FILE ${rel}\n${content}\n>>>END`);
      }
      prompt += '\n\nFichiers joints :\n' + fileChunks.join('\n\n');
    }

    let liveText = '';
    let lastPush = 0;
    const result = await streamGeneration({
      state: st,
      model: route.model,
      agentMap,
      instructions: INSTRUCTIONS,
      prompt,
      workspaceRoot: job.workspaceRoot,
      clientTools: job.workspaceRoot ? ['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file'] : undefined,
      signal: ac.signal,
      onChatId: (cid) => { job.chatId = cid; },
      onText: (d) => {
        job.receivedChars += d.length;
        liveText += d;
        job.summary = liveText.slice(-300);
        if (Date.now() - lastPush > 600) { lastPush = Date.now(); notify(); }
      },
      onToolCall: (call) => {
        job.thoughts.push(`Outil : ${call.name}(${JSON.stringify(call.arguments ?? {}).slice(0, 100)})`);
        job.thoughts = job.thoughts.slice(-20);
        notify();
      },
      onReasoning: (d) => {
        thoughtBuf += d;
        if (thoughtBuf.includes('\n') || thoughtBuf.length > 240) { flushThought(); notify(); }
      },
    });
    flushThought();

    const blocks = parseFileBlocks(result.text);
    const blockWritten = job.workspaceRoot ? writeFileBlocks(job.workspaceRoot, blocks) : [];
    job.written = [...new Set([...(result.written ?? []), ...blockWritten])];
    job.summary = stripFileBlocks(result.text).slice(0, 2000);
    job.usage = result.usage;
    finishJob(job, 'done');
  } catch (e) {
    flushThought();
    if (ac.signal.aborted) finishJob(job, 'cancelled');
    else { job.error = e.message; finishJob(job, 'error'); }
  }
}

function pump() {
  const st = loadState();
  const limit = st.mode === 'eco' ? 1 : (st.maxParallel ?? 3);
  while (running.size < limit && queue.length) {
    const job = queue.shift();
    void runJob(job);
  }
}

function waitFor(id, ms) {
  const find = () => jobs.get(id) ?? loadState().history?.find((h) => h.id === id);
  const cur = find();
  if (!cur || FINAL.has(cur.status) || ms <= 0) return Promise.resolve(cur);
  return new Promise((resolve) => {
    const done = () => {
      const j = find();
      if (j && FINAL.has(j.status)) {
        clearTimeout(t);
        listeners.delete(done);
        resolve(j);
      }
    };
    listeners.add(done);
    const t = setTimeout(() => { listeners.delete(done); resolve(find()); }, ms);
  });
}

const asText = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const server = new McpServer({ name: 'fs-atg', version: '0.1.0' });

server.registerTool('fs_delegate', {
  title: 'Déléguer à France Student [ATG]',
  description: 'Délègue une tâche de code à un agent France Student. Si workspaceRoot est fourni, les fichiers <<<FILE ...>>>END sont écrits directement sur disque : ne recopie pas le code. Asynchrone : renvoie un jobId, puis appelle fs_job_status.',
  inputSchema: {
    task: z.string().min(3).describe('Consigne précise. Préfixe [haiku]/[sonnet]/[fable] pour forcer un modèle.'),
    workspaceRoot: z.string().optional().describe('Chemin absolu du workspace où écrire les fichiers générés.'),
    files: z.array(z.string()).optional().describe('Chemins relatifs au workspace à joindre.'),
    model: z.string().optional(),
    priority: z.number().int().min(0).max(9).optional(),
    parentJobId: z.string().optional().describe("Suite d'un job : seul son résumé est réutilisé."),
  },
}, async (a) => {
  const firstLine = a.task.split('\n')[0].replace(/^\s*(?:\[[^\]]+\]|\/[a-zA-ZÀ-ÿ0-9_-]+)\s*/, '');
  const job = {
    id: randomUUID().slice(0, 8),
    title: `${ATG} ${firstLine.slice(0, 70)}${firstLine.length > 70 ? '…' : ''}`,
    task: a.task,
    workspaceRoot: a.workspaceRoot,
    files: a.files ?? [],
    explicitModel: a.model,
    parentId: a.parentJobId,
    priority: a.priority ?? 5,
    status: 'queued',
    createdAt: Date.now(),
    receivedChars: 0,
    thoughts: [],
    summary: '',
    written: [],
  };
  jobs.set(job.id, job);
  queue.push(job);
  queue.sort((x, y) => y.priority - x.priority || x.createdAt - y.createdAt);
  notify();
  pump();
  return asText({ jobId: job.id, status: job.status, next: 'Appelle fs_job_status avec waitSeconds=45.' });
});

server.registerTool('fs_job_status', {
  title: "État d'un job [ATG]",
  description: "Attend jusqu'à waitSeconds que le job finisse, puis renvoie son état, son résumé et les fichiers écrits.",
  inputSchema: { jobId: z.string(), waitSeconds: z.number().min(0).max(45).optional() },
}, async ({ jobId, waitSeconds }) => {
  const job = await waitFor(jobId, (waitSeconds ?? 30) * 1000);
  return asText(job ? publicView(job) : { error: 'jobId inconnu' });
});

server.registerTool('fs_quota', {
  title: 'Quota France Student',
  description: 'Pourcentage de quota restant et seuil du coupe-circuit.',
  inputSchema: {},
}, async () => {
  const st = loadState();
  const q = await fetchQuotaSnapshot(st);
  return asText({ remainingPct: q.remainingPct, cutoff: st.cutoffPercent, resetAt: q.resetAt });
});

server.registerTool('fs_cancel', {
  title: 'Annuler un job [ATG]',
  description: 'Annule un job en file ou en cours.',
  inputSchema: { jobId: z.string() },
}, async ({ jobId }) => {
  const job = jobs.get(jobId);
  if (job) {
    if (job.status === 'queued') {
      const idx = queue.indexOf(job);
      if (idx >= 0) queue.splice(idx, 1);
      finishJob(job, 'cancelled');
    } else {
      if (job.chatId) {
        const st = loadState();
        void fsJson(st, 'POST', `/chats/${job.chatId}/stream/cancel`).catch(() => {});
      }
      running.get(jobId)?.abort();
    }
  }
  return asText({ ok: true });
});

const transport = new StdioServerTransport();
await server.connect(transport);
