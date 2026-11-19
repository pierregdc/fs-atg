import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ATG,
  ANTIGRAVITY_QUOTA_VISIBILITY,
  CONNECTOR_VERSION,
  MCP_TOOL_CATALOG,
  acquireGlobalSlot,
  apiCredentialStatus,
  compactChatContext,
  compactCatalog,
  enrichModelsCatalog,
  estimateAntigravityJobSavings,
  estimateTokens,
  fetchAgentsAndModels,
  fetchChatContext,
  fetchChatStreamMetrics,
  fetchModelCatalog,
  fetchQuotaSnapshot,
  fetchRemoteCatalog,
  formatWorkspaceSymbolIndex,
  fsJson,
  globalSlotStatus,
  loadState,
  normalizeProviderTokenUsage,
  parseTaskDirectives,
  pickModel,
  recordAntigravitySavings,
  resolveSafe,
  saveState,
  streamGenerationWithRefusalFallback,
  workspaceSketch,
  workspaceSymbolIndex,
  writeLiveJobs,
} from './fs_core.mjs';
import { LOG_PATH, countRecentErrors, logEvent, readLogs } from './logger.mjs';

const NATURAL_INSTRUCTIONS = `Réponds en français (ou langue de la demande) de façon ultra-concise et dense : zéro introduction, zéro conclusion, zéro reformulation.
Si du code est demandé : N'UTILISE JAMAIS create_artifact / artefact / canvas. Écris uniquement le bloc de code ou patch ciblé directement en Markdown, sans commentaires évidents ni texte superflu autour.`;

const PLAN_INSTRUCTIONS = `Réponds en style télégraphique (15 lignes max) : fichiers exacts, étapes clés et risques majeurs uniquement. Zéro code complet, zéro blabla.`;

const PLAN_B_PART_INSTRUCTIONS = `N'utilise jamais create_artifact / artefact / canvas. Donne uniquement le bloc de code ou patch demandé pour cette partie, complet, compact, sans commentaires superflus ni texte autour.`;

const FINAL = new Set(['done', 'error', 'cancelled']);
const EXECUTION_MODES = new Set(['generate', 'apply', 'plan', 'dry-run']);
const ROUTING_PROFILES = new Set(['eco', 'fast', 'quality', 'security', 'refactor']);
const jobs = new Map();
const running = new Map();
const queue = [];
const listeners = new Set();
const diagnosticState = { lastApiError: null, lastApiAt: null, lastModelsError: null, lastModelsAt: null };

function notify() {
  const live = [...jobs.values()].map(publicView);
  writeLiveJobs(live);
  for (const fn of listeners) fn();
}

const liveHeartbeat = setInterval(() => {
  if (jobs.size) notify();
}, 8_000);
liveHeartbeat.unref?.();

function directSessionKey(job) {
  return job.workspaceRoot ? `workspace:${resolve(job.workspaceRoot).toLowerCase()}` : 'mcp:global';
}

async function prepareDirectChat(st, key) {
  if (st.reuseChat === false) return undefined;
  const chatId = st.directChats?.[key];
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
      delete st.directChats[key];
      saveState(st);
      return undefined;
    }
    return chatId;
  }
}

function rememberDirectChat(key, chatId) {
  if (!chatId) return;
  const st = loadState();
  if (st.reuseChat === false) return;
  st.directChats = { ...(st.directChats || {}), [key]: chatId };
  saveState(st);
}

function contextModeOf(job, st) {
  return ['minimal', 'targeted', 'smart'].includes(job.contextMode) ? job.contextMode
    : (['minimal', 'targeted', 'smart'].includes(st.contextMode) ? st.contextMode : 'minimal');
}

function connectorSnapshot(st) {
  return {
    name: 'fs-atg',
    version: CONNECTOR_VERSION,
    transport: 'stdio',
    registration: 'declared',
    readOnlyWorkspace: true,
    autoDelegate: st.autoDelegate !== false,
    toolCount: MCP_TOOL_CATALOG.length,
    tools: MCP_TOOL_CATALOG,
    slots: globalSlotStatus(st),
  };
}

