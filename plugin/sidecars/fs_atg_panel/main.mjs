import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  ATG,
  ANTIGRAVITY_QUOTA_VISIBILITY,
  CONNECTOR_VERSION,
  MCP_TOOL_CATALOG,
  acquireGlobalSlot,
  apiCredentialStatus,
  compactChatContext,
  fetchAgentsAndModels,
  fetchChatContext,
  fetchQuotaSnapshot,
  estimateTokens,
  fsJson,
  groupModelsByTier,
  globalSlotStatus,
  loadState,
  normalizeProviderTokenUsage,
  parseTaskDirectives,
  pickModel,
  readLiveJobs,
  resolveApiKey,
  saveState,
  saveApiKey,
  removeApiKey,
  streamGenerationWithRefusalFallback,
} from '../../fs_core.mjs';
import { applyReview, undoReview } from '../../review_store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let state = loadState();
let quotaCache = null;
let modelCache = null;
const jobs = new Map();
const running = new Map();
const queue = [];

const PANEL_INSTRUCTIONS = `Réponds de façon concise.
- Le chat est persistant : ne répète ni conversation ni résumé déjà présent.
- Lis seulement ce qui est nécessaire et ne prétends pas modifier un workspace sans délégation.`;

const PANEL_PLAN_INSTRUCTIONS = `Réponds à la demande avec un plan concret, sans modifier quoi que ce soit.
- Indique les fichiers probablement concernés, les risques et les vérifications.
- Ne prétends pas avoir appliqué une modification et ne fournis pas de bloc fichier complet.`;

const PANEL_DRY_RUN_INSTRUCTIONS = `Prépare une proposition de modification sans rien écrire.
- Décris les changements, les fichiers probablement concernés et les vérifications.
- Ce panneau n’a pas de workspace attaché : indique explicitement qu’un diff appliquable nécessite un dry-run MCP avec workspaceRoot.
- Ne prétends pas avoir appliqué une modification.`;

const EXECUTION_MODES = new Set(['apply', 'plan', 'dry-run']);
const ROUTING_PROFILES = new Set(['eco', 'fast', 'quality', 'security', 'refactor']);

function profileState(st, profile) {
  const routingProfile = ROUTING_PROFILES.has(profile) ? profile
    : (ROUTING_PROFILES.has(st.routingProfile) ? st.routingProfile : 'eco');
  return { ...st, routingProfile };
}

function panelInstructions(executionMode) {
  if (executionMode === 'plan') return PANEL_PLAN_INSTRUCTIONS;
  if (executionMode === 'dry-run') return PANEL_DRY_RUN_INSTRUCTIONS;
  return PANEL_INSTRUCTIONS;
}

function normalizeDelegation(task, requestedMode, requestedProfile) {
  const rawTask = String(task ?? '').trim();
  const directives = parseTaskDirectives(rawTask);
  const executionMode = EXECUTION_MODES.has(requestedMode) ? requestedMode : directives.executionMode;
  const routingProfile = ROUTING_PROFILES.has(requestedProfile) ? requestedProfile
    : (ROUTING_PROFILES.has(directives.profile) ? directives.profile : undefined);
  return { task: directives.prompt, rawTask, executionMode, routingProfile };
}

async function preparePanelChat(st) {
  if (st.reuseChat === false) return undefined;
  const chatId = st.directChats?.panel;
  if (!chatId) return undefined;
  try {
    const context = await fetchChatContext(st, chatId);
    const threshold = Number(st.contextCompactPercent ?? 80);
    if (typeof context?.usagePercent === 'number' && context.usagePercent >= threshold) {
      await compactChatContext(st, chatId);
    }
    return chatId;
  } catch (e) {
    if (String(e?.message ?? e).includes('HTTP 404')) {
      delete st.directChats.panel;
      saveState(st);
      return undefined;
    }
    return chatId;
  }
}

function rememberPanelChat(chatId) {
  if (!chatId) return;
  const st = loadState();
  if (st.reuseChat === false) return;
  st.directChats = { ...(st.directChats || {}), panel: chatId };
  saveState(st);
}

async function panelSession(action = 'status') {
  state = loadState();
  const chatId = state.directChats?.panel;
  if (action === 'new') {
    if (chatId) {
      delete state.directChats.panel;
      saveState(state);
    }
    return { chatId: null, usagePercent: null, message: 'La prochaine demande ouvrira une nouvelle session.' };
  }
  if (!chatId) return { chatId: null, usagePercent: null, message: 'Aucune session active.' };
  if (action === 'compact') await compactChatContext(state, chatId);
  const context = await fetchChatContext(state, chatId).catch(() => ({}));
  return { chatId, usagePercent: context?.usagePercent ?? null, message: null };
}

