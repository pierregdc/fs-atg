import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearStateCredential,
  resolveStateCredential,
  saveStateCredential,
  stateCredentialStatus,
} from './credential_store.mjs';
import { logEvent } from './logger.mjs';

// Load Windows / OS system root certificates so HTTPS works even when intermediate CAs rely on the OS store.
if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  } catch { /* ignore */ }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ATG = '[ATG]';
export const CONNECTOR_VERSION = '0.7.0';
export const OFFICIAL_API_BASE_URL = 'https://api.francestudent.ai';
export const RULES_PATH = join(__dirname, 'rules', 'AGENTS.md');
export const RECENT_MODEL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const HEAVY_PRIORITY = Object.freeze(['opus', 'fable', 'gpt-6.2-astra', 'gpt-6.2-sol', 'astra', 'gpt-6.1-sol', 'gpt-6-sol', 'kimi-k3']);

// Shared, inspectable connector metadata. It is never account or quota data.
export const MCP_TOOL_CATALOG = Object.freeze([
  { name: 'fs_delegate', label: 'Déléguer', writesWorkspace: false },
  { name: 'fs_job_status', label: 'Suivi', writesWorkspace: false },
  { name: 'fs_logs', label: 'Journal de bord', writesWorkspace: false },
  { name: 'fs_session', label: 'Session', writesWorkspace: false },
  { name: 'fs_quota', label: 'Quota France Student', writesWorkspace: false },
  { name: 'fs_diagnostics', label: 'Diagnostic', writesWorkspace: false },
  { name: 'fs_status', label: 'État du connecteur', writesWorkspace: false },
  { name: 'fs_catalog', label: 'Catalogue', writesWorkspace: false },
  { name: 'fs_cancel', label: 'Annuler', writesWorkspace: false },
]);
export const ANTIGRAVITY_QUOTA_VISIBILITY = Object.freeze({
  available: false,
  source: 'Antigravity /usage',
  message: 'Le connecteur ne peut pas lire le quota du compte Antigravity. Mesurez-le avec /usage avant et après une même tâche.',
});
export const STATE_PATH = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_state.json');
export const LIVE_PATH = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_live.json');
export const SLOT_DIR = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_slots');
export const LIVE_JOB_TTL_MS = 30_000;

export const BASELINE_MODEL_IDS = new Set([
  'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol',
  'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra',
  'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2',
]);

export const DEFAULT_AGENTS = [
  { id: 66, name: 'gpt-5.6-terra', model: 'gpt-5.6-terra', modelProvider: 'openai' },
  { id: 65, name: 'gpt-5.6-luna', model: 'gpt-5.6-luna', modelProvider: 'openai' },
  { id: 64, name: 'gpt-5.6-sol', model: 'gpt-5.6-sol', modelProvider: 'openai' },
  { id: -1001, name: 'GPT 6 Sol', model: 'gpt-6-sol', modelProvider: 'openai' },
  { id: -1002, name: 'GPT 6 Luna', model: 'gpt-6-luna', modelProvider: 'openai' },
  { id: -1003, name: 'GPT 6.1 Sol', model: 'gpt-6.1-sol', modelProvider: 'openai' },
  { id: -1004, name: 'GPT-6 Astra', model: 'gpt-6-astra', modelProvider: 'openai' },
  { id: -1005, name: 'GPT-6.1 Terra', model: 'gpt-6.1-terra', modelProvider: 'openai' },
  { id: -1006, name: 'GPT-6.2 Astra', model: 'gpt-6.2-astra', modelProvider: 'openai' },
  { id: -1007, name: 'GPT-6.2 Sol', model: 'gpt-6.2-sol', modelProvider: 'openai' },
  { id: -2001, name: 'Claude Opus 5.5', model: 'claude-opus-5-5', modelProvider: 'anthropic' },
  { id: -2002, name: 'Claude Haiku 5.5', model: 'claude-haiku-5-5', modelProvider: 'anthropic' },
  { id: -2003, name: 'Claude Sonnet 5.5', model: 'claude-sonnet-5-5', modelProvider: 'anthropic' },
  { id: -2005, name: 'Claude Fable 5.2', model: 'claude-fable-5-2', modelProvider: 'anthropic' },
];

export const DEFAULT_STATE = {
  apiKey: '',
  // Non-secret change marker used to invalidate an in-process Credential
  // Manager cache when another Antigravity surface stores or removes a key.
  credentialVersion: '',
  cutoffPercent: 15,
  mode: 'eco',
  routingProfile: 'quality',
  autoDelegate: true,
  maxParallel: 3,
  showReasoning: true,
  useClientTools: false,
  reuseChat: true,
  contextCompactPercent: 80,
  // Minimal does not inject a project map or the content of files.
  contextMode: 'minimal',
  directChats: {},
  knownModels: {},
  allowedModels: [],
  blockedModels: [],
  tiers: {
    light: ['haiku', 'luna', 'mini', 'nano', 'flash'],
    medium: ['sonnet', 'terra', 'gpt-5.6-sol', 'kimi-k2'],
    heavy: ['fable', 'opus', 'astra', 'gpt-6.2', 'gpt-6-sol', 'gpt-6.1-sol', 'kimi-k3'],
  },
  history: [],
};

