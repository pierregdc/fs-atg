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
  MODEL_POLICIES,
  REASONING_EFFORTS,
  TRIGGER_MODES,
  acquireGlobalSlot,
  apiCredentialStatus,
  buildReasoningDirective,
  clearGlobalCooldown,
  compactChatContext,
  controlDeskDock,
  enrichModelsCatalog,
  estimateAntigravityJobSavings,
  estimateTokens,
  fetchAgentsAndModels,
  fetchChatContext,
  fetchModelCatalog,
  fetchQuotaSnapshot,
  fetchUserPersonalization,
  fsJson,
  getGlobalCooldown,
  getModelCooldown,
  getModelTelemetry,
  globalSlotStatus,
  groupModelsByTier,
  loadModelPoliciesFile,
  loadState,
  normalizeProviderTokenUsage,
  normalizeReasoningEffort,
  normalizeTriggerMode,
  parseTaskDirectives,
  pickModel,
  readLiveJobs,
  recordAntigravitySavings,
  removeApiKey,
  resolveApiKey,
  saveApiKey,
  saveModelPoliciesFile,
  resolveAuthToken,
  saveState,
  streamGenerationWithRefusalFallback,
  syncAgentsRule,
  updateUserPersonalization,
  webAccessExpiresInMs,
} from '../../fs_core.mjs';
import { clearLogs, countRecentErrors, logEvent, readLogs } from '../../logger.mjs';
import {
  cancelBrowserLogin,
  getBrowserLoginStatus,
  startBrowserLogin,
} from '../../browser_auth.mjs';
import {
  addProjectNote,
  buildTurn1Annex,
  clearProjectMemory,
  getProjectMemory,
  observePromptSignals,
  removeProjectNote,
  setPreprompt,
} from '../../memory_store.mjs';
import {
  PERMISSION_MODES,
  createWorkspaceToolRunner,
  getUndoDiff,
  listUndoEntries,
  toolsForPermissionMode,
  undoLastChange,
} from '../../tools_engine.mjs';
import { executeComputerAction } from '../../computer_use.mjs';
import { executeBrowserAction, getBrowserSessionStatus } from '../../browser_use.mjs';
import { executeSystemAction } from '../../system_tools.mjs';
import { MCP_HUB_CATEGORIES, MCP_HUB_CATALOG, allHubConnectors, executeMcpHubAction } from '../../mcp_hub.mjs';
import {
  executeArenaAction,
  executeCanvasAction,
  executeDataAction,
  executeDocAction,
  executeResearchAction,
  executeScheduleAction,
  executeVisionAction,
  executeVoiceAction,
  loadSchedules,
} from '../../classic_ai_tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let state = loadState();
let quotaCache = null;
let modelCache = null;
let catalogCache = null;
const jobs = new Map();
const running = new Map();
const queue = [];

const PANEL_TOOLS_INSTRUCTIONS = `Utilise directement les outils locaux fournis (list_directory, search_files, read_file, et selon permission edit_file, write_file, run_command). Ne réécris pas le code dans ta réponse finale : termine par un bilan ultra-court (<= 6 lignes) des fichiers modifiés et commandes exécutées.`;

const PANEL_INSTRUCTIONS = `Réponds clairement et directement en français (ou dans la langue de la demande).
Si du code est demandé, fournis un code complet, propre et directement utilisable dans des blocs Markdown standards, sans blabla inutile.`;

const PANEL_CANVAS_INSTRUCTIONS = `Mode Canvas & Artefact actif : crée un artefact visuel ou document structuré complet et autonome (page HTML/CSS/JS complète dans un bloc \`\`\`html, graphique \`\`\`svg, diagramme \`\`\`mermaid ou document Markdown riche). Soigne l'esthétique et la lisibilité.`;

const PANEL_PLAN_INSTRUCTIONS = `Propose un plan clair, concret et concis : étapes, fichiers concernés et points d'attention, sans rédiger le code complet.`;

const PANEL_PATCH_INSTRUCTIONS = `N'utilise jamais create_artifact / artefact / canvas. Ne réécris JAMAIS le fichier complet : formate CHAQUE modification exactement avec TARGET: suivi d'un bloc de code et REPLACE: suivi d'un bloc de code.`;

const EXECUTION_MODES = new Set(['generate', 'apply', 'plan', 'patch', 'dry-run']);
const ROUTING_PROFILES = new Set(['auto', 'eco', 'fast', 'quality', 'security', 'refactor']);