async function diagnosticsSnapshot() {
  const st = loadState();
  const credential = await apiCredentialStatus(st);
  let quota = null;
  let api = { verified: false, checkedAt: null, error: null };
  let models = { available: false, source: credential.configured ? 'unverified' : 'not-authenticated', count: 0, checkedAt: null, error: null };
  if (credential.configured) {
    try {
      quota = await fetchQuotaSnapshot(st);
      api = { verified: true, checkedAt: Date.now(), error: null };
    } catch (error) {
      api = { verified: false, checkedAt: Date.now(), error: String(error?.message ?? error).slice(0, 220) };
    }
    try {
      const bundle = await fetchAgentsAndModels(st);
      models = {
        available: bundle.available === true,
        source: bundle.source ?? 'unknown',
        count: bundle.ids?.length ?? 0,
        checkedAt: Date.now(),
        error: null,
      };
    } catch (error) {
      models = { ...models, checkedAt: Date.now(), error: String(error?.message ?? error).slice(0, 220) };
    }
  }
  const session = await panelSession('status').catch(() => ({ chatId: null, usagePercent: null }));
  return {
    credential,
    api,
    models,
    quota: quota ? { remainingPct: quota.remainingPct ?? null, resetAt: quota.resetAt ?? null } : null,
    mcp: {
      name: 'fs-atg', version: CONNECTOR_VERSION, transport: 'stdio', registration: 'declared',
      toolCount: MCP_TOOL_CATALOG.length, tools: MCP_TOOL_CATALOG,
      activeJobs: jobs.size, queuedJobs: queue.length, slots: globalSlotStatus(st),
    },
    antigravityQuota: ANTIGRAVITY_QUOTA_VISIBILITY,
    session: { savedChatReference: Boolean(session.chatId), usagePercent: session.usagePercent ?? null },
  };
}

function reviewAction(jobId, action) {
  const st = loadState();
  const job = st.history?.find((entry) => entry.id === jobId || entry.jobId === jobId);
  if (!job?.review?.id) throw new Error('Aucune revue applicable pour ce job.');
  if (action === 'apply') {
    job.review = applyReview(job.review.id);
    job.status = 'done';
    job.written = job.review.files.map((file) => file.path);
    job.reviewUnavailable = null;
  } else if (action === 'undo') {
    job.review = undoReview(job.review.id);
    job.status = 'undone';
    job.written = [];
  } else {
    throw new Error('Action de revue invalide.');
  }
  saveState(st);
  return publicView(job);
}

async function fetchQuota(force = false) {
  state = loadState();
  const credential = await apiCredentialStatus(state);
  if (!credential.configured) return null;
  if (!force && quotaCache && Date.now() - quotaCache.at < 20_000) return quotaCache;
  quotaCache = await fetchQuotaSnapshot(state);
  return quotaCache;
}

