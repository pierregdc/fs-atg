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
  clientToolsForExecutionMode,
  compactChatContext,
  compactCatalog,
  estimateTokens,
  fetchChatContext,
  fetchChatStreamMetrics,
  fetchModelCatalog,
  fetchRemoteCatalog,
  formatWorkspaceSymbolIndex,
  fetchAgentsAndModels,
  fetchQuotaSnapshot,
  fsJson,
  globalSlotStatus,
  loadState,
  normalizeProviderTokenUsage,
  parseTaskDirectives,
  parseFileBlocks,
  pickModel,
  resolveSafe,
  saveState,
  streamGenerationWithRefusalFallback,
  stripFileBlocks,
  workspaceSymbolIndex,
  workspaceSketch,
  writeFileBlocks,
  writeLiveJobs,
} from './fs_core.mjs';
import { applyReview, stageReview, undoReview } from './review_store.mjs';

const TOOL_INSTRUCTIONS = `Exécute la demande dans le workspace.
- Lis seulement les fichiers et lignes indispensables ; ignore le reste du projet.
- Utilise les outils de fichier pour modifier le code, sans recopier de source dans la réponse.
- Vérifie les fichiers touchés puis réponds en trois lignes : résultat, fichiers, tests.`;

const FALLBACK_INSTRUCTIONS = `Exécute cette demande de développement pour un projet local.
- Commence par un résumé court (3 lignes maximum).
- Pour chaque fichier créé ou modifié, donne son contenu COMPLET dans ce format exact :
<<<FILE chemin/relatif/au/workspace
contenu
>>>END
- Si un bloc <<<PATCH chemin>>>END est fourni, il met à jour la version déjà envoyée dans ce chat ; ne le traite pas comme un fichier complet.
- Aucun autre bloc de code ni chemin hors du workspace.`;

const PLAN_INSTRUCTIONS = `Réponds comme à une demande de développement normale, mais ne modifie aucun fichier.
- Analyse uniquement les fichiers et lignes nécessaires.
- Donne un plan concret, les fichiers concernés, les risques et les vérifications à effectuer.
- Ne produis aucun bloc <<<FILE ...>>>END et n’exécute aucune écriture.`;

const REVIEW_INSTRUCTIONS = `Prépare une modification de code sans écrire dans le workspace.
- Consulte uniquement les fichiers et lignes nécessaires.
- Pour chaque fichier à créer ou modifier, retourne son contenu complet dans ce format exact :
<<<FILE chemin/relatif/au/workspace
contenu
>>>END
- Commence par un résumé bref et les vérifications prévues. Aucun chemin hors du workspace.`;

const FINAL = new Set(['done', 'review', 'undone', 'error', 'cancelled']);
const EXECUTION_MODES = new Set(['apply', 'plan', 'dry-run']);
const ROUTING_PROFILES = new Set(['eco', 'fast', 'quality', 'security', 'refactor']);
const jobs = new Map();
const running = new Map();
const queue = [];
const listeners = new Set();
const contextFileCache = new Map();
const diagnosticState = { lastApiError: null, lastApiAt: null, lastModelsError: null, lastModelsAt: null };

function notify() {
  const live = [...jobs.values()].map(publicView);
  writeLiveJobs(live);
  for (const fn of listeners) fn();
}

// A job can spend time in a provider stream without emitting a delta. Keep
// the cross-process view fresh, but do not keep an idle stdio MCP alive.
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
    // Le contrôle de contexte est un confort : ne bloque pas un chat valide s'il est indisponible.
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
  const routingProfile = ROUTING_PROFILES.has(profile) ? profile : (ROUTING_PROFILES.has(st.routingProfile) ? st.routingProfile : 'eco');
  return { ...st, routingProfile };
}

function compactPatch(previous, next) {
  if (previous === next) return '';
  const before = previous.split('\n');
  const after = next.split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) { beforeEnd--; afterEnd--; }
  const removed = before.slice(start, Math.min(beforeEnd + 1, start + 45));
  const added = after.slice(start, Math.min(afterEnd + 1, start + 45));
  const lines = [`@@ ligne ${start + 1} @@`, ...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)];
  if (beforeEnd - start + 1 > removed.length || afterEnd - start + 1 > added.length) lines.push('…');
  return lines.join('\n');
}

/**
 * Old accounts without clientTools may need selected file content. For a
 * persistent chat, reuse an in-memory baseline and send a compact patch only
 * when it is demonstrably smaller. No source content is persisted for this
 * optimisation, so a fresh process/chat always receives a complete baseline.
 */