function normalizedDelegation(task, requestedMode, requestedProfile) {
  const rawTask = String(task ?? '').trim();
  const directives = parseTaskDirectives(rawTask);
  const executionMode = EXECUTION_MODES.has(requestedMode) ? requestedMode : directives.executionMode;
  const routingProfile = ROUTING_PROFILES.has(requestedProfile) ? requestedProfile
    : (ROUTING_PROFILES.has(directives.profile) ? directives.profile : undefined);
  return { task: directives.prompt, rawTask, executionMode, routingProfile };
}

function profileState(st, profile) {
  const routingProfile = ROUTING_PROFILES.has(profile) ? profile : (ROUTING_PROFILES.has(st.routingProfile) ? st.routingProfile : 'quality');
  return { ...st, routingProfile };
}

function buildNaturalPrompt(basePrompt, job, st, hasPersistentChat) {
  const mode = contextModeOf(job, st);
  let next = basePrompt;
  if (job.parentId && !hasPersistentChat) {
    const parent = st.history?.find((h) => (h.id || h.jobId) === job.parentId);
    if (parent) {
      const snippet = String(parent.response || parent.summary || '').slice(0, 1200);
      if (snippet) next = `Contexte précédent :\n${snippet}\n\nNouvelle demande : ${next}`;
    }
  }
  if (job.workspaceRoot && job.files?.length) {
    let remaining = 24_000;
    const chunks = [];
    for (const rel of job.files.slice(0, 6)) {
      try {
        const safe = resolveSafe(job.workspaceRoot, rel);
        const raw = readFileSync(safe.abs, 'utf-8');
        const slice = raw.slice(0, Math.max(0, remaining));
        remaining -= slice.length;
        chunks.push(`Fichier \`${safe.rel}\` :\n\`\`\`\n${slice}${raw.length > slice.length ? '\n[tronqué]' : ''}\n\`\`\``);
        if (remaining <= 0) break;
      } catch (e) {
        logEvent('warn', 'mcp', 'context.file_skipped', `Impossible de lire ${rel} : ${e?.message ?? e}`, { jobId: job.id, rel });
      }
    }
    if (chunks.length) next += `\n\n${chunks.join('\n\n')}`;
  }
  if (job.workspaceRoot && mode === 'smart') {
    const index = formatWorkspaceSymbolIndex(workspaceSymbolIndex(job.workspaceRoot, 30), 3_000);
    if (index) next += `\n\nAperçu de structure :\n${index}`;
    else {
      const sketch = workspaceSketch(job.workspaceRoot, 30);
      if (sketch.length) next += `\n\nArborescence :\n${sketch.join('\n')}`;
    }
  }
  return { prompt: next, mode };
}

async function sessionAction(action, workspaceRoot) {
  const st = loadState();
  const key = workspaceRoot ? `workspace:${resolve(workspaceRoot).toLowerCase()}` : 'mcp:global';
  const chatId = st.directChats?.[key];
  if (action === 'new') {
    if (chatId) {
      delete st.directChats[key];
      saveState(st);
    }
    logEvent('info', 'mcp', 'session.new', 'Session réinitialisée pour la prochaine requête.', { key });
    return { ok: true, action, chatId: null, message: 'La prochaine demande ouvrira une nouvelle session.' };
  }
  if (!chatId) return { ok: true, action, chatId: null, usagePercent: null, message: 'Aucune session active.' };
  if (action === 'compact') {
    await compactChatContext(st, chatId);
    logEvent('info', 'mcp', 'session.compact', `Contexte compacté pour la session ${chatId}.`, { chatId });
  }
  const context = await fetchChatContext(st, chatId).catch(() => ({}));
  return { ok: true, action, chatId, usagePercent: context?.usagePercent ?? null };
}