async function fetchModels(force = false) {
  state = loadState();
  const credential = await apiCredentialStatus(state);
  if (!credential.configured) {
    return { ids: [], agentMap: new Map(), metaMap: new Map(), available: false, source: 'not-authenticated', at: Date.now() };
  }
  if (!force && modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache;
  const bundle = await fetchAgentsAndModels(state);
  modelCache = { ...bundle, at: Date.now() };
  return modelCache;
}

function reviewView(review) {
  if (!review) return null;
  const valid = Date.now() <= Number(review.expiresAt ?? 0);
  return {
    ...review,
    canApply: review.status === 'pending' && valid,
    canUndo: review.status === 'applied' && valid,
  };
}

function publicView(j) {
  const end = j.endedAt ?? Date.now();
  const tokenMeasurement = j.tokenMeasurement ?? {
    localPromptEstimateTokens: j.inputEstimateTokens ?? null,
    providerUsage: normalizeProviderTokenUsage(j.usage),
  };
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
    tokenUsage: {
      inputEstimateTokens: tokenMeasurement.localPromptEstimateTokens ?? j.inputEstimateTokens ?? null,
      provider: tokenMeasurement.providerUsage ?? null,
    },
    inputEstimateTokens: j.inputEstimateTokens,
    contextMode: j.contextMode,
    executionMode: j.executionMode ?? 'apply',
    routingProfile: j.routingProfile ?? null,
    review: reviewView(j.review),
    reviewUnavailable: j.reviewUnavailable ?? null,
    slot: j.slot,
    refusals: j.refusals ?? [],
    attemptedModels: j.attemptedModels ?? (j.model ? [j.model] : []),
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
  job.status = 'waiting';
  let thoughtBuf = '';
  const flushThought = () => {
    const t = thoughtBuf.trim();
    if (t) { job.thoughts.push(t); job.thoughts = job.thoughts.slice(-20); }
    thoughtBuf = '';
  };

  try {
    state = profileState(loadState(), job.routingProfile);
    const q = await fetchQuota();
    state = profileState(loadState(), job.routingProfile);
    if (q?.remainingPct !== null && q?.remainingPct < state.cutoffPercent) {
      throw new Error(`Coupe-circuit : il reste ${q.remainingPct.toFixed(0)} % (seuil ${state.cutoffPercent} %).`);
    }
    const { ids, agentMap } = await fetchModels();
    state = profileState(loadState(), job.routingProfile);
    const route = pickModel(job.rawTask ?? job.task, ids, state, job.explicitModel);
    job.model = route.model;
    job.routeReason = route.reason;
    job.routingProfile = route.profile === 'auto' ? null : route.profile;
    job.executionMode = job.executionMode ?? route.executionMode ?? 'apply';
    job.contextMode = 'minimal';
    job.inputEstimateTokens = estimateTokens(route.prompt);

    // Plans and previews are intentionally isolated from the persistent chat.
    const chatId = job.executionMode === 'apply' ? await preparePanelChat(state) : undefined;
    if (chatId) job.chatId = chatId;
    job.thoughts.push('En attente d’un créneau France Student partagé.');
    const lease = await acquireGlobalSlot(state, `panel-${job.id}`, ac.signal);
    job.slot = lease.index + 1;
    job.status = 'running';
    job.startedAt = Date.now();
    let liveText = '';
    let result;
    try {
      result = await streamGenerationWithRefusalFallback({
        state,
        model: route.model,
        availableModels: ids,
        agentMap,
        instructions: panelInstructions(job.executionMode),
        prompt: route.prompt,
        chatId,
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
        onRetry: ({ from, to, reason }) => {
          job.refusals = [...(job.refusals ?? []), { model: from, reason, retryModel: to }];
          job.model = to;
          job.routeReason = `${route.reason} · repli ${from} → ${to}`;
          job.thoughts.push(`Reprise avec ${to} après refus de ${from}.`);
          job.thoughts = job.thoughts.slice(-20);
        },
      });
    } finally {
      lease.release();
    }
    flushThought();
    job.chatId = result.chatId ?? job.chatId;
    if (job.executionMode === 'apply') rememberPanelChat(result.chatId);
    job.model = result.model ?? job.model;
    job.refusals = result.refusals ?? job.refusals ?? [];
    job.attemptedModels = result.attemptedModels ?? job.attemptedModels;
    job.tokenMeasurement = result.tokenMeasurement ?? {
      localPromptEstimateTokens: job.inputEstimateTokens,
      providerUsage: normalizeProviderTokenUsage(result.usage),
    };
    job.summary = result.text.slice(0, 2000);
    job.usage = result.usage;
    if (job.executionMode === 'dry-run') {
      job.reviewUnavailable = 'Le panneau n’a pas de workspace local : utilise /dry-run via MCP avec workspaceRoot pour obtenir un diff appliquable.';
    }
    quotaCache = null;
    void fetchQuota(true).catch(() => null);
    finishJob(job, 'done');
  } catch (e) {
    flushThought();
    if (ac.signal.aborted) finishJob(job, 'cancelled');
    else {
      job.refusals = e.refusals ?? job.refusals ?? [];
      job.attemptedModels = e.attemptedModels ?? job.attemptedModels;
      job.error = e.message;
      finishJob(job, 'error');
    }
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
  const credential = await apiCredentialStatus(state);
  if (credential.configured && (!quotaCache || Date.now() - quotaCache.at >= 20_000)) {
    await fetchQuota(true).catch(() => null);
  }
  const modelsBundle = await fetchModels().catch(() => ({ ids: [], metaMap: new Map(), available: false, source: 'unavailable' }));
  const { ids, metaMap } = modelsBundle;
  const displayIds = modelsBundle.available ? ids : [];
  const session = await panelSession('status').catch(() => ({ chatId: state.directChats?.panel ?? null, usagePercent: null }));
  const localActive = [...jobs.values()].map(publicView);
  const mcpActive = readLiveJobs().filter((m) => !jobs.has(m.jobId));
  return {
    hasKey: credential.configured === true,
    credential,
    quota: quotaCache,
    cutoff: state.cutoffPercent,
    mode: state.mode,
    routingProfile: ROUTING_PROFILES.has(state.routingProfile) ? state.routingProfile : 'eco',
    maxParallel: state.maxParallel,
    showReasoning: state.showReasoning,
    useClientTools: state.useClientTools !== false,
    reuseChat: state.reuseChat !== false,
    contextCompactPercent: state.contextCompactPercent ?? 80,
    contextMode: state.contextMode ?? 'minimal',
    session,
    slots: globalSlotStatus(state),
    allowedModels: state.allowedModels,
    blockedModels: state.blockedModels,
    tiers: state.tiers,
    tierModels: groupModelsByTier(displayIds, state, metaMap),
    models: displayIds,
    modelAvailability: { available: Boolean(modelsBundle.available), source: modelsBundle.source ?? 'unavailable' },
    mcp: {
      name: 'fs-atg', version: CONNECTOR_VERSION, transport: 'stdio', registration: 'declared',
      toolCount: MCP_TOOL_CATALOG.length, tools: MCP_TOOL_CATALOG,
    },
    antigravityQuota: ANTIGRAVITY_QUOTA_VISIBILITY,
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
  state = loadState();
  const credential = await apiCredentialStatus(state);
  if (!credential.configured) {
    return { quota: null, models: [], credential, modelAvailability: { available: false, source: 'not-authenticated' } };
  }
  const quota = await fetchQuota(true);
  const modelsBundle = await fetchModels(true).catch(() => ({ ids: [], available: false, source: 'unavailable' }));
  return { quota, models: modelsBundle.available ? modelsBundle.ids : [], credential, modelAvailability: { available: Boolean(modelsBundle.available), source: modelsBundle.source ?? 'unavailable' } };
});

app.api('/api/key', async (data) => {
  state = loadState();
  if (data.action === 'reveal') {
    const apiKey = await resolveApiKey(state);
    const credential = await apiCredentialStatus(loadState());
    return { ok: true, hasKey: Boolean(apiKey), apiKey, credential };
  }
  const apiKey = String(data.apiKey ?? '').trim();
  if (data.action === 'clear') await removeApiKey(state);
  else if (apiKey) await saveApiKey(state, apiKey);
  quotaCache = null;
  modelCache = null;
  const credential = await apiCredentialStatus(loadState());
  if (!credential.configured) return { ok: true, hasKey: false, credential };
  const quota = await fetchQuota(true);
  const modelsBundle = await fetchModels(true).catch(() => ({ ids: [], available: false, source: 'unavailable' }));
  return { ok: true, hasKey: true, credential, quota, models: modelsBundle.available ? modelsBundle.ids : [], modelAvailability: { available: Boolean(modelsBundle.available), source: modelsBundle.source ?? 'unavailable' } };
});

app.api('/api/settings', (data) => {
  state = loadState();
  if (data.mode === 'eco' || data.mode === 'fast') state.mode = data.mode;
  if (ROUTING_PROFILES.has(data.routingProfile)) state.routingProfile = data.routingProfile;
  if (typeof data.cutoffPercent === 'number') state.cutoffPercent = Math.max(0, Math.min(90, data.cutoffPercent));
  if (typeof data.maxParallel === 'number') state.maxParallel = Math.max(1, Math.min(6, data.maxParallel));
  if (typeof data.showReasoning === 'boolean') state.showReasoning = data.showReasoning;
  if (typeof data.useClientTools === 'boolean') state.useClientTools = data.useClientTools;
  if (typeof data.reuseChat === 'boolean') state.reuseChat = data.reuseChat;
  if (typeof data.contextCompactPercent === 'number') state.contextCompactPercent = Math.max(50, Math.min(95, data.contextCompactPercent));
  if (['minimal', 'targeted', 'smart'].includes(data.contextMode)) state.contextMode = data.contextMode;
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

app.api('/api/session', async (data) => {
  const action = ['status', 'compact', 'new'].includes(data.action) ? data.action : 'status';
  return await panelSession(action);
});

app.api('/api/diagnostics', async () => await diagnosticsSnapshot());

app.api('/api/review', (data) => {
  if (!['apply', 'undo'].includes(data.action)) throw new Error('Action de revue invalide.');
  const action = data.action;
  return { ok: true, job: reviewAction(String(data.jobId ?? ''), action) };
});

app.api('/api/delegate', (data) => {
  const delegation = normalizeDelegation(data.task, data.executionMode, data.routingProfile);
  if (!delegation.task) throw new Error('Tâche vide après les commandes locales.');
  const firstLine = delegation.task.split('\n')[0];
  const job = {
    id: randomUUID().slice(0, 8),
    title: `${ATG} ${firstLine.slice(0, 70)}${firstLine.length > 70 ? '…' : ''}`,
    task: delegation.task,
    rawTask: delegation.rawTask,
    explicitModel: data.model || undefined,
    executionMode: delegation.executionMode,
    routingProfile: delegation.routingProfile,
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