function addLegacyFileContext(prompt, job, hasPersistentChat) {
  if (!job.files?.length || !job.workspaceRoot) return prompt;
  let remaining = 48_000;
  const chunks = [];
  for (const rel of job.files.slice(0, 12)) {
    const { abs } = resolveSafe(job.workspaceRoot, rel);
    const content = readFileSync(abs, 'utf-8');
    const key = `${resolve(job.workspaceRoot).toLowerCase()}::${rel}`;
    const previous = contextFileCache.get(key);
    const patch = hasPersistentChat && typeof previous === 'string' ? compactPatch(previous, content) : '';
    const usePatch = Boolean(patch) && patch.length < content.length * 0.7;
    const payload = usePatch
      ? `<<<PATCH ${rel}\n${patch}\n>>>END`
      : `<<<FILE ${rel}\n${content.slice(0, Math.max(0, remaining))}${content.length > remaining ? '\n[tronqué]' : ''}\n>>>END`;
    remaining -= usePatch ? patch.length : Math.min(content.length, Math.max(0, remaining));
    contextFileCache.set(key, content);
    chunks.push(payload);
    if (remaining <= 0) break;
  }
  return chunks.length ? `${prompt}\n\nContexte de fichiers sélectionnés :\n${chunks.join('\n\n')}` : prompt;
}

function instructionFor(job, useClientTools) {
  if (job.executionMode === 'plan') return PLAN_INSTRUCTIONS;
  if (job.executionMode === 'dry-run') return REVIEW_INSTRUCTIONS;
  return job.workspaceRoot && useClientTools ? TOOL_INSTRUCTIONS : FALLBACK_INSTRUCTIONS;
}

function toolsFor(job, useClientTools) {
  if (!job.workspaceRoot || !useClientTools) return undefined;
  return clientToolsForExecutionMode(
    ['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file'],
    job.executionMode,
  );
}

/**
 * Only paths are sent in targeted mode.  Smart adds a very small local tree;
 * it never reads a whole source file before the model explicitly asks for it.
 */
function addLocalContext(prompt, job, st, hasPersistentChat = false) {
  const mode = contextModeOf(job, st);
  let next = prompt;
  // A persistent France Student chat already has the prior turn. Re-sending
  // its summary wastes input tokens and can make stale information look new.
  if (job.parentId && !hasPersistentChat) {
    const parent = st.history?.find((h) => h.id === job.parentId);
    if (parent) {
      next = `Contexte bref de la tâche précédente :\n${String(parent.summary || '').slice(0, 1200)}\n` +
        `Fichiers touchés : ${(parent.written || []).slice(0, 20).join(', ') || 'aucun'}\n\nNouvelle demande : ${next}`;
    }
  }
  if (!job.workspaceRoot) return { prompt: next, mode };
  if (mode !== 'minimal' && job.files?.length) {
    next += `\n\nFichiers ciblés : ${job.files.slice(0, 30).join(', ')}. Lis uniquement les plages utiles avec read_file.`;
  }
  if (mode === 'smart') {
    const index = formatWorkspaceSymbolIndex(workspaceSymbolIndex(job.workspaceRoot, 40), 4_000);
    if (index) next += `\n\nIndex local de symboles et imports (sans code source, non exhaustif) :\n${index}`;
    // Some projects do not expose parseable symbols. Paths remain a bounded,
    // source-free fallback rather than attaching the whole project.
    else {
      const sketch = workspaceSketch(job.workspaceRoot, 40);
      if (sketch.length) next += `\n\nPlan local (chemins seulement, non exhaustif) :\n${sketch.join('\n')}`;
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
    return { ok: true, action, chatId: null, message: 'La prochaine demande ouvrira une nouvelle session.' };
  }
  if (!chatId) return { ok: true, action, chatId: null, usagePercent: null, message: 'Aucune session active.' };
  if (action === 'compact') await compactChatContext(st, chatId);
  const context = await fetchChatContext(st, chatId).catch(() => ({}));
  return { ok: true, action, chatId, usagePercent: context?.usagePercent ?? null };
}

/** Read-only health snapshot. It deliberately returns statuses, never credentials. */
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
    }
    try {
      const bundle = await fetchAgentsAndModels(st);
      models = { available: Boolean(bundle.available), source: bundle.source ?? 'unknown', count: bundle.ids?.length ?? 0 };
      diagnosticState.lastModelsAt = Date.now();
      diagnosticState.lastModelsError = null;
    } catch (error) {
      diagnosticState.lastModelsAt = Date.now();
      diagnosticState.lastModelsError = String(error?.message ?? error).slice(0, 220);
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
  };
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
    elapsedSec: j.startedAt ? Math.round((end - j.startedAt) / 1000) : 0,
    receivedChars: j.receivedChars,
    summary: j.summary,
    filesWritten: j.written ?? [],
    lastThoughts: (j.thoughts || []).slice(-3),
    error: j.error,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    usage,
    tokenUsage: {
      // This is a local character-based estimate before the request, never a bill.
      inputEstimateTokens: tokenMeasurement.localPromptEstimateTokens ?? j.inputEstimateTokens ?? null,
      // These fields are populated only when the provider returns usage.
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
  const st = loadState();
  st.history = [{ ...job, thoughts: job.thoughts.slice(-5) }, ...(st.history || [])].slice(0, 30);
  saveState(st);
  notify();
  pump();
}

