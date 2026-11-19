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
  enrichModelsCatalog,
  estimateAntigravityJobSavings,
  estimateTokens,
  fetchAgentsAndModels,
  fetchChatContext,
  fetchModelCatalog,
  fetchQuotaSnapshot,
  fsJson,
  globalSlotStatus,
  groupModelsByTier,
  loadState,
  normalizeProviderTokenUsage,
  parseTaskDirectives,
  pickModel,
  readLiveJobs,
  recordAntigravitySavings,
  removeApiKey,
  resolveApiKey,
  saveApiKey,
  saveState,
  streamGenerationWithRefusalFallback,
  syncAgentsRule,
} from '../../fs_core.mjs';
import { clearLogs, countRecentErrors, logEvent, readLogs } from '../../logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let state = loadState();
let quotaCache = null;
let modelCache = null;
let catalogCache = null;
const jobs = new Map();
const running = new Map();
const queue = [];

const PANEL_INSTRUCTIONS = `Réponds clairement et directement en français (ou dans la langue de la demande).
Si du code est demandé, fournis un code complet, propre et directement utilisable dans des blocs Markdown standards, sans blabla inutile.`;

const PANEL_PLAN_INSTRUCTIONS = `Propose un plan clair, concret et concis : étapes, fichiers concernés et points d'attention, sans rédiger le code complet.`;

const EXECUTION_MODES = new Set(['generate', 'apply', 'plan', 'dry-run']);
const ROUTING_PROFILES = new Set(['eco', 'fast', 'quality', 'security', 'refactor']);

function profileState(st, profile) {
  const routingProfile = ROUTING_PROFILES.has(profile) ? profile
    : (ROUTING_PROFILES.has(st.routingProfile) ? st.routingProfile : 'quality');
  return { ...st, routingProfile };
}

function panelInstructions(executionMode) {
  if (executionMode === 'plan') return PANEL_PLAN_INSTRUCTIONS;
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
    logEvent('info', 'panel', 'session.new', 'Session du panneau réinitialisée.');
    return { chatId: null, usagePercent: null, message: 'La prochaine demande ouvrira une nouvelle session.' };
  }
  if (!chatId) return { chatId: null, usagePercent: null, message: 'Aucune session active.' };
  if (action === 'compact') {
    await compactChatContext(state, chatId);
    logEvent('info', 'panel', 'session.compact', `Contexte panneau compacté (${chatId}).`, { chatId });
  }
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
      logEvent('error', 'panel', 'diagnostics.api_error', api.error);
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
      logEvent('error', 'panel', 'diagnostics.models_error', models.error);
    }
  }
  const session = await panelSession('status').catch(() => ({ chatId: null, usagePercent: null }));
  return {
    credential,
    api,
    models,
    quota: quota ? { remainingPct: quota.remainingPct ?? null, resetAt: quota.resetAt ?? null } : null,
    mcp: {
      name: 'fs-atg',
      version: CONNECTOR_VERSION,
      transport: 'stdio',
      registration: 'declared',
      readOnlyWorkspace: true,
      toolCount: MCP_TOOL_CATALOG.length,
      tools: MCP_TOOL_CATALOG,
      activeJobs: jobs.size,
      queuedJobs: queue.length,
      slots: globalSlotStatus(st),
    },
    antigravityQuota: ANTIGRAVITY_QUOTA_VISIBILITY,
    autoDelegate: st.autoDelegate !== false,
    recentErrors24h: countRecentErrors(),
    session: { savedChatReference: Boolean(session.chatId), usagePercent: session.usagePercent ?? null },
  };
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

async function fetchRawCatalog(force = false) {
  state = loadState();
  const credential = await apiCredentialStatus(state);
  if (!credential.configured) return { models: [], at: Date.now() };
  if (!force && catalogCache && Date.now() - catalogCache.at < 10 * 60_000) return catalogCache;
  const res = await fetchModelCatalog(state).catch(() => ({ models: [] }));
  catalogCache = { models: res?.models || [], at: Date.now() };
  return catalogCache;
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
    response: j.response ?? j.summary ?? '',
    summary: j.summary,
    filesWritten: [],
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
    executionMode: j.executionMode ?? 'generate',
    routingProfile: j.routingProfile ?? null,
    slot: j.slot,
    refusals: j.refusals ?? [],
    attemptedModels: j.attemptedModels ?? (j.model ? [j.model] : []),
    antigravitySavings: j.antigravitySavings ?? null,
  };
}