async function diagnosticsSnapshot() {
  const st = loadState();
  const credential = await apiCredentialStatus(st);
  const keyConfigured = credential.configured === true;
  let quota = null;
  let apiVerified = false;
  let models = { available: false, source: 'not-authenticated', count: 0 };
  if (keyConfigured) {
    try {
      quota = await fetchQuotaSnapshot(st);
      apiVerified = true;
      diagnosticState.lastApiAt = Date.now();
      diagnosticState.lastApiError = null;
    } catch (error) {
      diagnosticState.lastApiAt = Date.now();
      diagnosticState.lastApiError = String(error?.message ?? error).slice(0, 220);
      logEvent('error', 'mcp', 'diagnostics.api_error', diagnosticState.lastApiError);
    }
    try {
      const bundle = await fetchAgentsAndModels(st);
      models = { available: Boolean(bundle.available), source: bundle.source ?? 'unknown', count: bundle.ids?.length ?? 0 };
      diagnosticState.lastModelsAt = Date.now();
      diagnosticState.lastModelsError = null;
    } catch (error) {
      diagnosticState.lastModelsAt = Date.now();
      diagnosticState.lastModelsError = String(error?.message ?? error).slice(0, 220);
      logEvent('error', 'mcp', 'diagnostics.models_error', diagnosticState.lastModelsError);
    }
  }
  const session = await sessionAction('status').catch(() => ({ chatId: null, usagePercent: null }));
  return {
    credential,
    api: { verified: apiVerified, lastCheckedAt: diagnosticState.lastApiAt, error: diagnosticState.lastApiError },
    models: { ...models, lastCheckedAt: diagnosticState.lastModelsAt, error: diagnosticState.lastModelsError },
    quota: quota ? { remainingPct: quota.remainingPct ?? null, resetAt: quota.resetAt ?? null } : null,
    mcp: { ...connectorSnapshot(st), activeJobs: jobs.size, queuedJobs: queue.length },
    antigravityQuota: ANTIGRAVITY_QUOTA_VISIBILITY,
    session: { savedChatReference: Boolean(session.chatId), usagePercent: session.usagePercent ?? null },
    autoDelegate: st.autoDelegate !== false,
    recentErrors24h: countRecentErrors(),
    logPath: LOG_PATH,
  };
}