function storedJob(jobId) {
  const st = loadState();
  const job = st.history?.find((entry) => entry.id === jobId || entry.jobId === jobId);
  if (!job) throw new Error('Job introuvable dans l’historique.');
  return { st, job };
}

function saveStoredJob(st, job) {
  saveState(st);
  notify();
  return publicView(job);
}

function applyStoredReview(jobId) {
  const { st, job } = storedJob(jobId);
  if (!job.review?.id) throw new Error('Ce job ne contient aucune revue à appliquer.');
  job.review = applyReview(job.review.id);
  job.status = 'done';
  job.written = job.review.files.map((file) => file.path);
  job.reviewUnavailable = null;
  job.summary = `${String(job.summary || '').trim()}\n\nRevue appliquée après validation.`.trim();
  return saveStoredJob(st, job);
}

function undoStoredReview(jobId) {
  const { st, job } = storedJob(jobId);
  if (!job.review?.id) throw new Error('Ce job ne contient aucune revue à restaurer.');
  job.review = undoReview(job.review.id);
  job.status = 'undone';
  job.written = [];
  job.summary = `${String(job.summary || '').trim()}\n\nRevue restaurée sans écraser de modification ultérieure.`.trim();
  return saveStoredJob(st, job);
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
      throw new Error(`Coupe-circuit : il reste ${q.remainingPct.toFixed(0)} % (seuil ${st.cutoffPercent} %).`);
    }

    const { ids, agentMap } = await fetchAgentsAndModels(st);
    const route = pickModel(job.rawTask ?? job.task, ids, st, job.explicitModel);
    job.model = route.model;
    job.routeReason = route.reason;
    job.routingProfile = route.profile === 'auto' ? null : route.profile;
    job.executionMode = job.executionMode ?? route.executionMode ?? 'apply';
    notify();

    const key = directSessionKey(job);
    // Drafts and plans deliberately do not alter the persistent coding chat.
    const chatId = job.executionMode === 'apply' ? await prepareDirectChat(st, key) : undefined;
    if (chatId) job.chatId = chatId;

    const local = addLocalContext(route.prompt, job, st, Boolean(chatId));
    let prompt = local.prompt;
    job.contextMode = local.mode;
    const useClientTools = Boolean(job.workspaceRoot && st.useClientTools !== false);
    if (!useClientTools) prompt = addLegacyFileContext(prompt, job, Boolean(chatId));
    job.inputEstimateTokens = estimateTokens(prompt);

    job.status = 'waiting';
    job.thoughts.push('En attente d’un créneau France Student partagé.');
    notify();
    const lease = await acquireGlobalSlot(st, `mcp-${job.id}`, ac.signal);
    job.slot = lease.index + 1;
    job.status = 'running';
    job.startedAt = Date.now();
    notify();

    let liveText = '';
    let lastPush = 0;
    let result;
    try {
      result = await streamGenerationWithRefusalFallback({
      state: st,
      model: route.model,
      availableModels: ids,
      agentMap,
      instructions: instructionFor(job, useClientTools),
      prompt,
      chatId,
      workspaceRoot: job.workspaceRoot,
      clientTools: toolsFor(job, useClientTools),
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
      onRetry: ({ from, to, reason }) => {
        job.refusals = [...(job.refusals ?? []), { model: from, reason, retryModel: to }];
        job.model = to;
        job.routeReason = `${route.reason} · repli ${from} → ${to}`;
        job.thoughts.push(`Reprise avec ${to} après refus de ${from}.`);
        job.thoughts = job.thoughts.slice(-20);
        notify();
      },
      });
    } finally {
      lease.release();
    }
    flushThought();

    job.chatId = result.chatId ?? job.chatId;
    if (job.executionMode === 'apply') rememberDirectChat(key, result.chatId);
    job.model = result.model ?? job.model;
    job.refusals = result.refusals ?? job.refusals ?? [];
    job.attemptedModels = result.attemptedModels ?? job.attemptedModels;
    job.tokenMeasurement = result.tokenMeasurement ?? {
      localPromptEstimateTokens: job.inputEstimateTokens,
      providerUsage: normalizeProviderTokenUsage(result.usage),
    };

    const blocks = parseFileBlocks(result.text);
    if (job.executionMode === 'dry-run') {
      job.written = [];
      if (blocks.length && job.workspaceRoot) {
        job.review = stageReview(job.workspaceRoot, blocks);
        job.summary = stripFileBlocks(result.text).slice(0, 2000);
        job.usage = result.usage;
        finishJob(job, 'review');
        return;
      }
      job.reviewUnavailable = blocks.length
        ? 'Une revue avec diff exige un workspace local.'
        : 'Aucun fichier proposé : aucune revue à appliquer.';
    } else if (job.executionMode === 'apply') {
      const blockWritten = job.workspaceRoot ? writeFileBlocks(job.workspaceRoot, blocks) : [];
      job.written = [...new Set([...(result.written ?? []), ...blockWritten])];
    } else {
      job.written = [];
    }
    job.summary = stripFileBlocks(result.text).slice(0, 2000);
    job.usage = result.usage;
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
const server = new McpServer({ name: 'fs-atg', version: CONNECTOR_VERSION });