function profileState(st, profile) {
  const routingProfile = ROUTING_PROFILES.has(profile) ? profile
    : (ROUTING_PROFILES.has(st.routingProfile) ? st.routingProfile : 'quality');
  return { ...st, routingProfile };
}

function panelInstructions(executionMode, { useTools = false, reasoningEffort = 'deep', enableCanvas = false } = {}) {
  const base = useTools
    ? PANEL_TOOLS_INSTRUCTIONS
    : (enableCanvas
      ? PANEL_CANVAS_INSTRUCTIONS
      : (executionMode === 'plan'
        ? PANEL_PLAN_INSTRUCTIONS
        : (executionMode === 'patch' ? PANEL_PATCH_INSTRUCTIONS : PANEL_INSTRUCTIONS)));
  return base + buildReasoningDirective(reasoningEffort, executionMode);
}

function normalizeDelegation(task, requestedMode, requestedProfile, requestedPerm, requestedEffort) {
  const rawTask = String(task ?? '').trim();
  const directives = parseTaskDirectives(rawTask);
  const executionMode = EXECUTION_MODES.has(requestedMode) ? requestedMode : directives.executionMode;
  const routingProfile = ROUTING_PROFILES.has(requestedProfile) ? requestedProfile
    : (ROUTING_PROFILES.has(directives.profile) ? directives.profile : undefined);
  const permissionMode = PERMISSION_MODES.includes(requestedPerm) ? requestedPerm
    : (PERMISSION_MODES.includes(directives.permissionMode) ? directives.permissionMode : undefined);
  const reasoningEffort = REASONING_EFFORTS.includes(requestedEffort) ? requestedEffort
    : (REASONING_EFFORTS.includes(directives.reasoningEffort) ? directives.reasoningEffort : undefined);
  return { task: directives.prompt, rawTask, executionMode, routingProfile, permissionMode, reasoningEffort };
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
      readOnlyWorkspace: (st.permissionMode || 'acceptEdits') === 'plan' || st.useClientTools === false,
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
    filesWritten: j.filesWritten ?? [],
    commandsRun: j.commandsRun ?? [],
    toolTurns: j.toolTurns ?? 0,
    permissionMode: j.permissionMode ?? null,
    reasoningEffort: j.reasoningEffort ?? null,
    lastThoughts: (j.thoughts || []).slice(-8),
    thoughts: (j.thoughts || []).slice(-12),
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
    triggeredCapabilities: j.triggeredCapabilities ?? null,
    webSearchSources: j.webSearchSources ?? [],
    generatedImages: j.generatedImages ?? [],
    canvasPreview: j.canvasPreview ?? null,
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
    thoughts: (job.thoughts || []).slice(-12),
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
    const { ids, agentMap, metaMap } = await fetchModels();
    state = profileState(loadState(), job.routingProfile);
    const effectiveEffort = normalizeReasoningEffort(job.reasoningEffort || state.reasoningEffort, 'deep');
    state.reasoningEffort = effectiveEffort;
    const wsRoot = job.workspaceRoot || state.lastWorkspaceRoot || '';
    const preUseTools = Boolean(state.useClientTools !== false && wsRoot && job.executionMode !== 'patch');
    const route = pickModel(job.rawTask ?? job.task, ids, state, job.explicitModel, {
      approvedModel: job.approveModel || null,
      metaMap,
      workspaceRoot: wsRoot,
      useClientTools: preUseTools,
      webSearchMode: job.webSearchMode ?? null,
      canvasMode: job.canvasMode ?? null,
      imageGenMode: job.imageGenMode ?? null,
    });
    if (route.needsApproval) {
      throw new Error(`Confirmation requise avant d'utiliser ${route.model} (« À demander »).`);
    }
    job.model = route.model;
    job.routeReason = route.reason;
    job.routingProfile = route.profile === 'auto' ? null : route.profile;
    job.executionMode = job.executionMode ?? route.executionMode ?? 'generate';
    job.permissionMode = job.permissionMode ?? route.permissionMode ?? (PERMISSION_MODES.includes(state.permissionMode) ? state.permissionMode : 'acceptEdits');
    job.reasoningEffort = route.reasoningEffort ?? effectiveEffort;
    job.triggeredCapabilities = {
      intent: route.intent || 'general',
      webSearch: Boolean(route.enableWebSearch),
      canvas: Boolean(route.enableCanvas),
      imageGen: Boolean(route.enableImageGen),
    };
    job.contextMode = 'minimal';

    const useTools = Boolean(
      state.useClientTools !== false &&
      wsRoot &&
      job.executionMode !== 'patch' &&
      !route.enableCanvas
    );
    const clientTools = useTools ? toolsForPermissionMode(job.permissionMode, job.executionMode) : [];
    const runner = clientTools.length
      ? createWorkspaceToolRunner({
        workspaceRoot: wsRoot,
        permissionMode: job.permissionMode,
        jobId: job.id,
        onMutation: (list) => { job.filesWritten = list; },
        onCommand: (list) => { job.commandsRun = list; },
      })
      : null;

    logEvent('info', 'panel', 'panel.job.start', `Démarrage job panneau ${job.id} (${route.model}).`, { jobId: job.id, model: route.model, tools: clientTools.length, reasoningEffort: job.reasoningEffort, triggers: job.triggeredCapabilities });

    const usePersistent = job.executionMode !== 'plan' && job.executionMode !== 'dry-run';
    const chatId = usePersistent ? await preparePanelChat(state) : undefined;
    if (chatId) job.chatId = chatId;

    let finalPrompt = route.prompt;
    if (wsRoot && !chatId) {
      try { observePromptSignals(wsRoot, route.prompt); } catch { /* ignore */ }
      const annex = buildTurn1Annex(wsRoot, { includeShortContext: Boolean(clientTools.length) });
      if (annex) finalPrompt += `\n\n${annex}`;
    }
    job.inputEstimateTokens = estimateTokens(finalPrompt);

    job.thoughts.push('En attente d’un créneau France Student partagé.');
    const lease = await acquireGlobalSlot(state, `panel-${job.id}`, ac.signal);
    job.slot = lease.index + 1;
    job.status = 'running';
    job.startedAt = Date.now();
    let liveText = '';
    let result;
    try {
      try {
        result = await streamGenerationWithRefusalFallback({
          state,
          model: route.model,
          approvedModel: job.approveModel || null,
          availableModels: ids,
          agentMap,
          instructions: panelInstructions(job.executionMode, { useTools: clientTools.length > 0, reasoningEffort: job.reasoningEffort, enableCanvas: Boolean(route.enableCanvas) }),
          prompt: finalPrompt,
          chatId,
          clientTools,
          enableWebSearch: Boolean(route.enableWebSearch),
          enableCanvas: Boolean(route.enableCanvas),
          enableImageGen: route.enableImageGen ? true : undefined,
          executeToolCall: runner ? (call) => runner.execute(call) : null,
          maxToolTurns: 18,
          onToolCall: ({ turn, name }) => {
            job.thoughts.push(`Outil #${turn} : ${name}`);
            job.thoughts = job.thoughts.slice(-20);
          },
          onWebSearch: ({ status, queries, sourcesCount }) => {
            const label = queries?.length ? `Recherche Web : ${queries[0].slice(0, 60)}` : `Recherche Web (${status || 'actif'})`;
            job.thoughts.push(sourcesCount ? `${label} · ${sourcesCount} sources` : label);
            job.thoughts = job.thoughts.slice(-20);
          },
          onImageGenerated: (img) => {
            job.thoughts.push(`Image IA générée (${img.status || 'ok'})`);
            job.thoughts = job.thoughts.slice(-20);
          },
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
      } catch (err) {
        const status = Number(err?.status ?? 0);
        if (!err?.noPlanB && !ac.signal.aborted && status !== 401 && status !== 403 && Boolean(chatId)) {
          job.thoughts.push('Plan B automatique : nouvel essai sur session neuve isolée…');
          result = await streamGenerationWithRefusalFallback({
            state,
            model: route.model,
            approvedModel: job.approveModel || null,
            availableModels: ids,
            agentMap,
            instructions: panelInstructions(job.executionMode, { useTools: false, reasoningEffort: job.reasoningEffort, enableCanvas: Boolean(route.enableCanvas) }),
            prompt: route.prompt,
            chatId: undefined,
            clientTools: [],
            enableWebSearch: Boolean(route.enableWebSearch),
            enableCanvas: Boolean(route.enableCanvas),
            executeToolCall: null,
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
        } else {
          throw err;
        }
      }
    } finally {
      lease.release();
    }
    flushThought();
    job.chatId = result.chatId ?? job.chatId;
    if (usePersistent && result.chatId) rememberPanelChat(result.chatId);
    job.model = result.model ?? job.model;
    job.refusals = result.refusals ?? job.refusals ?? [];
    job.attemptedModels = result.attemptedModels ?? job.attemptedModels;
    job.toolTurns = result.toolTurns ?? 0;
    job.webSearchSources = result.webSearchSources ?? [];
    job.generatedImages = result.generatedImages ?? [];
    if (runner) {
      job.filesWritten = runner.getFilesWritten();
      job.commandsRun = runner.getCommandsRun();
    }
    job.tokenMeasurement = result.tokenMeasurement ?? {
      localPromptEstimateTokens: job.inputEstimateTokens,
      providerUsage: normalizeProviderTokenUsage(result.usage),
    };
    job.response = String(result.text ?? '').trim().slice(0, 30_000);
    if (route.enableCanvas && job.response) {
      const htmlMatch = /```html\s*\n([\s\S]+?)```/i.exec(job.response);
      const svgMatch = !htmlMatch ? /```svg\s*\n([\s\S]+?)```/i.exec(job.response) : null;
      const mmdMatch = (!htmlMatch && !svgMatch) ? /```mermaid\s*\n([\s\S]+?)```/i.exec(job.response) : null;
      const artContent = htmlMatch?.[1] || svgMatch?.[1] || mmdMatch?.[1] || null;
      const artType = htmlMatch ? 'html' : (svgMatch ? 'svg' : (mmdMatch ? 'mermaid' : null));
      if (artContent && artType) {
        try {
          const cv = await executeCanvasAction({
            action: 'create',
            id: `panel-${job.id}`,
            title: job.title.replace(/^\[ATG\]\s*/, '').slice(0, 60),
            type: artType,
            content: artContent.trim(),
          });
          if (cv?.url) job.canvasPreview = { id: cv.id, type: artType, url: cv.url };
        } catch { /* non-blocking */ }
      }
    }
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
  const modelCatalog = displayIds.length
    ? enrichModelsCatalog(displayIds, metaMap, state, rawCatalog.models).map((m) => ({
      ...m,
      cooldown: getModelCooldown(m.id),
    }))
    : [];
  const session = await panelSession('status').catch(() => ({ chatId: state.directChats?.panel ?? null, usagePercent: null }));
  const localActive = [...jobs.values()].map(publicView);
  const mcpActive = readLiveJobs().filter((m) => !jobs.has(m.jobId));
  const wsRoot = state.lastWorkspaceRoot || '';
  const permMode = PERMISSION_MODES.includes(state.permissionMode) ? state.permissionMode : 'acceptEdits';
  const useClientTools = state.useClientTools !== false;
  return {
    hasKey: credential.configured === true,
    credential,
    authLogin: getBrowserLoginStatus(),
    quota: quotaCache,
    cooldown: getGlobalCooldown(state),
    cutoff: state.cutoffPercent,
    mode: state.mode,
    routingProfile: ROUTING_PROFILES.has(state.routingProfile) ? state.routingProfile : 'quality',
    permissionMode: permMode,
    useClientTools,
    computerUseEnabled: state.computerUseEnabled !== false,
    webSearchMode: normalizeTriggerMode(state.webSearchMode ?? (state.enableWebSearch === false ? 'off' : 'auto'), 'auto'),
    canvasMode: normalizeTriggerMode(state.canvasMode ?? 'auto', 'auto'),
    imageGenMode: normalizeTriggerMode(state.imageGenMode ?? 'auto', 'auto'),
    smartRouting: state.smartRouting !== false,
    browserSession: getBrowserSessionStatus(),
    mcpHub: {
      total: MCP_HUB_CATALOG.length,
      categories: MCP_HUB_CATEGORIES,
      connectors: allHubConnectors(),
    },
    schedules: loadSchedules(),
    lastWorkspaceRoot: wsRoot || null,
    undoEntries: wsRoot ? listUndoEntries(wsRoot, 15) : [],
    projectMemory: getProjectMemory(wsRoot),
    autoDelegate: state.autoDelegate !== false,
    maxParallel: state.maxParallel,
    showReasoning: state.showReasoning !== false,
    reasoningEffort: normalizeReasoningEffort(state.reasoningEffort, 'deep'),
    reuseChat: state.reuseChat !== false,
    contextCompactPercent: state.contextCompactPercent ?? 80,
    contextMode: state.contextMode ?? 'minimal',
    session,
    slots: globalSlotStatus(state),
    modelPolicies: { ...loadModelPoliciesFile(), ...(state.modelPolicies || {}) },
    allowedModels: state.allowedModels,
    blockedModels: state.blockedModels,
    tiers: state.tiers,
    tierModels: groupModelsByTier(displayIds, state, metaMap),
    models: displayIds,
    modelCatalog,
    telemetry: getModelTelemetry(),
    modelAvailability: { available: Boolean(modelsBundle.available), source: modelsBundle.source ?? 'unavailable' },
    mcp: {
      name: 'fs-atg',
      version: CONNECTOR_VERSION,
      transport: 'stdio',
      registration: 'declared',
      readOnlyWorkspace: permMode === 'plan' || !useClientTools,
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
  clearGlobalCooldown();
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
    const credential = await apiCredentialStatus(state);
    if (credential.mode === 'web-session') {
      return {
        ok: true,
        hasKey: true,
        apiKey: '',
        credential,
        message: 'Session navigateur active (cookie protégé non affiché).',
      };
    }
    const apiKey = await resolveApiKey(state);
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

app.api('/api/auth/login-start', async () => {
  const authLogin = await startBrowserLogin({
    onComplete: async () => {
      quotaCache = null;
      modelCache = null;
      catalogCache = null;
      await Promise.all([
        fetchQuota(true).catch(() => null),
        fetchModels(true).catch(() => null),
        fetchRawCatalog(true).catch(() => null),
      ]);
    },
  });
  return { ok: true, authLogin };
});

app.api('/api/auth/login-status', () => ({ ok: true, authLogin: getBrowserLoginStatus() }), 'GET');

app.api('/api/auth/login-cancel', () => ({ ok: true, authLogin: cancelBrowserLogin() }));

app.api('/api/settings', (data) => {
  state = loadState();
  if (data.mode === 'eco' || data.mode === 'fast') state.mode = data.mode;
  if (ROUTING_PROFILES.has(data.routingProfile)) state.routingProfile = data.routingProfile;
  if (typeof data.autoDelegate === 'boolean') {
    state.autoDelegate = data.autoDelegate;
  }
  if (PERMISSION_MODES.includes(data.permissionMode)) {
    state.permissionMode = data.permissionMode;
  }
  if (typeof data.useClientTools === 'boolean') {
    state.useClientTools = data.useClientTools;
  }
  if (typeof data.computerUseEnabled === 'boolean') {
    state.computerUseEnabled = data.computerUseEnabled;
  }
  if (data.webSearchMode !== undefined) {
    state.webSearchMode = normalizeTriggerMode(data.webSearchMode, 'auto');
    state.enableWebSearch = state.webSearchMode !== 'off';
  }
  if (data.canvasMode !== undefined) {
    state.canvasMode = normalizeTriggerMode(data.canvasMode, 'auto');
  }
  if (data.imageGenMode !== undefined) {
    state.imageGenMode = normalizeTriggerMode(data.imageGenMode, 'auto');
  }
  if (typeof data.smartRouting === 'boolean') {
    state.smartRouting = data.smartRouting;
  }
  if (typeof data.autoDelegate === 'boolean' || PERMISSION_MODES.includes(data.permissionMode)) {
    syncAgentsRule(state.autoDelegate !== false, state.permissionMode);
    logEvent('info', 'panel', 'settings.policy', `Règles mises à jour : ${state.autoDelegate !== false ? 'Auto' : 'Manuel'} (${state.permissionMode || 'acceptEdits'}).`);
  }
  if (typeof data.cutoffPercent === 'number') state.cutoffPercent = Math.max(0, Math.min(90, data.cutoffPercent));
  if (typeof data.maxParallel === 'number') state.maxParallel = Math.max(1, Math.min(6, data.maxParallel));
  if (typeof data.showReasoning === 'boolean') state.showReasoning = data.showReasoning;
  if (data.reasoningEffort !== undefined) state.reasoningEffort = normalizeReasoningEffort(data.reasoningEffort, state.reasoningEffort || 'deep');
  if (typeof data.reuseChat === 'boolean') state.reuseChat = data.reuseChat;
  if (typeof data.contextCompactPercent === 'number') state.contextCompactPercent = Math.max(50, Math.min(95, data.contextCompactPercent));
  if (['minimal', 'targeted', 'smart'].includes(data.contextMode)) state.contextMode = data.contextMode;
  if (Array.isArray(data.allowedModels)) state.allowedModels = data.allowedModels.map((s) => String(s).trim()).filter(Boolean);
  if (Array.isArray(data.blockedModels)) state.blockedModels = data.blockedModels.map((s) => String(s).trim()).filter(Boolean);
  if (data.modelPolicies && typeof data.modelPolicies === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(data.modelPolicies)) {
      const id = String(k).trim();
      if (id && MODEL_POLICIES.includes(v)) clean[id] = v;
    }
    state.modelPolicies = { ...loadModelPoliciesFile(), ...(state.modelPolicies || {}), ...clean };
  }
  if (data.modelPolicy && typeof data.modelPolicy === 'object') {
    const id = String(data.modelPolicy.id || '').trim();
    const policy = String(data.modelPolicy.policy || '').trim();
    if (id && MODEL_POLICIES.includes(policy)) {
      state.modelPolicies = { ...loadModelPoliciesFile(), ...(state.modelPolicies || {}), [id]: policy };
      logEvent('info', 'panel', 'settings.model_policy', `Politique modèle ${id} → ${policy}.`, { id, policy });
    }
  }
  if (state.modelPolicies && Object.keys(state.modelPolicies).length > 0) {
    saveModelPoliciesFile(state.modelPolicies);
  }
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
  return {
    ok: true,
    autoDelegate: state.autoDelegate !== false,
    permissionMode: state.permissionMode || 'acceptEdits',
    modelPolicies: state.modelPolicies || {},
    blockedModels: state.blockedModels || [],
  };
});

app.api('/api/computer', async (data) => {
  state = loadState();
  return await executeComputerAction(data, {
    permissionMode: state.permissionMode || 'acceptEdits',
    computerUseEnabled: state.computerUseEnabled !== false,
  });
});

app.api('/api/browser', async (data) => await executeBrowserAction(data));

app.api('/api/system', async (data) => await executeSystemAction(data));

app.api('/api/mcp-hub', async (data) => {
  state = loadState();
  return await executeMcpHubAction({
    ...data,
    workspaceRoot: data?.workspaceRoot || state.lastWorkspaceRoot || '',
  });
});

app.api('/api/fs-personalization', async (data) => {
  state = loadState();
  const action = String(data?.action || 'get').toLowerCase();
  if (action === 'update' || action === 'patch') {
    const allowed = {};
    if (typeof data.documentToolsEnabled === 'boolean') allowed.documentToolsEnabled = data.documentToolsEnabled;
    if (typeof data.imageGenerationToolEnabled === 'boolean') allowed.imageGenerationToolEnabled = data.imageGenerationToolEnabled;
    if (typeof data.memoryEnabled === 'boolean') allowed.memoryEnabled = data.memoryEnabled;
    if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(data.gptReasoning)) allowed.gptReasoning = data.gptReasoning;
    if (['open', 'filtered', 'disabled'].includes(data.webSearchMode)) allowed.webSearchMode = data.webSearchMode;
    if (['off', 'lite', 'standard', 'ultra'].includes(data.promptCompression)) allowed.promptCompression = data.promptCompression;
    if (['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'].includes(data.imageGenerationModel)) {
      allowed.imageGenerationModel = data.imageGenerationModel;
    }
    const updated = await updateUserPersonalization(state, allowed);
    return { ok: true, personalization: updated };
  }
  const cur = await fetchUserPersonalization(state, { force: Boolean(data?.force) });
  return { ok: true, personalization: cur };
});

app.api('/api/chats', async (data) => {
  state = loadState();
  const action = String(data?.action || 'list').toLowerCase();
  if (action === 'search' && data?.query) {
    const res = await fsJson(state, 'GET', `/chats/search?q=${encodeURIComponent(String(data.query))}`);
    const list = Array.isArray(res) ? res : (res?.data || res?.items || res?.chats || []);
    return { ok: true, chats: list.slice(0, 20) };
  }
  if (action === 'resume' && data?.chatId) {
    state.directChats = { ...(state.directChats || {}), panel: String(data.chatId) };
    saveState(state);
    return { ok: true, chatId: String(data.chatId), message: 'Conversation reprise sur le panneau.' };
  }
  const res = await fsJson(state, 'GET', '/chats');
  const list = Array.isArray(res) ? res : (res?.data || res?.items || res?.chats || []);
  return { ok: true, chats: list.slice(0, 20), activePanelChatId: state.directChats?.panel || null };
});

app.api('/api/token-activity', async () => {
  state = loadState();
  const res = await fsJson(state, 'GET', '/user/tokenusage');
  return { ok: true, activity: res };
});

app.api('/api/deskdock', async (data) => {
  state = loadState();
  return await controlDeskDock(state, data?.action || 'status');
});

app.api('/api/classic-ai', async (data) => {
  state = loadState();
  const tool = String(data?.tool || '').trim().toLowerCase();
  const payload = { ...data, workspaceRoot: data?.workspaceRoot || state.lastWorkspaceRoot || '' };
  if (tool === 'data') return await executeDataAction(payload);
  if (tool === 'research') return await executeResearchAction(payload);
  if (tool === 'canvas') return await executeCanvasAction(payload);
  if (tool === 'vision') return await executeVisionAction(payload);
  if (tool === 'arena') return await executeArenaAction(payload);
  if (tool === 'doc') return await executeDocAction(payload);
  if (tool === 'voice') return await executeVoiceAction(payload);
  if (tool === 'schedule') return await executeScheduleAction(payload);
  throw new Error(`Outil classic-ai inconnu : "${tool}".`);
});

app.api('/api/undo/diff', (data) => {
  state = loadState();
  const ws = String(data?.workspaceRoot || state.lastWorkspaceRoot || '').trim();
  if (!ws) throw new Error('Aucun workspace actif.');
  return getUndoDiff(ws, String(data?.undoId || ''));
});

const CONFIG_EXPORT_VERSION = 1;

app.api('/api/config/export', () => {
  state = loadState();
  return {
    ok: true,
    config: {
      fsatgConfigVersion: CONFIG_EXPORT_VERSION,
      connectorVersion: CONNECTOR_VERSION,
      modelPolicies: { ...loadModelPoliciesFile(), ...(state.modelPolicies || {}) },
      routingProfile: state.routingProfile,
      mode: state.mode,
      permissionMode: state.permissionMode,
      reasoningEffort: state.reasoningEffort,
      cutoffPercent: state.cutoffPercent,
      maxParallel: state.maxParallel,
      tiers: state.tiers,
      allowedModels: state.allowedModels || [],
      blockedModels: state.blockedModels || [],
    },
  };
});

app.api('/api/config/import', (data) => {
  const cfg = data?.config;
  if (!cfg || typeof cfg !== 'object' || Number(cfg.fsatgConfigVersion) !== CONFIG_EXPORT_VERSION) {
    throw new Error('Fichier de configuration invalide (fsatgConfigVersion attendu : 1).');
  }
  state = loadState();
  const applied = [];
  if (cfg.modelPolicies && typeof cfg.modelPolicies === 'object' && !Array.isArray(cfg.modelPolicies)) {
    const clean = {};
    for (const [k, v] of Object.entries(cfg.modelPolicies)) {
      const id = String(k).trim();
      if (id && MODEL_POLICIES.includes(v)) clean[id] = v;
    }
    state.modelPolicies = clean;
    saveModelPoliciesFile(clean);
    state.blockedModels = [];
    applied.push('modelPolicies');
  }
  if (ROUTING_PROFILES.has(cfg.routingProfile)) { state.routingProfile = cfg.routingProfile; applied.push('routingProfile'); }
  if (cfg.mode === 'eco' || cfg.mode === 'fast') { state.mode = cfg.mode; applied.push('mode'); }
  if (PERMISSION_MODES.includes(cfg.permissionMode)) { state.permissionMode = cfg.permissionMode; applied.push('permissionMode'); }
  if (cfg.reasoningEffort !== undefined) { state.reasoningEffort = normalizeReasoningEffort(cfg.reasoningEffort, state.reasoningEffort || 'deep'); applied.push('reasoningEffort'); }
  if (typeof cfg.cutoffPercent === 'number') { state.cutoffPercent = Math.max(0, Math.min(90, cfg.cutoffPercent)); applied.push('cutoffPercent'); }
  if (typeof cfg.maxParallel === 'number') { state.maxParallel = Math.max(1, Math.min(6, cfg.maxParallel)); applied.push('maxParallel'); }
  const cleanList = (a) => (Array.isArray(a) ? a.map((s) => String(s).trim()).filter(Boolean) : null);
  if (cfg.tiers && typeof cfg.tiers === 'object') {
    state.tiers = {
      light: cleanList(cfg.tiers.light) || state.tiers.light,
      medium: cleanList(cfg.tiers.medium) || state.tiers.medium,
      heavy: cleanList(cfg.tiers.heavy) || state.tiers.heavy,
    };
    applied.push('tiers');
  }
  const allowed = cleanList(cfg.allowedModels);
  if (allowed) { state.allowedModels = allowed; applied.push('allowedModels'); }
  const blocked = cleanList(cfg.blockedModels);
  if (blocked) { state.blockedModels = blocked; applied.push('blockedModels'); }
  saveState(state);
  logEvent('info', 'panel', 'settings.import', `Configuration importée (${applied.join(', ') || 'rien'}).`);
  return { ok: true, applied };
});

app.api('/api/undo', (data) => {
  state = loadState();
  const ws = String(data?.workspaceRoot || state.lastWorkspaceRoot || '').trim();
  if (!ws) throw new Error('Aucun workspace actif pour /undo.');
  const res = undoLastChange(ws, data?.undoId || null);
  if (res.ok) logEvent('info', 'panel', 'undo.applied', `Restauré ${res.undone.rel} (${res.undone.action}).`, res.undone);
  return { ...res, undoEntries: listUndoEntries(ws, 15) };
});

app.api('/api/memory', (data) => {
  state = loadState();
  const ws = String(data?.workspaceRoot || state.lastWorkspaceRoot || '').trim();
  const action = String(data?.action || 'get');
  if (action === 'add' || action === 'remember') addProjectNote(ws, data?.text || '');
  else if (action === 'remove' || action === 'forget') removeProjectNote(ws, data?.id || data?.text || '');
  else if (action === 'clear') clearProjectMemory(ws);
  else if (action === 'preprompt') setPreprompt(ws, data?.text ?? '');
  return { ok: true, workspaceRoot: ws || null, projectMemory: getProjectMemory(ws) };
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

app.api('/api/delegate', async (data) => {
  const delegation = normalizeDelegation(data.task, data.executionMode, data.routingProfile, data.permissionMode, data.reasoningEffort);
  if (!delegation.task) throw new Error('Tâche vide après les commandes locales.');
  const st = profileState(loadState(), delegation.routingProfile);
  st.reasoningEffort = normalizeReasoningEffort(delegation.reasoningEffort || st.reasoningEffort, 'deep');
  const { ids } = await fetchModels().catch(() => ({ ids: [] }));
  if (ids.length) {
    const route = pickModel(delegation.rawTask, ids, st, data.model || undefined, { approvedModel: data.approveModel || null });
    if (route.needsApproval) {
      return {
        ok: false,
        needsApproval: true,
        model: route.model,
        reason: route.reason,
        alternatives: route.alternatives,
      };
    }
  }
  const firstLine = delegation.task.split('\n')[0];
  const job = {
    id: randomUUID().slice(0, 8),
    title: `${ATG} ${firstLine.slice(0, 70)}${firstLine.length > 70 ? '…' : ''}`,
    task: delegation.task,
    rawTask: delegation.rawTask,
    workspaceRoot: data.workspaceRoot || loadState().lastWorkspaceRoot || undefined,
    explicitModel: data.model || undefined,
    approveModel: data.approveModel || undefined,
    executionMode: delegation.executionMode,
    permissionMode: delegation.permissionMode,
    reasoningEffort: delegation.reasoningEffort,
    routingProfile: delegation.routingProfile,
    webSearchMode: data.webSearch ?? undefined,
    canvasMode: data.canvas ?? undefined,
    imageGenMode: data.imageGen ?? undefined,
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
  return { ok: true, jobId: job.id };
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

// Proactive web-session refresh: renew the short-lived access token ~2 min before
// expiry so the next prompt never pays the refresh latency.
setInterval(async () => {
  try {
    const st = loadState();
    if (!st.webSessionConfigured) return;
    if (webAccessExpiresInMs() > 120_000) return;
    await resolveAuthToken(st, { forceRefresh: true });
  } catch { /* surfaced on next real request */ }
}, 45_000).unref?.();

logEvent('info', 'panel', 'panel.started', `Panneau latéral France Student [ATG] v${CONNECTOR_VERSION} démarré.`);
app.run();