function finishJob(job, status) {
  job.status = status;
  job.endedAt = Date.now();
  running.delete(job.id);
  jobs.delete(job.id);
  state = loadState();
  if (status === 'done') {
    job.antigravitySavings = estimateAntigravityJobSavings(job, { waitedInline: false, partsCount: 1 });
    recordAntigravitySavings(state, job.antigravitySavings);
    logEvent('info', 'panel', 'panel.job.done', `Job panneau ${job.id} terminé (${job.model}, ${job.response?.length ?? 0} car.).`, {
      jobId: job.id,
      model: job.model,
      chars: job.response?.length ?? 0,
    });
  } else if (status === 'error') {
    logEvent('error', 'panel', 'panel.job.error', `Job panneau ${job.id} en échec : ${job.error || 'inconnu'}`, {
      jobId: job.id,
      model: job.model,
      attemptedModels: job.attemptedModels ?? [],
      refusals: job.refusals ?? [],
    });
  } else if (status === 'cancelled') {
    logEvent('warn', 'panel', 'panel.job.cancelled', `Job panneau ${job.id} annulé.`, { jobId: job.id });
  }
  const stored = {
    ...job,
    response: String(job.response ?? '').slice(0, 30_000),
    summary: String(job.summary ?? '').slice(0, 400),
    thoughts: (job.thoughts || []).slice(-5),
  };
  state.history = [stored, ...(state.history || [])].slice(0, 20);
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
    job.executionMode = job.executionMode ?? route.executionMode ?? 'generate';
    job.contextMode = 'minimal';
    job.inputEstimateTokens = estimateTokens(route.prompt);

    logEvent('info', 'panel', 'panel.job.start', `Démarrage job panneau ${job.id} (${route.model}).`, { jobId: job.id, model: route.model });

    const usePersistent = job.executionMode !== 'plan' && job.executionMode !== 'dry-run';
    const chatId = usePersistent ? await preparePanelChat(state) : undefined;
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
        onRetry: ({ from, to, reason, attempt }) => {
          job.refusals = [...(job.refusals ?? []), { model: from, reason, retryModel: to }];
          job.model = to;
          job.routeReason = `${route.reason} · repli ${from} → ${to}`;
          job.thoughts.push(`Repli (${attempt}/3) : ${from} → ${to}.`);
          job.thoughts = job.thoughts.slice(-20);
        },
      });
    } finally {
      lease.release();
    }
    flushThought();
    job.chatId = result.chatId ?? job.chatId;
    if (usePersistent && result.chatId) rememberPanelChat(result.chatId);
    job.model = result.model ?? job.model;
    job.refusals = result.refusals ?? job.refusals ?? [];
    job.attemptedModels = result.attemptedModels ?? job.attemptedModels;
    job.tokenMeasurement = result.tokenMeasurement ?? {
      localPromptEstimateTokens: job.inputEstimateTokens,
      providerUsage: normalizeProviderTokenUsage(result.usage),
    };
    job.response = String(result.text ?? '').trim().slice(0, 30_000);
    job.summary = job.response.slice(0, 400);
    job.usage = result.usage;
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
  const [modelsBundle, rawCatalog] = await Promise.all([
    fetchModels().catch(() => ({ ids: [], metaMap: new Map(), available: false, source: 'unavailable' })),
    fetchRawCatalog().catch(() => ({ models: [] })),
  ]);
  state = loadState();
  const { ids, metaMap } = modelsBundle;
  const displayIds = modelsBundle.available ? ids : [];
  const modelCatalog = displayIds.length ? enrichModelsCatalog(displayIds, metaMap, state, rawCatalog.models) : [];
  const session = await panelSession('status').catch(() => ({ chatId: state.directChats?.panel ?? null, usagePercent: null }));
  const localActive = [...jobs.values()].map(publicView);
  const mcpActive = readLiveJobs().filter((m) => !jobs.has(m.jobId));
  return {
    hasKey: credential.configured === true,
    credential,
    quota: quotaCache,
    cutoff: state.cutoffPercent,
    mode: state.mode,
    routingProfile: ROUTING_PROFILES.has(state.routingProfile) ? state.routingProfile : 'quality',
    autoDelegate: state.autoDelegate !== false,
    maxParallel: state.maxParallel,
    showReasoning: state.showReasoning,
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
    modelCatalog,
    modelAvailability: { available: Boolean(modelsBundle.available), source: modelsBundle.source ?? 'unavailable' },
    mcp: {
      name: 'fs-atg',
      version: CONNECTOR_VERSION,
      transport: 'stdio',
      registration: 'declared',
      readOnlyWorkspace: true,
      toolCount: MCP_TOOL_CATALOG.length,
      tools: MCP_TOOL_CATALOG,
    },
    antigravityQuota: ANTIGRAVITY_QUOTA_VISIBILITY,
    antigravitySavings: state.antigravitySavings ?? { jobsOffloaded: 0, turnsSavedEst: 0, inputTokensSavedEst: 0, outputTokensSavedEst: 0, totalTokensSavedEst: 0 },
    recentErrors: countRecentErrors(),
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
    return { quota: null, models: [], modelCatalog: [], credential, modelAvailability: { available: false, source: 'not-authenticated' } };
  }
  const quota = await fetchQuota(true);
  const [modelsBundle, rawCatalog] = await Promise.all([
    fetchModels(true).catch(() => ({ ids: [], metaMap: new Map(), available: false, source: 'unavailable' })),
    fetchRawCatalog(true).catch(() => ({ models: [] })),
  ]);
  state = loadState();
  const displayIds = modelsBundle.available ? modelsBundle.ids : [];
  const modelCatalog = displayIds.length ? enrichModelsCatalog(displayIds, modelsBundle.metaMap, state, rawCatalog.models) : [];
  return {
    quota,
    models: displayIds,
    modelCatalog,
    credential,
    modelAvailability: { available: Boolean(modelsBundle.available), source: modelsBundle.source ?? 'unavailable' },
  };
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
  catalogCache = null;
  const credential = await apiCredentialStatus(loadState());
  if (!credential.configured) return { ok: true, hasKey: false, credential };
  const quota = await fetchQuota(true);
  const [modelsBundle, rawCatalog] = await Promise.all([
    fetchModels(true).catch(() => ({ ids: [], metaMap: new Map(), available: false, source: 'unavailable' })),
    fetchRawCatalog(true).catch(() => ({ models: [] })),
  ]);
  const displayIds = modelsBundle.available ? modelsBundle.ids : [];
  const modelCatalog = displayIds.length ? enrichModelsCatalog(displayIds, modelsBundle.metaMap, loadState(), rawCatalog.models) : [];
  return {
    ok: true,
    hasKey: true,
    credential,
    quota,
    models: displayIds,
    modelCatalog,
    modelAvailability: { available: Boolean(modelsBundle.available), source: modelsBundle.source ?? 'unavailable' },
  };
});