server.registerTool('fs_delegate', {
  title: 'Déléguer à France Student [ATG]',
  description: 'Confie une tâche de code à France Student. Par défaut, apply peut écrire dans workspaceRoot. /plan est strictement sans écriture ; /dry-run prépare un diff à valider avec fs_apply_review. Asynchrone : renvoie un jobId, puis appelle fs_job_status.',
  inputSchema: {
    task: z.string().min(3).describe('Consigne précise. Commandes locales : /send, /plan, /dry-run, /eco, /fast, /low, /medium, /high.'),
    workspaceRoot: z.string().optional().describe('Chemin absolu du workspace où écrire les fichiers générés.'),
    files: z.array(z.string()).optional().describe('Chemins relatifs au workspace à joindre.'),
    model: z.string().optional(),
    priority: z.number().int().min(0).max(9).optional(),
    contextMode: z.enum(['minimal', 'targeted', 'smart']).optional().describe('minimal = demande seule ; targeted = chemins choisis ; smart = petit plan de fichiers.'),
    parentJobId: z.string().optional().describe("Suite d'un job : seul son résumé est réutilisé."),
    executionMode: z.enum(['apply', 'plan', 'dry-run']).optional().describe('apply écrit si nécessaire ; plan et dry-run interdisent toute écriture.'),
    routingProfile: z.enum(['eco', 'fast', 'quality', 'security', 'refactor']).optional().describe('Profil de routage local, retiré de la demande envoyée.'),
  },
}, async (a) => {
  const delegation = normalizedDelegation(a.task, a.executionMode, a.routingProfile);
  if (!delegation.task) throw new Error('Consigne vide après les commandes locales.');
  const firstLine = delegation.task.split('\n')[0];
  const job = {
    id: randomUUID().slice(0, 8),
    title: `${ATG} ${firstLine.slice(0, 70)}${firstLine.length > 70 ? '…' : ''}`,
    task: delegation.task,
    rawTask: delegation.rawTask,
    workspaceRoot: a.workspaceRoot,
    files: a.files ?? [],
    explicitModel: a.model,
    parentId: a.parentJobId,
    priority: a.priority ?? 5,
    contextMode: a.contextMode,
    executionMode: delegation.executionMode,
    routingProfile: delegation.routingProfile,
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

server.registerTool('fs_session', {
  title: 'Session France Student',
  description: 'Affiche, compacte ou renouvelle la session persistante. /compact et /new dans le chat Antigravity doivent appeler cet outil.',
  inputSchema: {
    action: z.enum(['status', 'compact', 'new']).default('status'),
    workspaceRoot: z.string().optional(),
  },
}, async ({ action, workspaceRoot }) => asText(await sessionAction(action, workspaceRoot)));

server.registerTool('fs_job_status', {
  title: "État d'un job [ATG]",
  description: "Attend jusqu'à waitSeconds que le job finisse, puis renvoie son état, son résumé et les fichiers écrits.",
  inputSchema: { jobId: z.string(), waitSeconds: z.number().min(0).max(45).optional() },
}, async ({ jobId, waitSeconds }) => {
  const job = await waitFor(jobId, (waitSeconds ?? 30) * 1000);
  return asText(job ? publicView(job) : { error: 'jobId inconnu' });
});

server.registerTool('fs_apply_review', {
  title: 'Appliquer une revue [ATG]',
  description: 'Applique les fichiers d’un dry-run déjà validé. Refuse toute écriture si un fichier a changé depuis le diff.',
  inputSchema: { jobId: z.string().describe('jobId retourné par fs_delegate en mode /dry-run.') },
}, async ({ jobId }) => asText({ ok: true, job: applyStoredReview(jobId) }));

server.registerTool('fs_undo_review', {
  title: 'Restaurer une revue [ATG]',
  description: 'Restaure le snapshot borné d’une revue appliquée. Refuse d’écraser un fichier modifié après application.',
  inputSchema: { jobId: z.string().describe('jobId du dry-run appliqué.') },
}, async ({ jobId }) => asText({ ok: true, job: undoStoredReview(jobId) }));

server.registerTool('fs_status', {
  title: 'État du connecteur France Student [ATG]',
  description: 'Retourne sans appel fournisseur le transport MCP, la version, les outils publiés et la limite de lecture du quota Antigravity.',
  inputSchema: {},
}, async () => {
  const st = loadState();
  return asText({
    mcp: { ...connectorSnapshot(st), activeJobs: jobs.size, queuedJobs: queue.length },
    antigravityQuota: ANTIGRAVITY_QUOTA_VISIBILITY,
  });
});

server.registerTool('fs_diagnostics', {
  title: 'Diagnostic France Student [ATG]',
  description: 'Vérifie de façon non destructive le trousseau, l’API, les modèles, le quota France Student, la session et les créneaux MCP. Indique explicitement que le quota Antigravity reste mesurable via /usage. Ne révèle jamais la clé.',
  inputSchema: {},
}, async () => asText(await diagnosticsSnapshot()));

server.registerTool('fs_quota', {
  title: 'Quota France Student',
  description: 'Pourcentage de quota restant et seuil du coupe-circuit.',
  inputSchema: {},
}, async () => {
  const st = loadState();
  const credential = await apiCredentialStatus(st);
  if (!credential.configured) {
    return asText({ remainingPct: null, cutoff: st.cutoffPercent, resetAt: null, credential, error: 'Aucun identifiant France Student configuré.' });
  }
  try {
    const q = await fetchQuotaSnapshot(st);
    return asText({ remainingPct: q.remainingPct, cutoff: st.cutoffPercent, resetAt: q.resetAt, credential });
  } catch (error) {
    return asText({ remainingPct: null, cutoff: st.cutoffPercent, resetAt: null, credential, error: String(error?.message ?? error).slice(0, 220) });
  }
});

server.registerTool('fs_catalog', {
  title: 'Catalogue France Student',
  description: 'Découvre seulement par GET /models, /metrics/chat-streams, /skills, /projects, /mcp/servers ou /filesv2. Ne crée, n’active, ne téléverse et ne supprime rien.',
  inputSchema: {
    resource: z.enum(['all', 'models', 'streams', 'capacity', 'skills', 'projects', 'mcpServers', 'files']).default('all'),
  },
}, async ({ resource }) => {
  const st = loadState();
  if (resource === 'models') return asText(compactCatalog(await fetchModelCatalog(st)));
  if (resource === 'streams' || resource === 'capacity') return asText(compactCatalog(await fetchChatStreamMetrics(st)));
  if (resource === 'all') {
    const [models, streams, remote] = await Promise.all([
      fetchModelCatalog(st),
      fetchChatStreamMetrics(st),
      fetchRemoteCatalog(st, 'all'),
    ]);
    return asText(compactCatalog({ models, streams, ...remote }));
  }
  return asText(compactCatalog(await fetchRemoteCatalog(st, resource)));
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