export function loadState() {
  try {
    if (existsSync(STATE_PATH)) {
      const raw = readFileSync(STATE_PATH, 'utf-8').replace(/^\uFEFF/, '');
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_STATE };
}

export function saveState(st) {
  const payload = JSON.stringify(st, null, 2);
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(tmp, payload, 'utf-8');
    try {
      renameSync(tmp, STATE_PATH);
    } catch {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      writeFileSync(STATE_PATH, payload, 'utf-8');
    }
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
  return false;
}

/** Keeps rules/AGENTS.md synchronized with the Auto vs Manual toggle in the UI. */
export function syncAgentsRule(autoDelegate = true) {
  const auto = Boolean(autoDelegate);
  const header = auto
    ? 'Pour toute tâche non triviale (génération de code, composant, refactor, debug, plan ou analyse technique) et toute commande France Student, appelle **immédiatement** `fs_delegate` (`contextMode="minimal"`, `waitSeconds=45`) **sans lire les fichiers avant**. Utilise Antigravity seul uniquement pour de micro-éditions (<10 lignes déjà visibles) ou si l’utilisateur refuse France Student.'
    : 'Mode Manuel actif : n’appelle `fs_delegate` **que** si l’utilisateur mentionne explicitement France Student, `@[plugin:fs-atg]` ou une commande (`/send`, `/plan`, `/high`, `/medium`, `/low`, `/eco`, `/fast`, `/logs`). Pour toute commande France Student, appelle immédiatement `fs_delegate` (`contextMode="minimal"`, `waitSeconds=45`).';
  const content = [
    '# France Student [ATG]',
    '',
    header,
    '',
    '- **Lecture seule sur le PC** : France Student n’écrit jamais sur disque ; il renvoie le code et les réponses dans `response`. Récupère ces blocs pour les copier/appliquer dans le workspace ou les compléter sans tout réécrire toi-même (objectif 70–90 % d’économie de tokens).',
    '- **Phrases simples et normales** : formule des consignes claires en langage naturel (1 bloc ou 1 fichier ciblé par appel si complexe).',
    '- **Plan B** : si Plan A échoue ou revient incomplet, relance en `planB: true` avec `parts` (2–4 petits blocs indépendants simples) puis assemble les résultats ; en ultime recours seulement, termine nativement.',
    '- **Journal de bord** : si l’utilisateur signale un problème avec France Student, appelle immédiatement `fs_logs` (et `fs_diagnostics` si besoin).',
    '- N’appelle `fs_job_status` (`waitSeconds=45`) que si `status` est `waiting` ou `running`. `/new` et `/compact` appellent `fs_session`. Ne révèle jamais de clé ; `fs_quota` concerne France Student, `/usage` mesure Antigravity.',
    '',
  ].join('\n');
  mkdirSync(dirname(RULES_PATH), { recursive: true });
  writeFileSync(RULES_PATH, content, 'utf-8');
  logEvent('info', 'core', 'settings.rule_synced', `Règle Antigravity mise à jour : mode ${auto ? 'Automatique' : 'Manuel'}.`, { autoDelegate: auto });
  return { autoDelegate: auto, path: RULES_PATH };
}

/** Allows a deployment to keep its credential outside the local JSON state. */
export function effectiveApiKey(state) {
  return String(process.env.FS_ATG_API_KEY || state?.apiKey || '').trim();
}

// A request necessarily holds its credential in memory while it is in flight.
// Cache only the value read from Windows Credential Manager, never serialize it
// into the state file, and clear it whenever the user changes/removes the key.
let credentialCache = '';
let credentialCacheLoaded = false;
let credentialCacheVersion = '';

function restoreCredentialFields(state, previous) {
  state.apiKey = previous.apiKey;
  if (previous.credentialStorage === undefined) delete state.credentialStorage;
  else state.credentialStorage = previous.credentialStorage;
  if (previous.credentialVersion === undefined) delete state.credentialVersion;
  else state.credentialVersion = previous.credentialVersion;
}

/**
 * Resolves the environment variable, a safely migrated legacy value, or the
 * Windows Credential Manager value.  A plaintext legacy value is removed from
 * the JSON state only after the credential store verifies it and this state has
 * been saved successfully.  If local persistence fails, the legacy field stays
 * intact so that no key can be lost.
 */
export async function resolveApiKey(state) {
  const environment = String(process.env.FS_ATG_API_KEY || '').trim();
  if (environment) return environment;

  const legacy = String(state?.apiKey || '').trim();
  const version = String(state?.credentialVersion || '');
  if (!legacy && credentialCacheLoaded && credentialCacheVersion === version) return credentialCache;

  const previous = {
    apiKey: state?.apiKey,
    credentialStorage: state?.credentialStorage,
    credentialVersion: state?.credentialVersion,
  };
  const result = await resolveStateCredential(state);
  if (result.migrated) {
    state.credentialVersion = randomUUID();
    if (!saveState(state)) {
      restoreCredentialFields(state, previous);
      return legacy;
    }
  }

  // Do not keep an environment credential in a second cache.  It remains the
  // explicit deployment-level override and can change between requests.
  if (result.source === 'windows-credential-manager') {
    credentialCache = result.value;
    credentialCacheLoaded = true;
    credentialCacheVersion = String(state?.credentialVersion || '');
  }
  return result.value;
}

/** A status-only representation suitable for the panel and MCP diagnostics. */
export async function apiCredentialStatus(state) {
  const value = await resolveApiKey(state);
  if (String(process.env.FS_ATG_API_KEY || '').trim()) {
    return { configured: true, storage: 'environment' };
  }
  if (value) {
    return {
      configured: true,
      storage: state?.apiKey ? 'state-file' : 'windows-credential-manager',
    };
  }
  const status = await stateCredentialStatus(state);
  return { configured: Boolean(status.configured), storage: status.storage };
}

/** Stores a new user-entered key without ever persisting it in Windows JSON state. */
export async function saveApiKey(state, value) {
  const result = await saveStateCredential(state, value);
  state.credentialVersion = randomUUID();
  if (!saveState(state)) {
    throw new Error('La clé est protégée, mais l’état local n’a pas pu être mis à jour. Réessaie avant de fermer Antigravity.');
  }
  credentialCache = String(value || '').trim();
  credentialCacheLoaded = true;
  credentialCacheVersion = String(state.credentialVersion);
  return result;
}

/** Removes only the locally managed credential; an environment variable remains untouched. */
export async function removeApiKey(state) {
  await clearStateCredential(state);
  state.credentialVersion = randomUUID();
  if (!saveState(state)) {
    throw new Error('La clé a été retirée du trousseau, mais l’état local n’a pas pu être mis à jour. Réessaie avant de fermer Antigravity.');
  }
  credentialCache = '';
  credentialCacheLoaded = false;
  credentialCacheVersion = '';
}

export function estimateTokens(text) {
  // Deliberately local and approximate: it is an indication before sending,
  // not a billable-usage claim from the provider.
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); reject(new Error('Annulé.')); return; }
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Annulé.')); }, { once: true });
  }
});

function slotLimit(state) {
  return state?.mode === 'eco' ? 1 : Math.max(1, Math.min(6, Number(state?.maxParallel ?? 3)));
}

function clearStaleSlots() {
  try {
    if (!existsSync(SLOT_DIR)) return;
    const now = Date.now();
    for (const entry of readdirSync(SLOT_DIR)) {
      const path = join(SLOT_DIR, entry);
      try {
        // A process that dies cannot release its lease. Two hours is far above
        // normal requests and protects against an orphaned local lock.
        if (now - statSync(path).mtimeMs > 2 * 60 * 60 * 1000) unlinkSync(path);
      } catch { /* another process may have released it */ }
    }
  } catch { /* scheduler is best-effort; the API remains the authority */ }
}

export function globalSlotStatus(state) {
  clearStaleSlots();
  try {
    const active = existsSync(SLOT_DIR) ? readdirSync(SLOT_DIR).filter((name) => name.endsWith('.lease')).length : 0;
    return { active, limit: slotLimit(state) };
  } catch {
    return { active: 0, limit: slotLimit(state) };
  }
}

/**
 * Cross-process semaphore shared by the side panel and the MCP server.
 * It prevents each process from independently opening its own maxParallel
 * streams. File creation with wx is atomic on Windows and POSIX.
 */
export async function acquireGlobalSlot(state, owner, signal) {
  const limit = slotLimit(state);
  mkdirSync(SLOT_DIR, { recursive: true });
  for (;;) {
    clearStaleSlots();
    for (let index = 0; index < limit; index++) {
      const path = join(SLOT_DIR, `slot-${index}.lease`);
      try {
        const fd = openSync(path, 'wx', 0o600);
        closeSync(fd);
        writeFileSync(path, JSON.stringify({ owner, startedAt: Date.now() }), 'utf8');
        let released = false;
        return {
          index,
          release() {
            if (released) return;
            released = true;
            try { unlinkSync(path); } catch { /* already cleared */ }
          },
        };
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
      }
    }
    await sleep(250, signal);
  }
}

/** Accept old array snapshots, but expire them from their file timestamp. */
export function liveJobsFromSnapshot(snapshot, now = Date.now(), modifiedAt = 0) {
  if (Array.isArray(snapshot)) {
    return modifiedAt && now - modifiedAt <= LIVE_JOB_TTL_MS ? snapshot : [];
  }
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.jobs)) return [];
  const heartbeatAt = Number(snapshot.heartbeatAt ?? 0);
  return heartbeatAt && now - heartbeatAt <= LIVE_JOB_TTL_MS ? snapshot.jobs : [];
}

export function readLiveJobs() {
  try {
    if (existsSync(LIVE_PATH)) {
      const data = JSON.parse(readFileSync(LIVE_PATH, 'utf-8'));
      return liveJobsFromSnapshot(data, Date.now(), statSync(LIVE_PATH).mtimeMs);
    }
  } catch { /* ignore */ }
  return [];
}