app.api('/api/settings', (data) => {
  state = loadState();
  if (data.mode === 'eco' || data.mode === 'fast') state.mode = data.mode;
  if (ROUTING_PROFILES.has(data.routingProfile)) state.routingProfile = data.routingProfile;
  if (typeof data.autoDelegate === 'boolean') {
    state.autoDelegate = data.autoDelegate;
    syncAgentsRule(state.autoDelegate);
    logEvent('info', 'panel', 'settings.autoDelegate', `Activation Antigravity réglée sur ${state.autoDelegate ? 'Automatique' : 'Manuel'}.`, { autoDelegate: state.autoDelegate });
  }
  if (typeof data.cutoffPercent === 'number') state.cutoffPercent = Math.max(0, Math.min(90, data.cutoffPercent));
  if (typeof data.maxParallel === 'number') state.maxParallel = Math.max(1, Math.min(6, data.maxParallel));
  if (typeof data.showReasoning === 'boolean') state.showReasoning = data.showReasoning;
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
  return { ok: true, autoDelegate: state.autoDelegate !== false };
});

app.api('/api/session', async (data) => {
  const action = ['status', 'compact', 'new'].includes(data.action) ? data.action : 'status';
  return await panelSession(action);
});

app.api('/api/diagnostics', async () => await diagnosticsSnapshot());

app.api('/api/logs', (data) => ({
  entries: readLogs({
    limit: Number(data?.limit) || 80,
    level: data?.level || 'all',
    jobId: data?.jobId || '',
  }),
  recentErrors: countRecentErrors(),
}));

app.api('/api/logs/clear', () => {
  clearLogs();
  return { ok: true, entries: [], recentErrors: 0 };
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
    response: '',
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