function publicView(j) {
  const end = j.endedAt ?? Date.now();
  const usage = j.usage ?? null;
  const tokenMeasurement = j.tokenMeasurement ?? {
    localPromptEstimateTokens: j.inputEstimateTokens ?? null,
    providerUsage: normalizeProviderTokenUsage(usage),
  };
  return {
    jobId: j.id,
    title: j.title,
    status: j.status,
    model: j.model,
    route: j.routeReason,
    planB: Boolean(j.planB),
    elapsedSec: j.startedAt ? Math.round((end - j.startedAt) / 1000) : 0,
    receivedChars: j.receivedChars,
    response: j.response ?? j.summary ?? '',
    summary: j.summary,
    filesWritten: [],
    lastThoughts: (j.thoughts || []).slice(-3),
    error: j.error,
    planBRecommended: Boolean(j.planBRecommended),
    planBHint: j.planBHint ?? null,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    usage,
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

function mcpCompactView(j, verbose = false) {
  if (verbose) return publicView(j);
  const responseText = String(j.response ?? '').trim() || String(j.summary ?? '').trim();
  return {
    jobId: j.id ?? j.jobId,
    status: j.status,
    model: j.model,
    ...(j.planB ? { planB: true } : {}),
    ...(j.partsResponses?.length ? { partsResponses: j.partsResponses } : (responseText ? { response: responseText } : {})),
    ...(j.error ? { error: j.error } : {}),
    ...(j.planBRecommended ? { planBRecommended: true, planBHint: j.planBHint } : {}),
    ...(j.refusals?.length ? { refusals: j.refusals } : {}),
    ...(j.antigravitySavings?.totalTokensSavedEst ? { savedAgTokensEst: j.antigravitySavings.totalTokensSavedEst } : {}),
  };
}

function finishJob(job, status) {
  job.status = status;
  job.endedAt = Date.now();
  running.delete(job.id);
  jobs.delete(job.id);
  const st = loadState();
  if (status === 'done') {
    job.antigravitySavings = estimateAntigravityJobSavings(job, {
      waitedInline: Boolean(job.waitedInline),
      partsCount: Array.isArray(job.partsResponses) && job.partsResponses.length ? job.partsResponses.length : 1,
    });
    recordAntigravitySavings(st, job.antigravitySavings);
    logEvent('info', 'mcp', 'job.done', `Job ${job.id} terminé (${job.model}, ${job.response?.length ?? 0} car.).`, {
      jobId: job.id,
      model: job.model,
      chars: job.response?.length ?? 0,
      durationSec: job.startedAt ? Math.round((job.endedAt - job.startedAt) / 1000) : 0,
      planB: Boolean(job.planB),
    });
  } else if (status === 'error') {
    logEvent('error', 'mcp', 'job.error', `Job ${job.id} en échec : ${job.error || 'inconnu'}`, {
      jobId: job.id,
      model: job.model,
      attemptedModels: job.attemptedModels ?? [],
      refusals: job.refusals ?? [],
      planB: Boolean(job.planB),
    });
  } else if (status === 'cancelled') {
    logEvent('warn', 'mcp', 'job.cancelled', `Job ${job.id} annulé.`, { jobId: job.id, model: job.model });
  }
  const stored = {
    ...job,
    response: String(job.response ?? '').slice(0, 30_000),
    summary: String(job.summary ?? '').slice(0, 400),
    thoughts: (job.thoughts || []).slice(-5),
  };
  st.history = [stored, ...(st.history || [])].slice(0, 20);
  saveState(st);
  notify();
  pump();
}

async function runJob(job) {
  const ac = new AbortController();
  running.set(job.id, ac);
  job.status = 'waiting';
  notify();

  let thoughtBuf = '';
  const flushThought = () => {
    const t = thoughtBuf.trim();
    if (t) { job.thoughts.push(t); job.thoughts = job.thoughts.slice(-20); }
    thoughtBuf = '';
  };

  try {
    const st = profileState(loadState(), job.routingProfile);
    const q = await fetchQuotaSnapshot(st);
    if (q?.remainingPct !== null && q.remainingPct < (st.cutoffPercent ?? 15)) {
      const quotaErr = new Error(`Coupe-circuit : il reste ${q.remainingPct.toFixed(0)} % (seuil ${st.cutoffPercent} %).`);
      quotaErr.noPlanB = true;
      throw quotaErr;
    }

    const { ids, agentMap } = await fetchAgentsAndModels(st);
    const route = pickModel(job.rawTask ?? job.task, ids, st, job.explicitModel);
    job.model = route.model;
    job.routeReason = route.reason;
    job.routingProfile = route.profile === 'auto' ? null : route.profile;
    job.executionMode = job.executionMode ?? route.executionMode ?? 'generate';
    job.contextMode = contextModeOf(job, st);
    notify();

    logEvent('info', 'mcp', 'job.start', `Démarrage job ${job.id} (${route.model}, ${route.reason}).`, {
      jobId: job.id,
      model: route.model,
      profile: job.routingProfile || 'quality',
      planB: Boolean(job.planB),
      parts: job.parts?.length || 0,
    });

    job.thoughts.push('En attente d’un créneau France Student partagé.');
    notify();
    const lease = await acquireGlobalSlot(st, `mcp-${job.id}`, ac.signal);
    job.slot = lease.index + 1;
    job.status = 'running';
    job.startedAt = Date.now();
    notify();

    const makeStreamCallbacks = (labelPrefix = '') => {
      let lastPush = 0;
      let liveText = '';
      return {
        onChatId: (cid) => { job.chatId = cid; },
        onText: (d) => {
          job.receivedChars += d.length;
          liveText += d;
          job.summary = `${labelPrefix}${liveText.slice(-300)}`;
          if (Date.now() - lastPush > 600) { lastPush = Date.now(); notify(); }
        },
        onReasoning: (d) => {
          thoughtBuf += d;
          if (thoughtBuf.includes('\n') || thoughtBuf.length > 240) { flushThought(); notify(); }
        },
        onRetry: ({ from, to, reason, attempt }) => {
          job.refusals = [...(job.refusals ?? []), { model: from, reason, retryModel: to }];
          job.model = to;
          job.routeReason = `${route.reason} · repli ${from} → ${to}`;
          job.thoughts.push(`Repli (${attempt}/3) : ${from} → ${to}.`);
          job.thoughts = job.thoughts.slice(-20);
          notify();
        },
      };
    };

    try {
      // Plan B par morceaux : chaque petit bloc est généré indépendamment sur un chat neuf.
      if (Array.isArray(job.parts) && job.parts.length) {
        job.planB = true;
        const partsResponses = [];
        const allAttempted = new Set();
        const combinedUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        let hasUsage = false;
        let lastError = null;

        for (let i = 0; i < job.parts.length; i++) {
          if (ac.signal.aborted) break;
          const partText = String(job.parts[i] ?? '').trim();
          if (!partText) continue;
          const { prompt: partPrompt } = buildNaturalPrompt(partText, job, st, false);
          job.inputEstimateTokens = (job.inputEstimateTokens ?? 0) + estimateTokens(partPrompt);
          job.thoughts.push(`Plan B · bloc ${i + 1}/${job.parts.length}…`);
          notify();
          try {
            const cbs = makeStreamCallbacks(`[Bloc ${i + 1}/${job.parts.length}] `);
            const partRes = await streamGenerationWithRefusalFallback({
              state: st,
              model: route.model,
              availableModels: ids,
              agentMap,
              instructions: PLAN_B_PART_INSTRUCTIONS,
              prompt: partPrompt,
              chatId: undefined,
              signal: ac.signal,
              ...cbs,
            });
            for (const m of partRes.attemptedModels || []) allAttempted.add(m);
            job.model = partRes.model ?? job.model;
            const cleanText = String(partRes.text ?? '').trim();
            partsResponses.push({ index: i + 1, task: partText, model: partRes.model, response: cleanText });
            if (partRes.usage) {
              hasUsage = true;
              const u = normalizeProviderTokenUsage(partRes.usage);
              if (u?.inputTokens) combinedUsage.input_tokens += u.inputTokens;
              if (u?.outputTokens) combinedUsage.output_tokens += u.outputTokens;
              if (u?.totalTokens) combinedUsage.total_tokens += u.totalTokens;
            }
            logEvent('info', 'mcp', 'planB.part.done', `Bloc ${i + 1}/${job.parts.length} généré (${partRes.model}).`, { jobId: job.id, part: i + 1, model: partRes.model });
          } catch (partErr) {
            lastError = partErr;
            partsResponses.push({ index: i + 1, task: partText, model: job.model, error: partErr?.message || 'Échec du bloc' });
            logEvent('warn', 'mcp', 'planB.part.error', `Bloc ${i + 1}/${job.parts.length} échoué : ${partErr?.message}`, { jobId: job.id, part: i + 1 });
          }
        }
        flushThought();

        const succeeded = partsResponses.filter((p) => p.response);
        if (!succeeded.length) {
          const err = new Error(`Plan B en échec sur tous les blocs : ${lastError?.message || 'aucune réponse'}`);
          err.attemptedModels = [...allAttempted];
          throw err;
        }
        job.partsResponses = partsResponses;
        job.attemptedModels = [...allAttempted];
        job.response = partsResponses
          .map((p) => (p.response ? `### Partie ${p.index} — ${p.task}\n${p.response}` : `### Partie ${p.index} (échec : ${p.error})`))
          .join('\n\n')
          .slice(0, 60_000);
        job.summary = `${succeeded.length}/${partsResponses.length} bloc(s) généré(s) en Plan B.`;
        job.usage = hasUsage ? combinedUsage : null;
        job.tokenMeasurement = { localPromptEstimateTokens: job.inputEstimateTokens, providerUsage: hasUsage ? normalizeProviderTokenUsage(combinedUsage) : null };
        finishJob(job, 'done');
        return;
      }

      // Plan A (session persistante) ou Plan B isolé (chat neuf sans historique)
      const key = directSessionKey(job);
      const usePersistentChat = !job.planB && job.executionMode !== 'plan' && job.executionMode !== 'dry-run';
      const chatId = usePersistentChat ? await prepareDirectChat(st, key) : undefined;
      if (chatId) job.chatId = chatId;

      const local = buildNaturalPrompt(route.prompt, job, st, Boolean(chatId));
      job.contextMode = local.mode;
      job.inputEstimateTokens = estimateTokens(local.prompt);
      const instructions = job.executionMode === 'plan'
        ? PLAN_INSTRUCTIONS
        : (job.planB ? PLAN_B_PART_INSTRUCTIONS : NATURAL_INSTRUCTIONS);

      let result;
      try {
        result = await streamGenerationWithRefusalFallback({
          state: st,
          model: route.model,
          availableModels: ids,
          agentMap,
          instructions,
          prompt: local.prompt,
          chatId,
          signal: ac.signal,
          ...makeStreamCallbacks(),
        });
      } catch (err) {
        const status = Number(err?.status ?? 0);
        const canIsolatePlanB = !ac.signal.aborted && status !== 401 && status !== 403 && Boolean(chatId) && !job.planB;
        if (!canIsolatePlanB) throw err;
        // Repli Plan B automatique immédiat sur chat neuf isolé (sans historique potentiellement lourd/bloqué)
        job.planB = true;
        job.thoughts.push('Plan B automatique : nouvel essai sur session neuve isolée…');
        notify();
        logEvent('warn', 'mcp', 'planB.auto_isolated', `Plan A échoué avec chat persistant ; bascule Plan B sur chat neuf (${err?.message}).`, { jobId: job.id });
        const freshPrompt = buildNaturalPrompt(route.prompt, job, st, false).prompt;
        result = await streamGenerationWithRefusalFallback({
          state: st,
          model: route.model,
          availableModels: ids,
          agentMap,
          instructions: PLAN_B_PART_INSTRUCTIONS,
          prompt: freshPrompt,
          chatId: undefined,
          signal: ac.signal,
          ...makeStreamCallbacks('[Plan B] '),
        });
      }

      flushThought();
      job.chatId = result.chatId ?? job.chatId;
      if (usePersistentChat && result.chatId) rememberDirectChat(key, result.chatId);
      job.model = result.model ?? job.model;
      job.refusals = result.refusals ?? job.refusals ?? [];
      job.attemptedModels = result.attemptedModels ?? job.attemptedModels;
      job.tokenMeasurement = result.tokenMeasurement ?? {
        localPromptEstimateTokens: job.inputEstimateTokens,
        providerUsage: normalizeProviderTokenUsage(result.usage),
      };
      job.response = String(result.text ?? '').trim().slice(0, 60_000);
      job.summary = job.response.slice(0, 400);
      job.usage = result.usage;
      finishJob(job, 'done');
    } finally {
      lease.release();
    }
  } catch (e) {
    flushThought();
    if (ac.signal.aborted) {
      finishJob(job, 'cancelled');
    } else {
      const status = Number(e?.status ?? 0);
      if (!e?.noPlanB && status !== 401 && status !== 403) {
        job.planBRecommended = true;
        job.planBHint = 'Relance en Plan B par petits blocs avec fs_delegate({ task, planB: true, parts: [...] }) ou complète directement les morceaux.';
      }
      job.refusals = e.refusals ?? job.refusals ?? [];
      job.attemptedModels = e.attemptedModels ?? job.attemptedModels;
      job.error = e.message;
      finishJob(job, 'error');
    }
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

const asCompactText = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
const server = new McpServer({ name: 'fs-atg', version: CONNECTOR_VERSION });

server.registerTool('fs_delegate', {
  title: 'Déléguer à France Student [ATG]',
  description: 'Délègue à France Student (lecture seule PC) plans, diagnostics, recherches multi-sources, explications et blocs/patches ciblés. Renvoie une réponse compacte dans response pour économiser les tokens Antigravity (éviter pour 1 simple search_web ponctuel ou pour recopier un gros fichier neuf entier via write_file).',
  inputSchema: {
    task: z.string().min(3).describe('Consigne claire en phrases normales (commandes possibles : /send, /plan, /eco, /fast, /low, /medium, /high).'),
    workspaceRoot: z.string().optional().describe('Chemin du workspace (lecture seule uniquement pour files/session). Jamais écrit.'),
    files: z.array(z.string()).optional().describe('Chemins relatifs à joindre en lecture seule si indispensable.'),
    model: z.string().optional(),
    priority: z.number().int().min(0).max(9).optional(),
    contextMode: z.enum(['minimal', 'targeted', 'smart']).optional().describe('minimal recommandé = phrase seule sans surcharger.'),
    parentJobId: z.string().optional().describe('Suite d’un job précédent.'),
    executionMode: z.enum(['generate', 'apply', 'plan', 'dry-run']).optional().describe('Tous strictement sans écriture PC ; plan retourne uniquement un plan.'),
    routingProfile: z.enum(['eco', 'fast', 'quality', 'security', 'refactor']).optional(),
    planB: z.boolean().optional().describe('Active le Plan B (chat neuf isolé ou découpage via parts) en cas d’échec du Plan A.'),
    parts: z.array(z.string().min(3)).max(6).optional().describe('Plan B : 2 à 6 petites sous-demandes simples générées séparément pour assemblage.'),
    waitSeconds: z.number().min(0).max(45).optional().describe('Attente intégrée (défaut 45s) pour répondre en 1 appel.'),
    verbose: z.boolean().optional(),
  },
}, async (a) => {
  const delegation = normalizedDelegation(a.task, a.executionMode, a.routingProfile);
  if (!delegation.task && !a.parts?.length) throw new Error('Consigne vide après les commandes locales.');
  const waitSec = typeof a.waitSeconds === 'number' ? Math.max(0, Math.min(45, a.waitSeconds)) : 45;
  const firstLine = (delegation.task || a.parts?.[0] || '').split('\n')[0];
  const job = {
    id: randomUUID().slice(0, 8),
    title: `${ATG} ${firstLine.slice(0, 70)}${firstLine.length > 70 ? '…' : ''}`,
    task: delegation.task || a.parts?.join(' ; '),
    rawTask: delegation.rawTask,
    workspaceRoot: a.workspaceRoot,
    files: a.files ?? [],
    explicitModel: a.model,
    parentId: a.parentJobId,
    priority: a.priority ?? 5,
    contextMode: a.contextMode,
    executionMode: delegation.executionMode,
    routingProfile: delegation.routingProfile,
    planB: Boolean(a.planB || a.parts?.length),
    parts: Array.isArray(a.parts) && a.parts.length ? a.parts.slice(0, 6) : undefined,
    waitedInline: waitSec > 0,
    status: 'queued',
    createdAt: Date.now(),
    receivedChars: 0,
    thoughts: [],
    response: '',
    summary: '',
    written: [],
  };
  jobs.set(job.id, job);
  queue.push(job);
  queue.sort((x, y) => y.priority - x.priority || x.createdAt - y.createdAt);
  logEvent('info', 'mcp', 'job.queued', `Job ${job.id} mis en file (${job.planB ? 'Plan B' : 'Plan A'}).`, { jobId: job.id });
  notify();
  pump();
  if (waitSec > 0) {
    const doneJob = await waitFor(job.id, waitSec * 1000);
    if (doneJob && FINAL.has(doneJob.status)) {
      return asCompactText(mcpCompactView(doneJob, Boolean(a.verbose)));
    }
    return asCompactText({
      jobId: job.id,
      status: doneJob?.status ?? job.status,
      next: 'Job encore en cours après 45s : appelle fs_job_status(waitSeconds=45).',
    });
  }
  return asCompactText({ jobId: job.id, status: job.status, next: 'Appelle fs_job_status avec waitSeconds=45.' });
});

server.registerTool('fs_job_status', {
  title: "État d'un job [ATG]",
  description: "Attend jusqu'à waitSeconds que le job finisse, puis renvoie le texte/code généré dans response.",
  inputSchema: { jobId: z.string(), waitSeconds: z.number().min(0).max(45).optional(), verbose: z.boolean().optional() },
}, async ({ jobId, waitSeconds, verbose }) => {
  const job = await waitFor(jobId, (waitSeconds ?? 45) * 1000);
  return asCompactText(job ? mcpCompactView(job, Boolean(verbose)) : { error: 'jobId inconnu' });
});

server.registerTool('fs_logs', {
  title: 'Journal de bord [ATG]',
  description: 'Consulte le journal de bord persistant de France Student [ATG] pour diagnostiquer les erreurs, refus de modèles, timeouts ou problèmes API.',
  inputSchema: {
    limit: z.number().int().min(1).max(100).optional().describe('Nombre maximal d’entrées récentes (défaut 40).'),
    level: z.enum(['all', 'warn', 'error']).optional().describe('Filtre de gravité (défaut all).'),
    jobId: z.string().optional().describe('Filtrer sur un jobId précis.'),
  },
}, async ({ limit, level, jobId }) => {
  const entries = readLogs({ limit: limit ?? 40, level: level ?? 'all', jobId: jobId ?? '' });
  return asCompactText({
    logPath: LOG_PATH,
    count: entries.length,
    recentErrors24h: countRecentErrors(),
    entries,
  });
});

server.registerTool('fs_session', {
  title: 'Session France Student',
  description: 'Affiche, compacte ou renouvelle la session persistante. /compact et /new dans le chat Antigravity doivent appeler cet outil.',
  inputSchema: {
    action: z.enum(['status', 'compact', 'new']).default('status'),
    workspaceRoot: z.string().optional(),
  },
}, async ({ action, workspaceRoot }) => asCompactText(await sessionAction(action, workspaceRoot)));

server.registerTool('fs_status', {
  title: 'État du connecteur France Student [ATG]',
  description: 'Retourne sans appel fournisseur le transport MCP, la version, le mode Auto/Manuel et les outils publiés.',
  inputSchema: {},
}, async () => {
  const st = loadState();
  return asCompactText({
    mcp: { ...connectorSnapshot(st), activeJobs: jobs.size, queuedJobs: queue.length },
    recentErrors24h: countRecentErrors(),
    antigravityQuota: ANTIGRAVITY_QUOTA_VISIBILITY,
  });
});

server.registerTool('fs_diagnostics', {
  title: 'Diagnostic France Student [ATG]',
  description: 'Vérifie de façon non destructive le trousseau, l’API, les modèles, le quota, les erreurs récentes et la session. Ne révèle jamais la clé.',
  inputSchema: {},
}, async () => asCompactText(await diagnosticsSnapshot()));

server.registerTool('fs_quota', {
  title: 'Quota France Student',
  description: 'Pourcentage de quota restant et seuil du coupe-circuit.',
  inputSchema: {},
}, async () => {
  const st = loadState();
  const credential = await apiCredentialStatus(st);
  if (!credential.configured) {
    return asCompactText({ remainingPct: null, cutoff: st.cutoffPercent, resetAt: null, credential, error: 'Aucun identifiant France Student configuré.' });
  }
  try {
    const q = await fetchQuotaSnapshot(st);
    return asCompactText({ remainingPct: q.remainingPct, cutoff: st.cutoffPercent, resetAt: q.resetAt, credential });
  } catch (error) {
    logEvent('error', 'mcp', 'quota.error', error?.message || 'Erreur quota');
    return asCompactText({ remainingPct: null, cutoff: st.cutoffPercent, resetAt: null, credential, error: String(error?.message ?? error).slice(0, 220) });
  }
});

server.registerTool('fs_catalog', {
  title: 'Catalogue France Student',
  description: 'Découvre seulement par GET /models, /metrics/chat-streams, /skills, /projects, /mcp/servers ou /filesv2.',
  inputSchema: {
    resource: z.enum(['all', 'models', 'streams', 'capacity', 'skills', 'projects', 'mcpServers', 'files']).default('all'),
  },
}, async ({ resource }) => {
  const st = loadState();
  if (resource === 'models') {
    const [models, agents] = await Promise.all([fetchModelCatalog(st), fetchAgentsAndModels(st).catch(() => null)]);
    const enriched = agents?.ids?.length ? enrichModelsCatalog(agents.ids, agents.metaMap, st, models?.models) : [];
    return asCompactText(compactCatalog({ ...models, enriched }));
  }
  if (resource === 'streams' || resource === 'capacity') return asCompactText(compactCatalog(await fetchChatStreamMetrics(st)));
  if (resource === 'all') {
    const [models, streams, remote] = await Promise.all([
      fetchModelCatalog(st),
      fetchChatStreamMetrics(st),
      fetchRemoteCatalog(st, 'all'),
    ]);
    return asCompactText(compactCatalog({ models, streams, ...remote }));
  }
  return asCompactText(compactCatalog(await fetchRemoteCatalog(st, resource)));
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
  return asCompactText({ ok: true });
});

const transport = new StdioServerTransport();
await server.connect(transport);