export function writeLiveJobs(list) {
  try {
    mkdirSync(dirname(LIVE_PATH), { recursive: true });
    writeFileSync(LIVE_PATH, JSON.stringify({ heartbeatAt: Date.now(), jobs: list }, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

export function remainingPercents(obj, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return out;
  if (typeof obj.remainingPercent === 'number') out.push(obj.remainingPercent);
  else if (typeof obj.usedPercent === 'number') out.push(100 - obj.usedPercent);
  const pick = (re) => {
    for (const [k, v] of Object.entries(obj)) if (re.test(k) && typeof v === 'number') return v;
    return undefined;
  };
  const limit = pick(/^(limit|max|quota|budget|total)$/i);
  const used = pick(/^(used|usage|consumed|spent|current)$/i);
  const remaining = pick(/^(remaining|left|available)$/i);
  if (limit && limit > 0) {
    if (remaining !== undefined) out.push((100 * remaining) / limit);
    else if (used !== undefined) out.push(100 * (1 - used / limit));
  }
  for (const v of Object.values(obj)) if (v && typeof v === 'object') remainingPercents(v, out, depth + 1);
  return out;
}

export async function fsJson(state, method, path, body, signal) {
  const apiKey = await resolveApiKey(state);
  if (!apiKey) throw new Error('Aucune clé API / sessionToken enregistré.');
  const base = OFFICIAL_API_BASE_URL;
  const res = await fetch(base + path, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 220);
    throw new Error(`HTTP ${res.status}${txt ? ' — ' + txt : ''}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : undefined;
}

export async function fetchQuotaSnapshot(state) {
  const [usage, tokens] = await Promise.all([
    fsJson(state, 'GET', '/user/usage'),
    fsJson(state, 'GET', '/user/tokenusage').catch(() => undefined),
  ]);
  const chatPct = typeof usage?.chatBudget?.remainingPercent === 'number'
    ? usage.chatBudget.remainingPercent
    : (typeof usage?.chatBudget?.usedPercent === 'number' ? 100 - usage.chatBudget.usedPercent : null);
  const pcts = chatPct !== null ? [chatPct] : [...remainingPercents(usage), ...remainingPercents(tokens)];
  return {
    remainingPct: pcts.length ? Math.max(0, Math.min(100, Math.min(...pcts))) : null,
    resetAt: usage?.chatBudget?.resetAt ?? null,
    powerUpActive: Boolean(usage?.rateLimitPowerUpActive),
    totalTokens: tokens?.totalTokenCount ?? null,
    reasoningTokens: tokens?.reasoningTokenCount ?? null,
    sources: pcts.length,
    at: Date.now(),
  };
}

export function fetchChatContext(state, chatId) {
  return fsJson(state, 'GET', `/chats/${chatId}/context`);
}

export function compactChatContext(state, chatId) {
  return fsJson(state, 'POST', `/chats/${chatId}/context`);
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.models)) return value.models;
  if (Array.isArray(value?.files)) return value.files;
  return [];
}

/**
 * The public catalog endpoints have evolved independently. Keep their raw
 * metadata available without making model routing depend on a single shape.
 */
export async function fetchModelCatalog(state) {
  const [modelsRes, v1Res] = await Promise.all([
    fsJson(state, 'GET', '/models').catch(() => null),
    fsJson(state, 'GET', '/v1/models').catch(() => null),
  ]);
  const v1Created = new Map();
  for (const m of asList(v1Res)) {
    if (m?.id && m.created) v1Created.set(m.id, m.created);
  }
  const primaryList = asList(modelsRes);
  if (primaryList.length) {
    const merged = primaryList.map((m) => ({
      ...m,
      created: m.created || v1Created.get(m.id) || 0,
    }));
    return { available: true, source: '/models', models: merged, raw: modelsRes };
  }
  // Fallback only if /models is empty: exclude Antigravity (ag/*) and WorkBuddy (cb/*) proxies.
  const fsOnly = asList(v1Res).filter((m) => m?.id && !m.id.startsWith('ag/') && !m.id.startsWith('cb/'));
  return {
    available: fsOnly.length > 0,
    source: fsOnly.length ? '/v1/models' : null,
    models: fsOnly,
    raw: v1Res,
  };
}

/** Real server-side stream pressure; local slots remain the safety fallback. */
export async function fetchChatStreamMetrics(state) {
  const metrics = await fsJson(state, 'GET', '/metrics/chat-streams').catch(() => null);
  return { available: metrics !== null, source: '/metrics/chat-streams', metrics };
}

/** Read-only discovery endpoints. Nothing here creates, enables, uploads or deletes remote resources. */
export async function fetchRemoteCatalog(state, resource = 'all') {
  // Endpoint assumptions are deliberately explicit. Each one is a GET-only
  // list call; an unsupported account/version is reported per resource.
  const paths = {
    skills: '/skills',
    projects: '/projects',
    mcpServers: '/mcp/servers',
    files: '/filesv2',
  };
  const requested = resource === 'all' ? Object.keys(paths) : [resource];
  const out = {};
  await Promise.all(requested.map(async (key) => {
    const path = paths[key];
    if (!path) return;
    try {
      const raw = await fsJson(state, 'GET', path);
      out[key] = { available: true, source: path, items: asList(raw), raw };
    } catch (error) {
      // An account may legitimately not expose a beta/catalog endpoint.
      out[key] = { available: false, source: path, items: [], error: String(error?.message ?? error).slice(0, 220) };
    }
  }));
  return out;
}

/** Bounds read-only catalog output so discovery itself never floods an agent context. */
export function compactCatalog(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (depth >= 4) return '[tronqué]';
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => compactCatalog(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) out[key] = compactCatalog(item, depth + 1);
    return out;
  }
  return String(value);
}

export function defaultModelsBundle() {
  const agentMap = new Map();
  const metaMap = new Map();
  const ids = [];
  for (const a of DEFAULT_AGENTS) {
    agentMap.set(a.model, a.id);
    metaMap.set(a.model, {
      id: a.model,
      name: a.name,
      provider: a.modelProvider,
      contextWindow: null,
      isDefault: false,
      apiCreatedAt: null,
    });
    ids.push(a.model);
  }
  return { ids, agentMap, metaMap, available: false, source: 'local-fallback' };
}

function normalizeTimestampMs(raw) {
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) {
    return num > 1e12 ? num : num * 1000;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export async function fetchAgentsAndModels(state) {
  const [agents, fsModels, v1] = await Promise.all([
    fsJson(state, 'GET', '/chats/agents').catch(() => null),
    fsJson(state, 'GET', '/models').catch(() => null),
    fsJson(state, 'GET', '/v1/models').catch(() => null),
  ]);
  const v1Created = new Map();
  for (const m of v1?.data ?? []) {
    if (!m?.id) continue;
    const ts = normalizeTimestampMs(m.created ?? m.createdAt ?? m.addedAt);
    if (ts) v1Created.set(m.id, ts);
  }
  const agentMap = new Map();
  const metaMap = new Map();
  const ids = [];

  // Only France Student chat models (/chats/agents), enriched with real API created dates from /v1/models.
  if (Array.isArray(agents) && agents.length) {
    for (const a of agents) {
      if (a?.isActive === false) continue;
      const modelId = String(a.model || a.name || a.id);
      if (!metaMap.has(modelId)) {
        agentMap.set(modelId, a.id);
        metaMap.set(modelId, {
          id: modelId,
          name: String(a.name || modelId),
          provider: String(a.modelProvider || (modelId.startsWith('claude') ? 'anthropic' : 'openai')),
          contextWindow: typeof a.contextWindow === 'number' ? a.contextWindow : null,
          isDefault: Boolean(a.isDefault),
          apiCreatedAt: normalizeTimestampMs(a.createdAt ?? a.created ?? a.addedAt) ?? v1Created.get(modelId) ?? null,
        });
        ids.push(modelId);
      }
    }
  }

  // Merge any active France Student /models entry not listed in /chats/agents.
  for (const m of asList(fsModels)) {
    if (!m?.id || metaMap.has(m.id)) continue;
    metaMap.set(m.id, {
      id: m.id,
      name: m.name || m.id,
      provider: m.owned_by || (m.id.startsWith('claude') ? 'anthropic' : 'openai'),
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
      isDefault: false,
      apiCreatedAt: normalizeTimestampMs(m.created ?? m.createdAt ?? m.addedAt) ?? v1Created.get(m.id) ?? null,
    });
    ids.push(m.id);
  }

  if (ids.length) {
    return {
      ids,
      agentMap,
      metaMap,
      available: true,
      source: 'francestudent',
    };
  }
  return defaultModelsBundle();
}

/**
 * Enriches the model list with ID, tier, real API creation date when present,
 * local first-seen date otherwise, and a 14-day "Nouveau" badge.
 */
export function enrichModelsCatalog(ids, metaMap, state, apiModelsRaw = [], { persist = true } = {}) {
  const rawMap = new Map();
  for (const item of apiModelsRaw || []) {
    if (item?.id) rawMap.set(item.id, item);
  }
  const known = { ...(state?.knownModels || {}) };
  let changed = false;
  const now = Date.now();
  const tierRank = { heavy: 0, medium: 1, light: 2 };
  const rows = [];

  for (const id of ids || []) {
    const meta = metaMap?.get(id);
    const raw = rawMap.get(id);
    const apiCreatedAt = normalizeTimestampMs(meta?.apiCreatedAt ?? raw?.createdAt ?? raw?.created ?? raw?.addedAt);
    let rec = known[id];
    if (!rec) {
      const isBaseline = BASELINE_MODEL_IDS.has(id);
      rec = {
        firstSeenAt: isBaseline ? null : now,
        baseline: isBaseline,
        ...(apiCreatedAt ? { apiCreatedAt } : {}),
      };
      known[id] = rec;
      changed = true;
    } else if (apiCreatedAt && !rec.apiCreatedAt) {
      rec = { ...rec, apiCreatedAt };
      known[id] = rec;
      changed = true;
    }
    const tier = classifyTier(id, state);
    const addedAt = apiCreatedAt ?? rec.firstSeenAt ?? null;
    const addedSource = apiCreatedAt ? 'api' : (rec.firstSeenAt ? 'detected' : 'unknown');
    const isNew = apiCreatedAt
      ? (now - apiCreatedAt <= RECENT_MODEL_WINDOW_MS)
      : Boolean(!rec.baseline && rec.firstSeenAt && (now - rec.firstSeenAt <= RECENT_MODEL_WINDOW_MS));
    rows.push({
      id,
      name: meta?.name || id,
      provider: meta?.provider || raw?.owned_by || (id.startsWith('claude') ? 'anthropic' : 'openai'),
      tier,
      blocked: !modelIsAllowed(id, state),
      contextWindow: meta?.contextWindow ?? null,
      addedAt,
      addedSource,
      isNew,
    });
  }

  if (changed && state) {
    state.knownModels = known;
    if (persist) saveState(state);
  }

  rows.sort((a, b) => {
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    const tr = (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9);
    if (tr !== 0) return tr;
    return a.id.localeCompare(b.id);
  });
  return rows;
}

const HEAVY = /(architect|refactor|migration|sécurité|security|concurren|optimi[sz]|algorithm|debug|bug|race condition|performance|plusieurs fichiers|full[\s-]?stack|audit|économie|economie)/i;
const CODING_MEDIUM = /(cr[ée]{1,2}|g[ée]n[èe]re|impl[ée]ment|d[ée]velopp|corrig|am[ée]lior|ajout|modifi|composant|interface|script|fonction|classe|endpoint|route|backend|frontend|base de donn|sql|test|build|vid[ée]o|application|\bapi\b|\bapp\b|\bhtml\b|\bcss\b|\bjs\b|\bts\b|\bpy\b)/i;
const LIGHT = /(renomm|rename|commentaire|comment|docstring|readme|typo|formate|format|tradui|translate|lint|import)/i;

export function classifyTier(id, state) {
  const s = String(id).toLowerCase();
  const tiers = state?.tiers ?? DEFAULT_STATE.tiers;
  const has = (pats) => (pats || []).some((p) => s.includes(String(p).toLowerCase()));
  if (has(tiers.heavy)) return 'heavy';
  if (has(tiers.light)) return 'light';
  if (has(tiers.medium)) return 'medium';
  return 'medium';
}

export function groupModelsByTier(available, state, metaMap) {
  const blocked = (state?.blockedModels || []).map((b) => b.toLowerCase());
  const allowed = (state?.allowedModels || []).map((a) => a.toLowerCase());
  const isOk = (id) => {
    const low = id.toLowerCase();
    return (!allowed.length || allowed.some((a) => low.includes(a))) && !blocked.some((b) => low.includes(b));
  };
  const groups = { light: [], medium: [], heavy: [] };
  for (const id of available || []) {
    const t = classifyTier(id, state);
    const meta = metaMap?.get(id);
    groups[t].push({
      id,
      name: meta?.name || id,
      provider: meta?.provider || (id.startsWith('claude') ? 'anthropic' : 'openai'),
      blocked: !isOk(id),
    });
  }
  return groups;
}

export const MISSING_REFUSAL_REASON = 'motif non fourni par le fournisseur';

/** A provider-declared refusal, distinct from transport, quota or tool errors. */
export class ModelRefusalError extends Error {
  constructor(reason, details = {}) {
    super(reason || MISSING_REFUSAL_REASON);
    this.name = 'ModelRefusalError';
    this.code = 'MODEL_REFUSAL';
    this.noResume = true;
    Object.assign(this, details);
  }
}

const REFUSAL_EVENT = /(?:refusal|content[_ -]?filter|safety|policy(?:[_ -]?(?:violation|refusal))?)/i;
const STRUCTURED_REFUSAL_REASON = /(?:content[_ -]?filter|safety\s+policy|policy\s+(?:violation|refusal))/i;
const REFUSAL_TEXT_AT_START = /^(?:(?:(?:i(?:'m|\s+am)|we(?:'re|\s+are))\s+(?:sorry[,\s]+)?(?:but[,\s]+)?\s*(?:cannot|can't|won't))|(?:sorry[,\s]+)?(?:but[,\s]+)?\s*i\s+(?:cannot|can't|won't)|(?:je\s+(?:suis\s+désolé(?:e)?[,\s]+)?(?:mais[,\s]+)?\s*(?:je\s+)?ne\s+(?:peux|suis\s+pas\s+en\s+mesure))|(?:désolé(?:e)?[,\s]+mais\s+je\s+ne\s+peux))/i;

function providerReason(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return '';
  const direct = [value.refusal, value.reason, value.message, value.detail, value.delta, value.message?.refusal, value.message?.reason, value.message?.error?.message, value.error?.message, value.response?.error?.message];
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/** Returns a refusal only for a provider field/type that declares one. */
export function refusalReasonFromEvent(event) {
  const type = String(event?.type ?? '');
  const reason = providerReason(event);
  const finish = String(event?.finish_reason ?? event?.finishReason ?? event?.message?.finish_reason ?? event?.message?.finishReason ?? event?.response?.finish_reason ?? event?.response?.finishReason ?? '');
  const structured = REFUSAL_EVENT.test(type)
    || event?.refusal != null
    || event?.message?.refusal != null
    || event?.response?.refusal != null
    || REFUSAL_EVENT.test(finish)
    || STRUCTURED_REFUSAL_REASON.test(reason);
  return structured ? (reason || MISSING_REFUSAL_REASON) : null;
}

/** A text-only fallback is deliberately conservative: it must begin with an explicit refusal. */
export function refusalReasonFromText(text) {
  const value = String(text ?? '').trim();
  if (!value || value.length > 1800 || /```/.test(value)) return null;
  return REFUSAL_TEXT_AT_START.test(value) ? value : null;
}

function modelIsAllowed(id, state) {
  const low = String(id).toLowerCase();
  const allowed = (state?.allowedModels || []).map((value) => String(value).toLowerCase());
  const blocked = (state?.blockedModels || []).map((value) => String(value).toLowerCase());
  return (!allowed.length || allowed.some((value) => low.includes(value))) && !blocked.some((value) => low.includes(value));
}

/** Ordered fallbacks stay strictly in the original model's tier. */
export function sameTierFallbackModels(currentModel, available, state) {
  const tier = classifyTier(currentModel, state);
  return [...new Set(available || [])].filter((model) => (
    model !== currentModel && modelIsAllowed(model, state) && classifyTier(model, state) === tier
  ));
}

function providerFailure(event, fallback, details = {}) {
  const reason = refusalReasonFromEvent(event);
  const error = reason ? new ModelRefusalError(reason, details) : new Error(providerReason(event) || fallback);
  Object.assign(error, details);
  return error;
}

export const ROUTING_PROFILES = Object.freeze(['eco', 'fast', 'quality', 'security', 'refactor']);

const PROFILE_ALIASES = {
  eco: 'eco', economie: 'eco', economical: 'eco',
  fast: 'fast', rapide: 'fast', speed: 'fast',
  quality: 'quality', qualite: 'quality', qualityfirst: 'quality',
  security: 'security', securite: 'security', secure: 'security',
  refactor: 'refactor', refacto: 'refactor',
};

const TIER_ALIASES = {
  faible: 'light', leger: 'light', light: 'light', low: 'light',
  mid: 'medium', moyen: 'medium', equilibre: 'medium', intermediaire: 'medium', medium: 'medium',
  fort: 'heavy', eleve: 'heavy', puissant: 'heavy', heavy: 'heavy', high: 'heavy',
};

const MODEL_ALIASES = {
  fable: 'fable', opus: 'opus', sonnet: 'sonnet', haiku: 'haiku',
  terra: 'terra', sol: 'sol', luna: 'luna', gpt: 'gpt-', claude: 'claude-',
};

function normalizedDirective(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Normalises a local routing profile; unknown values deliberately stay unset. */
export function normalizeRoutingProfile(value) {
  return PROFILE_ALIASES[normalizedDirective(value)] ?? null;
}

/**
 * Removes only recognised local directives. The remaining text is the human
 * request sent to France Student, so local controls never consume prompt tokens.
 */
export function parseTaskDirectives(raw) {
  let prompt = String(raw ?? '');
  const tag = /^\s*\[([\w.\- ]+)\]\s*/.exec(prompt);
  const tagModel = tag && tag[1].toUpperCase() !== 'ATG' ? tag[1] : undefined;
  if (tagModel) prompt = prompt.slice(tag[0].length);

  let requested;
  let profile = null;
  let executionMode = 'apply';
  // `/plan /security audit src/auth` is valid: all recognised directives are local.
  for (;;) {
    const slash = /^\s*\/([a-zA-ZÀ-ÿ0-9_-]+)(?:\s+|$)/.exec(prompt);
    if (!slash) break;
    const command = normalizedDirective(slash[1]);
    const next = prompt.slice(slash[0].length);
    if (command === 'send') { prompt = next; continue; }
    if (command === 'plan') { executionMode = 'plan'; prompt = next; continue; }
    if (command === 'dry-run' || command === 'dryrun' || command === 'preview') { executionMode = 'dry-run'; prompt = next; continue; }
    if (command === 'apply') { executionMode = 'apply'; prompt = next; continue; }
    const profileValue = normalizeRoutingProfile(command);
    if (profileValue) { profile = profileValue; prompt = next; continue; }
    if (command === 'auto') { requested = { kind: 'auto', value: 'auto' }; prompt = next; continue; }
    if (TIER_ALIASES[command]) { requested = { kind: 'tier', value: TIER_ALIASES[command] }; prompt = next; continue; }
    if (MODEL_ALIASES[command]) { requested = { kind: 'model', value: MODEL_ALIASES[command] }; prompt = next; continue; }
    break;
  }
  return { prompt: prompt.trim(), tagModel, requested, profile, executionMode };
}

/** Non-writing modes may discover local files but never edit or create them. */
export function clientToolsForExecutionMode(clientTools, executionMode = 'apply') {
  const tools = [...new Set(clientTools || [])];
  if (executionMode === 'apply') return tools;
  return tools.filter((name) => ['list_directory', 'read_file', 'search_files'].includes(name));
}

function profileTier(profile, prompt) {
  switch (profile) {
    case 'eco':
      if (HEAVY.test(prompt) || prompt.length > 3500) return 'medium';
      if (CODING_MEDIUM.test(prompt) && !LIGHT.test(prompt)) return 'medium';
      return 'light';
    case 'fast': return CODING_MEDIUM.test(prompt) ? 'medium' : 'light';
    case 'quality':
    case 'security':
    case 'refactor': return 'heavy';
    default: return null;
  }
}

export function pickModel(raw, available, state, explicit) {
  const has = (id, pats) => pats.some((p) => id.toLowerCase().includes(p.toLowerCase()));
  const allowed = state.allowedModels || [];
  const blocked = state.blockedModels || [];
  const pool = available.filter((id) => (!allowed.length || has(id, allowed)) && !has(id, blocked));
  if (!pool.length) throw new Error('Aucun modèle autorisé disponible.');
  const directives = parseTaskDirectives(raw);
  const prompt = directives.prompt;
  const requested = directives.requested;
  const wanted = requested?.kind === 'auto' ? undefined : (requested?.value || explicit || directives.tagModel);
  const wantedNorm = wanted ? normalizedDirective(wanted).replace(/^tier:/, '') : '';
  const forcedTier = requested?.kind === 'tier' ? requested.value : TIER_ALIASES[wantedNorm];
  const profile = directives.profile || normalizeRoutingProfile(state?.routingProfile) || 'auto';

  if (wanted && !forcedTier) {
    const hit = pool.find((id) => has(id, [wanted]));
    if (hit) return { model: hit, prompt, reason: `forcé : ${wanted}`, profile, executionMode: directives.executionMode };
    throw new Error(`Modèle « ${wanted} » indisponible ou bloqué.`);
  }

  const preferredTier = profileTier(profile, prompt);
  const tier = forcedTier || preferredTier || (HEAVY.test(prompt) || prompt.length > 4000 ? 'heavy'
    : LIGHT.test(prompt) && prompt.length < 800 ? 'light' : 'medium');
  const order = tier === 'heavy' ? ['heavy', 'medium', 'light']
    : tier === 'light' ? ['light', 'medium', 'heavy'] : ['medium', 'heavy', 'light'];
  for (const t of order) {
    let hit;
    if (t === 'heavy') {
      const heavyPool = pool.filter((id) => classifyTier(id, state) === 'heavy');
      for (const kw of HEAVY_PRIORITY) {
        hit = heavyPool.find((id) => id.toLowerCase().includes(kw));
        if (hit) break;
      }
      if (!hit) hit = heavyPool[0];
    } else {
      hit = pool.find((id) => classifyTier(id, state) === t);
    }
    if (hit) {
      const label = t === 'light' ? 'faible' : t === 'heavy' ? 'fort' : 'équilibré';
      return {
        model: hit,
        prompt,
        reason: forcedTier ? `catégorie : ${label}`
          : (preferredTier ? `profil ${profile} : ${label}${t !== tier ? ' (repli)' : ''}`
            : `auto : ${label}${t !== tier ? ' (repli)' : ''}`),
        profile,
        executionMode: directives.executionMode,
      };
    }
  }
  return {
    model: pool[0],
    prompt,
    reason: profile === 'auto' ? 'auto : premier modèle autorisé' : `profil ${profile} : premier modèle autorisé`,
    profile,
    executionMode: directives.executionMode,
  };
}

export async function* readSseFrames(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        const id = chunk.split('\n').find((l) => l.startsWith('id:'))?.slice(3).trim();
        if (!data || data === '[DONE]') continue;
        try { yield { id, event: JSON.parse(data) }; } catch { /* line not JSON */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* readSse(stream) {
  for await (const frame of readSseFrames(stream)) yield frame.event;
}

/** Reattach to a chat stream after a transport interruption, when the API supplied an SSE id. */
export async function resumeChatStream(state, chatId, lastEventId, signal) {
  const apiKey = await resolveApiKey(state);
  if (!apiKey || !chatId || !lastEventId) return null;
  const base = OFFICIAL_API_BASE_URL;
  const res = await fetch(`${base}/chats/${encodeURIComponent(chatId)}/stream`, {
    method: 'GET',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
      'Last-Event-ID': String(lastEventId),
    },
  });
  if (!res.ok || !res.body) {
    const txt = (await res.text().catch(() => '')).slice(0, 220);
    const error = new Error(`HTTP ${res.status}${txt ? ' — ' + txt : ''}`);
    error.status = res.status;
    throw error;
  }
  return res;
}

export function resolveSafe(rootDir, rel) {
  const cleaned = String(rel ?? '.').trim() || '.';
  const posixRel = normalize(cleaned.replace(/\\/g, '/')).replace(/^[/\\]+/, '');
  if (posixRel.startsWith('..') || isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new Error(`Chemin refusé (hors workspace) : ${rel}`);
  }
  const normalizedSlash = posixRel === '' ? '.' : posixRel.replace(/\\/g, '/');
  if (/(^|\/)\.git(\/|$)/.test(normalizedSlash) || /(^|\/)\.env/.test(normalizedSlash)) {
    throw new Error(`Chemin protégé : ${rel}`);
  }
  const absRoot = resolve(rootDir);
  const absTarget = resolve(absRoot, normalizedSlash);
  if (absTarget !== absRoot && !absTarget.startsWith(absRoot + '\\') && !absTarget.startsWith(absRoot + '/')) {
    throw new Error(`Chemin refusé (hors workspace) : ${rel}`);
  }
  // Les normalisations de chemin ne résolvent pas les symlinks/junctions Windows.
  // On interdit donc tout parent réel qui sortirait du workspace.
  if (existsSync(absRoot)) {
    const real = realpathSync.native ?? realpathSync;
    const realRoot = real(absRoot);
    let probe = absTarget;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realProbe = real(probe);
    const cleanPath = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
    const rootPath = cleanPath(realRoot);
    const probePath = cleanPath(realProbe);
    if (probePath !== rootPath && !probePath.startsWith(rootPath + '\\') && !probePath.startsWith(rootPath + '/')) {
      throw new Error(`Chemin refusé (lien hors workspace) : ${rel}`);
    }
  }
  return { rel: normalizedSlash, abs: absTarget };
}

function listDirTree(rootDir, relPath, depth, currentDepth = 1, out = []) {
  const { abs } = resolveSafe(rootDir, relPath || '.');
  const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules' || e.name.startsWith('.env')) continue;
    const childAbs = join(abs, e.name);
    const childRel = relative(rootDir, childAbs).replace(/\\/g, '/');
    out.push(e.isDirectory() ? `${childRel}/` : childRel);
    if (out.length >= 400) break;
    if (e.isDirectory() && currentDepth < depth) {
      listDirTree(rootDir, childRel, depth, currentDepth + 1, out);
    }
  }
  return out;
}

/** A small path-only index for the optional intelligent context mode. */
export function workspaceSketch(rootDir, limit = 120) {
  if (!rootDir) return [];
  try {
    return listDirTree(rootDir, '.', 2).slice(0, Math.max(1, Math.min(240, limit)));
  } catch {
    return [];
  }
}

const SYMBOL_INDEX_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.cs', '.php', '.rb', '.swift', '.kt',
]);
const SYMBOL_INDEX_IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache']);
const MAX_SYMBOL_INDEX_FILE_BYTES = 96 * 1024;
const MAX_SYMBOL_INDEX_READ_CHARS = 24 * 1024;

function uniqueIndexValues(values, limit) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function extractSymbolFacts(source) {
  const symbols = [];
  const imports = [];
  const symbolPatterns = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:async\s+def|def|class)\s+([A-Za-z_][\w]*)/gm,
    /^\s*(?:pub\s+)?(?:fn|func|struct|trait|interface|type)\s+([A-Za-z_][\w]*)/gm,
  ];
  for (const pattern of symbolPatterns) {
    for (const match of source.matchAll(pattern)) symbols.push(match[1]);
  }
  const importPatterns = [
    /\b(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm,
  ];
  for (const pattern of importPatterns) {
    for (const match of source.matchAll(pattern)) imports.push(match[1]);
  }
  return { symbols: uniqueIndexValues(symbols, 10), imports: uniqueIndexValues(imports, 8) };
}

function collectSymbolIndexFiles(rootDir, dir, files, maxFiles) {
  if (files.length >= maxFiles) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (files.length >= maxFiles || entry.isSymbolicLink() || entry.name.startsWith('.env')) continue;
    if (SYMBOL_INDEX_IGNORED.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSymbolIndexFiles(rootDir, abs, files, maxFiles);
      continue;
    }
    if (!SYMBOL_INDEX_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    try {
      if (statSync(abs).size <= MAX_SYMBOL_INDEX_FILE_BYTES) files.push(abs);
    } catch { /* file disappeared while indexing */ }
  }
}

/**
 * Builds a deliberately small local symbol/import index for smart context.
 * It transmits identifiers and relative paths only, never source text; minimal
 * and targeted modes do not call this function.
 */
export function workspaceSymbolIndex(rootDir, limit = 40) {
  if (!rootDir) return [];
  const maxEntries = Math.max(1, Math.min(80, Number(limit) || 40));
  try {
    const root = resolveSafe(rootDir, '.').abs;
    const candidates = [];
    collectSymbolIndexFiles(root, root, candidates, Math.min(240, maxEntries * 4));
    const entries = [];
    for (const abs of candidates) {
      if (entries.length >= maxEntries) break;
      try {
        const source = readFileSync(abs, 'utf-8').slice(0, MAX_SYMBOL_INDEX_READ_CHARS);
        const facts = extractSymbolFacts(source);
        if (!facts.symbols.length && !facts.imports.length) continue;
        entries.push({ path: relative(root, abs).replace(/\\/g, '/'), ...facts });
      } catch { /* unreadable/binary source files do not block the task */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Formats an already bounded symbol index without ever including source code. */
export function formatWorkspaceSymbolIndex(entries, maxChars = 6_000) {
  const lines = [];
  let used = 0;
  for (const entry of entries || []) {
    const sections = [];
    if (entry?.symbols?.length) sections.push(`symboles : ${entry.symbols.join(', ')}`);
    if (entry?.imports?.length) sections.push(`imports : ${entry.imports.join(', ')}`);
    if (!sections.length || !entry?.path) continue;
    const line = `${entry.path} — ${sections.join(' ; ')}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function searchInWorkspace(rootDir, query, subPath = '.', maxResults = 50) {
  const { abs } = resolveSafe(rootDir, subPath || '.');
  const needle = String(query).toLowerCase();
  const hits = [];
  const walk = (dir) => {
    if (hits.length >= maxResults) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= maxResults) break;
      if (e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.env')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try {
        if (statSync(full).size > 512 * 1024) continue;
        const lines = readFileSync(full, 'utf-8').split(/\r?\n/);
        const rel = relative(rootDir, full).replace(/\\/g, '/');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.toLowerCase().includes(needle)) {
            hits.push(`${rel}:${i + 1}: ${line.slice(0, 220)}`);
            if (hits.length >= maxResults) break;
          }
        }
      } catch { /* ignore binary/unreadable */ }
    }
  };
  walk(abs);
  return hits.length ? hits.join('\n') : 'Aucun résultat.';
}

export function executeClientTool(rootDir, call, writtenSet) {
  const args = call?.arguments ?? {};
  try {
    switch (call.name) {
      case 'list_directory': {
        const depth = Math.max(1, Math.min(3, Number(args.depth ?? 1)));
        const items = listDirTree(rootDir, args.path ?? '.', depth);
        return { output: items.join('\n') || '(dossier vide)', isError: false };
      }
      case 'read_file': {
        const { abs } = resolveSafe(rootDir, args.path);
        if (statSync(abs).size > 512 * 1024) return { output: 'Fichier trop volumineux : utilise search_files ou une plage ciblée.', isError: true };
        const lines = readFileSync(abs, 'utf-8').split(/\r?\n/);
        const start = Math.max(1, Number(args.start_line ?? 1));
        const end = Math.min(lines.length, Number(args.end_line ?? lines.length), start + 799);
        const numbered = [];
        for (let i = start; i <= end; i++) numbered.push(`${i}: ${lines[i - 1]}`);
        return { output: numbered.join('\n'), isError: false };
      }
      case 'search_files': {
        const max = Math.max(1, Math.min(100, Number(args.max_results ?? 50)));
        return { output: searchInWorkspace(rootDir, String(args.query ?? ''), args.path ?? '.', max), isError: false };
      }
      case 'write_file': {
        const { rel, abs } = resolveSafe(rootDir, args.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, String(args.content ?? ''), 'utf-8');
        writtenSet?.add(rel);
        return { output: `Fichier écrit : ${rel}`, isError: false };
      }
      case 'edit_file': {
        const { rel, abs } = resolveSafe(rootDir, args.path);
        const cur = readFileSync(abs, 'utf-8');
        const oldT = String(args.old_text ?? '');
        const newT = String(args.new_text ?? '');
        if (!oldT || !cur.includes(oldT)) {
          return { output: `old_text introuvable dans ${rel}`, isError: true };
        }
        const next = args.replace_all ? cur.split(oldT).join(newT) : cur.replace(oldT, newT);
        writeFileSync(abs, next, 'utf-8');
        writtenSet?.add(rel);
        return { output: `Fichier modifié : ${rel}`, isError: false };
      }
      default:
        return { output: `Outil non supporté : ${call.name}`, isError: true };
    }
  } catch (e) {
    return { output: String(e?.message ?? e), isError: true };
  }
}

/**
 * Keeps provider-reported usage separate from our local estimate. We never
 * synthesise a billable count when the provider omitted a field.
 */
export function normalizeProviderTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const value = (keys) => {
    for (const key of keys) {
      const candidate = Number(usage[key]);
      if (Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
    return undefined;
  };
  const inputTokens = value(['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokenCount']);
  const outputTokens = value(['output_tokens', 'completion_tokens', 'outputTokens', 'candidatesTokenCount']);
  const totalTokens = value(['total_tokens', 'totalTokens', 'totalTokenCount']);
  const reasoningTokens = value(['reasoning_tokens', 'reasoningTokens', 'reasoningTokenCount']);
  if ([inputTokens, outputTokens, totalTokens, reasoningTokens].every((item) => item === undefined)) return null;
  return {
    source: 'provider',
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/** A local prompt-only estimate before sending, plus provider usage after it responds. */
export function tokenMeasurementForPrompt(prompt, usage) {
  return {
    localPromptEstimateTokens: estimateTokens(prompt),
    providerUsage: normalizeProviderTokenUsage(usage),
  };
}

const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

export async function streamGeneration({
  state,
  model,
  agentMap,
  instructions,
  prompt,
  chatId: existingChatId,
  signal,
  timeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
  onText,
  onReasoning,
  onChatId,
}) {
  const base = OFFICIAL_API_BASE_URL;
  const apiKey = await resolveApiKey(state);
  if (!apiKey) throw new Error('Aucune clé API / sessionToken enregistré.');
  const agentId = agentMap?.get(model);
  const localPromptEstimateTokens = estimateTokens(prompt);

  const timeoutCtrl = new AbortController();
  const timeoutTimer = setTimeout(() => {
    const err = new Error(`Délai dépassé (${Math.round(timeoutMs / 1000)}s).`);
    err.retryable = true;
    timeoutCtrl.abort(err);
  }, Math.max(10_000, Number(timeoutMs) || DEFAULT_STREAM_TIMEOUT_MS));
  const onParentAbort = () => timeoutCtrl.abort(new Error('Annulé.'));
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutTimer);
      throw new Error('Annulé.');
    }
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const effectiveSignal = timeoutCtrl.signal;

  const runOpenAiResponses = async () => {
    const body = {
      model,
      instructions,
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    };
    if (state.showReasoning) body.reasoning = { summary: 'auto' };
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      signal: effectiveSignal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const txt = (await res.text().catch(() => '')).slice(0, 220);
      throw providerFailure({ message: txt }, `HTTP ${res.status}${txt ? ' — ' + txt : ''}`, { status: res.status });
    }
    let text = '';
    let usage = null;
    for await (const ev of readSse(res.body)) {
      if (ev?.type === 'response.output_text.delta') {
        const d = ev.delta ?? '';
        text += d;
        onText?.(d);
      } else if (ev?.type === 'response.reasoning_summary_text.delta') {
        onReasoning?.(ev.delta ?? '');
      } else if (ev?.type === 'response.output_refusal.delta' || ev?.type === 'response.refusal.delta') {
        throw providerFailure(ev, MISSING_REFUSAL_REASON);
      } else if (ev?.type === 'response.completed') {
        usage = ev.response?.usage ?? null;
      } else if (ev?.type === 'response.failed' || ev?.type === 'error') {
        throw providerFailure(ev, 'Échec de génération.');
      }
    }
    const refusal = refusalReasonFromText(text);
    if (refusal) throw new ModelRefusalError(refusal);
    return { text, usage, written: [], tokenMeasurement: tokenMeasurementForPrompt(prompt, usage) };
  };

  // Mode strictement sans écriture ni clientTools : uniquement des phrases normales.
  const runChatStream = async (id, chatIdToUse) => {
    let chatId = chatIdToUse ?? null;
    let totalText = '';
    let lastUsage = null;

    const consumeTurn = async (res, turn = { text: '' }, allowResume = true) => {
      if (!res.ok || !res.body) {
        const txt = (await res.text().catch(() => '')).slice(0, 220);
        throw providerFailure({ message: txt }, `HTTP ${res.status}${txt ? ' — ' + txt : ''}`, { status: res.status, chatId });
      }
      let lastEventId;
      let completed = false;
      try {
        for await (const frame of readSseFrames(res.body)) {
          if (frame.id) lastEventId = frame.id;
          const ev = frame.event;
          if (ev?.type === 'stream.open' && ev.chat_id) {
            chatId = ev.chat_id;
            onChatId?.(chatId);
          } else if (ev?.type === 'response.output_text.delta') {
            const d = ev.delta ?? '';
            turn.text += d;
            totalText += d;
            onText?.(d);
          } else if (ev?.type === 'response.reasoning_summary_text.delta') {
            onReasoning?.(ev.delta ?? '');
          } else if (ev?.type === 'completed' || ev?.type === 'response.completed' || ev?.type === 'stream.completed') {
            const refusal = refusalReasonFromEvent(ev);
            if (refusal) throw new ModelRefusalError(refusal, { chatId });
            completed = true;
            if (!turn.text && ev.message?.content) {
              totalText += (totalText ? '\n' : '') + ev.message.content;
            }
            const tu = ev.message?.tokenUsage;
            if (tu) {
              lastUsage = {
                ...(tu.promptTokenCount !== undefined ? { input_tokens: tu.promptTokenCount } : {}),
                ...(tu.candidatesTokenCount !== undefined ? { output_tokens: tu.candidatesTokenCount } : {}),
                ...(tu.totalTokenCount !== undefined ? { total_tokens: tu.totalTokenCount } : {}),
                ...(tu.reasoningTokenCount !== undefined ? { reasoning_tokens: tu.reasoningTokenCount } : {}),
              };
            }
          } else if (ev?.type === 'response.output_refusal.delta' || ev?.type === 'response.refusal.delta') {
            throw providerFailure(ev, MISSING_REFUSAL_REASON, { chatId });
          } else if (ev?.type === 'error' || ev?.type === 'response.failed') {
            const error = providerFailure(ev, 'Échec de génération.', { chatId });
            error.noResume = true;
            throw error;
          } else if (ev?.type === 'cancelled') {
            const error = new Error('Génération annulée.');
            error.noResume = true;
            throw error;
          }
        }
      } catch (error) {
        if (allowResume && !error?.noResume && chatId && lastEventId && !effectiveSignal.aborted) {
          const resumed = await resumeChatStream(state, chatId, lastEventId, effectiveSignal);
          return consumeTurn(resumed, turn, false);
        }
        throw error;
      }
      if (!completed) {
        const error = new Error('Flux SSE interrompu avant la fin.');
        if (allowResume && chatId && lastEventId && !effectiveSignal.aborted) {
          const resumed = await resumeChatStream(state, chatId, lastEventId, effectiveSignal);
          return consumeTurn(resumed, turn, false);
        }
        throw error;
      }
    };

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    const continuing = Boolean(chatId);
    const initialContent = instructions ? `${instructions}\n\n${prompt}` : prompt;
    const payload = continuing
      ? { content: prompt, agentId: id }
      : { agentId: id, initialContent };

    await consumeTurn(await fetch(base + (continuing ? `/chats/${chatId}` : '/chats/stream'), {
      method: 'POST',
      signal: effectiveSignal,
      headers,
      body: JSON.stringify(payload),
    }));

    const refusal = refusalReasonFromText(totalText);
    if (refusal) throw new ModelRefusalError(refusal, { chatId });

    return {
      text: totalText,
      usage: lastUsage,
      written: [],
      chatId,
      tokenMeasurement: {
        localPromptEstimateTokens,
        providerUsage: normalizeProviderTokenUsage(lastUsage),
      },
    };
  };

  const tryChatCleanly = async (id, chatId) => {
    try {
      return await runChatStream(id, chatId);
    } catch (e) {
      const status = Number(e?.status ?? 0);
      if (chatId && !effectiveSignal.aborted && !(e instanceof ModelRefusalError) && (status === 400 || status === 404 || status === 410 || status >= 500)) {
        logEvent('warn', 'core', 'chat.reset_on_error', `Session ${chatId} réinitialisée après erreur HTTP ${status || '?'} (${model}).`, { model, chatId, status });
        return await runChatStream(id, undefined);
      }
      throw e;
    }
  };

  try {
    if (agentId !== undefined && agentId !== null) {
      return await tryChatCleanly(agentId, existingChatId);
    }
    try {
      return await runOpenAiResponses();
    } catch (e) {
      if (e?.status === 401 && agentMap?.size) {
        const fallbackId = agentMap.values().next().value;
        return await tryChatCleanly(fallbackId, existingChatId);
      }
      throw e;
    }
  } finally {
    clearTimeout(timeoutTimer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Retries refusals, empty completions, timeouts or transient failures up to
 * 3 distinct models total, prioritizing strong models first.
 */
export async function streamGenerationWithRefusalFallback({ availableModels = [], onRetry, ...request }) {
  const tried = new Set();
  const refusals = [];
  let model = request.model;
  let chatId = request.chatId;
  const maxAttempts = 3;

  const pickNextCandidate = (current) => {
    const allowed = [...new Set(availableModels || [])].filter((c) => !tried.has(c) && modelIsAllowed(c, request.state));
    if (!allowed.length) return null;
    const sameTier = sameTierFallbackModels(current, availableModels, request.state).filter((c) => !tried.has(c));
    if (classifyTier(current, request.state) === 'heavy' && sameTier.length) {
      for (const kw of HEAVY_PRIORITY) {
        const hit = sameTier.find((id) => id.toLowerCase().includes(kw));
        if (hit) return hit;
      }
      return sameTier[0];
    }
    for (const kw of HEAVY_PRIORITY) {
      const hit = allowed.find((id) => classifyTier(id, request.state) === 'heavy' && id.toLowerCase().includes(kw));
      if (hit) return hit;
    }
    if (sameTier.length) return sameTier[0];
    for (const t of ['heavy', 'medium', 'light']) {
      const hit = allowed.find((c) => classifyTier(c, request.state) === t);
      if (hit) return hit;
    }
    return allowed[0] ?? null;
  };

  for (;;) {
    tried.add(model);
    const attemptNum = tried.size;
    const t0 = Date.now();
    logEvent('info', 'core', 'stream.attempt', `Essai ${attemptNum}/${maxAttempts} avec ${model}.`, { model, attempt: attemptNum, hasChatId: Boolean(chatId) });
    try {
      const result = await streamGeneration({
        ...request,
        model,
        chatId,
      });
      if (!String(result?.text ?? '').trim()) {
        const emptyErr = new Error('Réponse vide reçue du modèle.');
        emptyErr.retryable = true;
        throw emptyErr;
      }
      logEvent('info', 'core', 'stream.done', `Réponse reçue de ${model} (${result.text.length} car., ${Math.round((Date.now() - t0) / 1000)}s).`, {
        model,
        chars: result.text.length,
        durationMs: Date.now() - t0,
        usage: result.usage ?? null,
      });
      return { ...result, model, refusals, attemptedModels: [...tried] };
    } catch (error) {
      const isRefusal = error instanceof ModelRefusalError;
      const status = Number(error?.status ?? 0);
      const msg = String(error?.message ?? '');
      const isAuthErr = status === 401 || status === 403;
      const isTransient = !isAuthErr && (
        Boolean(error?.retryable) ||
        status === 429 ||
        status >= 500 ||
        /Flux SSE interrompu|Délai dépassé|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)
      );

      if (isRefusal) {
        refusals.push({ model, reason: msg || MISSING_REFUSAL_REASON });
        logEvent('warn', 'core', 'stream.refusal', `Refus sur ${model} : ${msg || MISSING_REFUSAL_REASON}`, { model, attempt: attemptNum });
      } else {
        logEvent('error', 'core', 'stream.error', `Échec sur ${model} : ${msg}`, { model, status: status || null, attempt: attemptNum });
      }
      error.refusals = refusals;
      error.attemptedModels = [...tried];

      if (request.signal?.aborted || (!isRefusal && !isTransient) || tried.size >= maxAttempts) {
        throw error;
      }

      const next = pickNextCandidate(model);
      if (!next) {
        throw error;
      }

      const reason = isRefusal ? (msg || MISSING_REFUSAL_REASON) : msg.slice(0, 120);
      logEvent('warn', 'core', 'stream.fallback', `Bascule ${model} → ${next} (essai ${tried.size + 1}/${maxAttempts}).`, { from: model, to: next, reason });
      onRetry?.({ from: model, to: next, reason, attempt: tried.size + 1 });
      model = next;
      chatId = undefined;
    }
  }
}

/**
 * Estimates Antigravity tokens/turns saved when France Student generates the
 * response/code cleanly so Antigravity only copies/applies it.
 */
export function estimateAntigravityJobSavings(job, { waitedInline = false, partsCount = 1 } = {}) {
  const outputChars = Number(job?.receivedChars ?? 0);
  const offloadedOutputTokens = Math.max(0, Math.round(outputChars / 4));
  const baseTurns = offloadedOutputTokens >= 400 ? 3 : offloadedOutputTokens >= 120 ? 2 : 1;
  const turnsSavedEst = (waitedInline ? 1 : 0) + Math.max(Number(partsCount) || 1, baseTurns);
  const inputTokensSavedEst = turnsSavedEst * 12_000;
  const outputTokensSavedEst = Math.round(offloadedOutputTokens * 1.35);
  return {
    source: 'local-estimate',
    turnsSavedEst,
    inputTokensSavedEst,
    outputTokensSavedEst,
    totalTokensSavedEst: inputTokensSavedEst + outputTokensSavedEst,
  };
}

export function recordAntigravitySavings(state, jobSavings) {
  if (!state || !jobSavings) return state;
  const prev = state.antigravitySavings || {};
  state.antigravitySavings = {
    jobsOffloaded: Number(prev.jobsOffloaded ?? 0) + 1,
    turnsSavedEst: Number(prev.turnsSavedEst ?? 0) + Number(jobSavings.turnsSavedEst ?? 0),
    inputTokensSavedEst: Number(prev.inputTokensSavedEst ?? 0) + Number(jobSavings.inputTokensSavedEst ?? 0),
    outputTokensSavedEst: Number(prev.outputTokensSavedEst ?? 0) + Number(jobSavings.outputTokensSavedEst ?? 0),
    totalTokensSavedEst: Number(prev.totalTokensSavedEst ?? 0) + Number(jobSavings.totalTokensSavedEst ?? 0),
    updatedAt: Date.now(),
  };
  return state;
}

const FILE_RE = /<<<FILE[ \t]+([^\n]+)\n([\s\S]*?)\n?>>>END/g;

export function parseFileBlocks(text) {
  const out = [];
  for (const m of text.matchAll(FILE_RE)) out.push({ path: m[1].trim(), content: m[2] });
  return out;
}

export function stripFileBlocks(text) {
  return text.replace(FILE_RE, (_m, p) => `[fichier : ${p.trim()}]`).trim();
}

export function writeFileBlocks(rootDir, blocks) {
  if (!blocks.length || !rootDir) return [];
  const written = [];
  for (const b of blocks) {
    const { rel, abs } = resolveSafe(rootDir, b.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, b.content, 'utf-8');
    written.push(rel);
  }
  return written;
}
