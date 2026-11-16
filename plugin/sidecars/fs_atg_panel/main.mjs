import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  ATG,
  defaultModelsBundle,
  fetchAgentsAndModels,
  fetchQuotaSnapshot,
  fsJson,
  groupModelsByTier,
  loadState,
  pickModel,
  readLiveJobs,
  saveState,
  streamGeneration,
} from '../../fs_core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let state = loadState();
let quotaCache = null;
let modelCache = null;
const jobs = new Map();
const running = new Map();
const queue = [];

async function fetchQuota(force = false) {
  state = loadState();
  if (!state.apiKey) return null;
  if (!force && quotaCache && Date.now() - quotaCache.at < 20_000) return quotaCache;
  quotaCache = await fetchQuotaSnapshot(state);
  return quotaCache;
}

async function fetchModels(force = false) {
  state = loadState();
  if (!state.apiKey) return defaultModelsBundle();
  if (!force && modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache;
  const { ids, agentMap, metaMap } = await fetchAgentsAndModels(state);
  modelCache = { ids, agentMap, metaMap, at: Date.now() };
  return modelCache;
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
  state = loadState();
  state.history = [{ ...job, thoughts: job.thoughts.slice(-5) }, ...(state.history || [])].slice(0, 30);
  saveState(state);
  pump();
}

async function runJob(job) {
  const ac = new AbortController();
  running.set(job.id, ac);
  job.status = 'running';
  job.startedAt = Date.now();
  let thoughtBuf = '';
  const flushThought = () => {
    const t = thoughtBuf.trim();
    if (t) { job.thoughts.push(t); job.thoughts = job.thoughts.slice(-20); }
    thoughtBuf = '';
  };

  try {
    state = loadState();
    const q = await fetchQuota();
    if (q?.remainingPct !== null && q?.remainingPct < state.cutoffPercent) {
      throw new Error(`Coupe-circuit : il reste ${q.remainingPct.toFixed(0)} % (seuil ${state.cutoffPercent} %).`);
    }
    const { ids, agentMap } = await fetchModels();
    const route = pickModel(job.task, ids, state, job.explicitModel);
    job.model = route.model;
    job.routeReason = route.reason;

    let liveText = '';
    const result = await streamGeneration({
      state,
      model: route.model,
      agentMap,
      instructions: `Tu es un agent France Student ${ATG}. Réponds de manière concise et structurée.`,
      prompt: route.prompt,
      signal: ac.signal,
      onChatId: (cid) => { job.chatId = cid; },
      onText: (d) => {
        job.receivedChars += d.length;
        liveText += d;
        job.summary = liveText.slice(-300);
      },
      onReasoning: (d) => {
        thoughtBuf += d;
        if (thoughtBuf.includes('\n') || thoughtBuf.length > 240) flushThought();
      },
    });
    flushThought();
    job.summary = result.text.slice(0, 2000);
    job.usage = result.usage;
    quotaCache = null;
    void fetchQuota(true).catch(() => null);
    finishJob(job, 'done');
  } catch (e) {
    flushThought();
    if (ac.signal.aborted) finishJob(job, 'cancelled');
    else { job.error = e.message; finishJob(job, 'error'); }
  }
}

function pump() {
  state = loadState();
  const limit = state.mode === 'eco' ? 1 : (state.maxParallel ?? 3);
  while (running.size < limit && queue.length) {
    const job = queue.shift();
    void runJob(job);
  }
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
app.page('/favicon.ico', () => new Response(readFileSync(join(__dirname, 'favicon.ico')), { contentType: 'image/x-icon' }));

app.api('/api/state', async () => {
  state = loadState();
  if (state.apiKey && (!quotaCache || Date.now() - quotaCache.at >= 20_000)) {
    await fetchQuota(true).catch(() => null);
  }
  const { ids, metaMap } = await fetchModels().catch(() => defaultModelsBundle());
  const localActive = [...jobs.values()].map(publicView);
  const mcpActive = readLiveJobs().filter((m) => !jobs.has(m.jobId));
  return {
    hasKey: !!state.apiKey,
    quota: quotaCache,
    cutoff: state.cutoffPercent,
    mode: state.mode,
    maxParallel: state.maxParallel,
    baseUrl: state.baseUrl,
    showReasoning: state.showReasoning,
    useClientTools: state.useClientTools !== false,
    allowedModels: state.allowedModels,
    blockedModels: state.blockedModels,
    tiers: state.tiers,
    tierModels: groupModelsByTier(ids, state, metaMap),
    models: ids,
    active: [...localActive, ...mcpActive],
    history: (state.history || []).map((h) => (h.jobId ? h : publicView(h))),
  };
}, 'GET');

app.api('/api/clear-history', () => {
  state = loadState();
  state.history = [];
  saveState(state);
  return { ok: true };
});

app.api('/api/refresh', async () => {
  const quota = await fetchQuota(true);
  const { ids } = await fetchModels(true).catch(() => ({ ids: [] }));
  return { quota, models: ids };
});

app.api('/api/key', async (data) => {
  state = loadState();
  state.apiKey = String(data.apiKey ?? '').trim();
  quotaCache = null;
  modelCache = null;
  saveState(state);
  if (!state.apiKey) return { ok: true, hasKey: false };
  const quota = await fetchQuota(true);
  const { ids } = await fetchModels(true).catch(() => ({ ids: [] }));
  return { ok: true, hasKey: true, quota, models: ids };
});

app.api('/api/settings', (data) => {
  state = loadState();
  if (data.mode === 'eco' || data.mode === 'fast') state.mode = data.mode;
  if (typeof data.cutoffPercent === 'number') state.cutoffPercent = Math.max(0, Math.min(90, data.cutoffPercent));
  if (typeof data.maxParallel === 'number') state.maxParallel = Math.max(1, Math.min(6, data.maxParallel));
  if (typeof data.showReasoning === 'boolean') state.showReasoning = data.showReasoning;
  if (typeof data.useClientTools === 'boolean') state.useClientTools = data.useClientTools;
  if (typeof data.baseUrl === 'string' && data.baseUrl.trim()) state.baseUrl = data.baseUrl.trim();
  if (Array.isArray(data.allowedModels)) state.allowedModels = data.allowedModels.map((s) => String(s).trim()).filter(Boolean);
  if (Array.isArray(data.blockedModels)) state.blockedModels = data.blockedModels.map((s) => String(s).trim()).filter(Boolean);
  if (data.tiers && typeof data.tiers === 'object') {
    const cleanArr = (a) => (Array.isArray(a) ? a.map((s) => String(s).trim()).filter(Boolean) : []);
    state.tiers = {
      light: cleanArr(data.tiers.light),
      medium: cleanArr(data.tiers.medium),
      heavy: cleanArr(data.tiers.heavy),
    };
  }
  saveState(state);
  pump();
  return { ok: true };
});

app.api('/api/delegate', (data) => {
  const task = String(data.task ?? '').trim();
  if (!task) throw new Error('Tâche vide.');
  const firstLine = task.split('\n')[0].replace(/^\s*\[[^\]]+\]\s*/, '');
  const job = {
    id: randomUUID().slice(0, 8),
    title: `${ATG} ${firstLine.slice(0, 70)}${firstLine.length > 70 ? '…' : ''}`,
    task,
    explicitModel: data.model || undefined,
    status: 'queued',
    createdAt: Date.now(),
    receivedChars: 0,
    thoughts: [],
    summary: '',
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return { jobId: job.id };
});

app.api('/api/cancel', (data) => {
  const job = jobs.get(data.id);
  if (!job) return { ok: false };
  if (job.status === 'queued') {
    const idx = queue.indexOf(job);
    if (idx >= 0) queue.splice(idx, 1);
    finishJob(job, 'cancelled');
  } else {
    if (job.chatId) {
      state = loadState();
      void fsJson(state, 'POST', `/chats/${job.chatId}/stream/cancel`).catch(() => {});
    }
    running.get(data.id)?.abort();
  }
  return { ok: true };
});

app.run();
