import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearStateCredential,
  clearWebSession,
  readWebSession,
  resolveStateCredential,
  saveStateCredential,
  saveWebSession,
  stateCredentialStatus,
} from './credential_store.mjs';
import { logEvent } from './logger.mjs';
import { fitToolOutputs, PERMISSION_MODES } from './tools_engine.mjs';

// Load Windows / OS system root certificates so HTTPS works even when intermediate CAs rely on the OS store.
if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  } catch { /* ignore */ }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ATG = '[ATG]';
export const CONNECTOR_VERSION = '2.1.0';
export const OFFICIAL_API_BASE_URL = 'https://api.francestudent.ai';
export const OFFICIAL_WEB_ORIGIN = 'https://ia.francestudent.org';
export const SESSION_COOKIE_NAMES = Object.freeze(['__Secure-next-auth.session-token', 'next-auth.session-token']);
const TOKEN_REFRESH_MARGIN_MS = 60_000;
export const RULES_PATH = join(__dirname, 'rules', 'AGENTS.md');
export const RECENT_MODEL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const HEAVY_PRIORITY = Object.freeze(['opus', 'gpt-6.2-astra', 'gpt-6.2-sol', 'astra', 'gpt-6.1-sol', 'gpt-6-sol', 'fable', 'kimi-k3']);
export const MEDIUM_PRIORITY = Object.freeze(['sonnet', 'gpt-5.6-sol', 'terra']);
export const LIGHT_PRIORITY = Object.freeze(['haiku', 'gpt-6-luna', 'luna']);
const TIER_PRIORITY = { heavy: HEAVY_PRIORITY, medium: MEDIUM_PRIORITY, light: LIGHT_PRIORITY };

export const COOLDOWN_DURATION_MS = 10 * 60 * 1000;
export const UNAVAILABLE_REASON = 'IA non dispo';
export const MODEL_POLICIES = Object.freeze(['allow', 'ask', 'deny']);

const modelCooldowns = new Map();
let globalCooldownMemory = null;

export function recordModelCooldown(modelId, message = '', reason = UNAVAILABLE_REASON) {
  if (!modelId) return;
  let until = Date.now() + COOLDOWN_DURATION_MS;
  const m = /Reset at (\S+?Z)/i.exec(String(message));
  if (m) {
    const parsed = Date.parse(m[1]);
    if (Number.isFinite(parsed) && parsed > Date.now() && parsed - Date.now() <= 2 * 3600_000) {
      until = parsed;
    }
  }
  const entry = { until, reason: reason || UNAVAILABLE_REASON, detail: String(message || '').slice(0, 140) };
  modelCooldowns.set(modelId, entry);
  try {
    const st = loadState();
    st.modelCooldowns = { ...(st.modelCooldowns || {}), [modelId]: entry };
    saveState(st);
  } catch { /* ignore */ }
}

export function getModelCooldown(modelId) {
  let entry = modelCooldowns.get(modelId);
  if (!entry) {
    try {
      const st = loadState();
      entry = st?.modelCooldowns?.[modelId] || null;
      if (entry) modelCooldowns.set(modelId, entry);
    } catch { /* ignore */ }
  }
  if (!entry) return null;
  const until = typeof entry === 'number' ? entry : Number(entry.until || 0);
  if (Date.now() >= until) {
    modelCooldowns.delete(modelId);
    return null;
  }
  return {
    until,
    remainingSec: Math.max(1, Math.ceil((until - Date.now()) / 1000)),
    reason: (typeof entry === 'object' && entry.reason) ? entry.reason : UNAVAILABLE_REASON,
    detail: (typeof entry === 'object' && entry.detail) ? entry.detail : '',
  };
}

export function isModelOnCooldown(modelId) {
  return Boolean(getModelCooldown(modelId));
}

export function recordGlobalCooldown(reason = UNAVAILABLE_REASON, detail = '') {
  const until = Date.now() + COOLDOWN_DURATION_MS;
  const entry = {
    until,
    reason: reason || UNAVAILABLE_REASON,
    detail: String(detail || '').slice(0, 160),
    at: Date.now(),
  };
  globalCooldownMemory = entry;
  try {
    const st = loadState();
    st.globalCooldown = entry;
    saveState(st);
  } catch { /* ignore */ }
  logEvent('error', 'core', 'cooldown.global', `Cooldown 10 min activé : ${entry.reason}`, entry);
  return entry;
}

export function clearGlobalCooldown() {
  globalCooldownMemory = null;
  modelCooldowns.clear();
  try {
    const st = loadState();
    if (st.globalCooldown || st.modelCooldowns) {
      delete st.globalCooldown;
      delete st.modelCooldowns;
      saveState(st);
    }
  } catch { /* ignore */ }
}

export function getGlobalCooldown(state = null) {
  const st = state || (() => { try { return loadState(); } catch { return null; } })();
  const entry = globalCooldownMemory || st?.globalCooldown || null;
  if (!entry || !entry.until) return { active: false, reason: null, until: null, remainingSec: 0 };
  if (Date.now() >= Number(entry.until)) {
    globalCooldownMemory = null;
    try {
      const latest = loadState();
      if (latest.globalCooldown) {
        delete latest.globalCooldown;
        saveState(latest);
      }
    } catch { /* ignore */ }
    return { active: false, reason: null, until: null, remainingSec: 0 };
  }
  const remainingSec = Math.max(1, Math.ceil((Number(entry.until) - Date.now()) / 1000));
  return {
    active: true,
    reason: entry.reason || UNAVAILABLE_REASON,
    detail: entry.detail || '',
    until: Number(entry.until),
    remainingSec,
  };
}

export function getModelPolicy(id, state) {
  const explicit = state?.modelPolicies?.[id];
  if (MODEL_POLICIES.includes(explicit)) return explicit;
  const low = String(id).toLowerCase();
  const allowed = (state?.allowedModels || []).map((value) => String(value).toLowerCase()).filter(Boolean);
  const blocked = (state?.blockedModels || []).map((value) => String(value).toLowerCase()).filter(Boolean);
  if ((allowed.length && !allowed.some((value) => low.includes(value))) || blocked.some((value) => low.includes(value))) {
    return 'deny';
  }
  return 'allow';
}

export function modelIsAllowed(id, state, { allowAsk = false } = {}) {
  const p = getModelPolicy(id, state);
  return allowAsk ? p !== 'deny' : p === 'allow';
}

export function rankModelsBestToWorst(models = [], state = null, { includeAsk = false, approvedModel = null } = {}) {
  const unique = [...new Set(models || [])].filter((id) => {
    const p = getModelPolicy(id, state);
    return p === 'allow' || (p === 'ask' && (includeAsk || approvedModel === id));
  });
  const ordered = [];
  const seen = new Set();
  for (const tier of ['heavy', 'medium', 'light']) {
    const tierPool = unique.filter((id) => classifyTier(id, state) === tier);
    const prio = TIER_PRIORITY[tier] || [];
    for (const kw of prio) {
      for (const id of tierPool) {
        if (!seen.has(id) && id.toLowerCase().includes(kw)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }
    for (const id of tierPool) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  for (const id of unique) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

function pickTierCandidate(pool, tier, state) {
  const tierPool = pool.filter((id) => classifyTier(id, state) === tier);
  const ready = tierPool.filter((id) => !isModelOnCooldown(id));
  const candidates = ready.length ? ready : tierPool;
  for (const kw of TIER_PRIORITY[tier] || []) {
    const hit = candidates.find((id) => id.toLowerCase().includes(kw));
    if (hit) return hit;
  }
  return candidates[0] ?? null;
}

// Shared, inspectable connector metadata. It is never account or quota data.
export const MCP_TOOL_CATALOG = Object.freeze([
  { name: 'fs_delegate', label: 'Déléguer', writesWorkspace: true },
  { name: 'fs_job_status', label: 'Suivi', writesWorkspace: false },
  { name: 'fs_undo', label: 'Annuler (/undo)', writesWorkspace: true },
  { name: 'fs_memory', label: 'Mémoire projet', writesWorkspace: false },
  { name: 'fs_logs', label: 'Journal de bord', writesWorkspace: false },
  { name: 'fs_session', label: 'Session', writesWorkspace: false },
  { name: 'fs_quota', label: 'Quota France Student', writesWorkspace: false },
  { name: 'fs_diagnostics', label: 'Diagnostic', writesWorkspace: false },
  { name: 'fs_status', label: 'État du connecteur', writesWorkspace: false },
  { name: 'fs_catalog', label: 'Catalogue', writesWorkspace: false },
  { name: 'fs_cancel', label: 'Annuler job', writesWorkspace: false },
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

export const REASONING_EFFORTS = Object.freeze(['standard', 'deep', 'max']);

export function normalizeReasoningEffort(val, fallback = 'deep') {
  const v = String(val ?? '').trim().toLowerCase();
  if (v === 'standard' || v === 'low' || v === 'normal') return 'standard';
  if (v === 'max' || v === 'maximum' || v === 'high' || v === 'xhigh' || v === 'boost') return 'max';
  if (v === 'deep' || v === 'medium' || v === 'approfondi' || v === 'think') return 'deep';
  return REASONING_EFFORTS.includes(fallback) ? fallback : 'deep';
}

export function buildReasoningDirective(effort = 'deep', executionMode = 'generate') {
  const eff = normalizeReasoningEffort(effort, 'deep');
  if (eff === 'standard') return '';
  if (eff === 'max') {
    return executionMode === 'plan'
      ? ` Protocole de raisonnement MAXIMUM : décompose l'architecture, vérifie chaque dépendance inter-fichiers, anticipe les cas limites, régressions, failles de sécurité et goulots de performance avant de formuler le plan.`
      : ` Protocole de raisonnement MAXIMUM : avant toute écriture ou réponse, analyse méthodiquement la cause racine, les invariants du code, les effets de bord multi-fichiers et les cas limites (erreurs, types, concurrence, sécurité). Vérifie systématiquement la cohérence syntaxique et logique du résultat final.`;
  }
  return executionMode === 'plan'
    ? ` Raisonnement approfondi : vérifie les dépendances et cas limites avant de structurer les étapes.`
    : ` Raisonnement approfondi : analyse les contraintes, dépendances et cas limites avant de coder ou modifier un fichier, et vérifie la cohérence finale.`;
}

export const DEFAULT_STATE = {
  stateVersion: 2,
  apiKey: '',
  // Non-secret change marker used to invalidate an in-process Credential
  // Manager cache when another Antigravity surface stores or removes a key.
  credentialVersion: '',
  cutoffPercent: 15,
  mode: 'eco',
  routingProfile: 'quality',
  permissionMode: 'acceptEdits',
  autoDelegate: true,
  maxParallel: 3,
  showReasoning: true,
  reasoningEffort: 'deep',
  useClientTools: true,
  enableWebSearch: true,
  reuseChat: true,
  contextCompactPercent: 80,
  // Minimal does not inject a project map or the content of files.
  contextMode: 'minimal',
  directChats: {},
  knownModels: {},
  modelPolicies: {},
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
      const parsed = JSON.parse(raw);
      const merged = { ...DEFAULT_STATE, ...parsed };
      merged.modelPolicies = (parsed.modelPolicies && typeof parsed.modelPolicies === 'object' && !Array.isArray(parsed.modelPolicies))
        ? { ...parsed.modelPolicies }
        : {};
      if (!parsed.stateVersion || Number(parsed.stateVersion) < 2) {
        merged.stateVersion = 2;
        merged.useClientTools = true;
        merged.permissionMode = PERMISSION_MODES.includes(parsed.permissionMode) ? parsed.permissionMode : 'acceptEdits';
        saveState(merged);
      }
      return merged;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_STATE, modelPolicies: {} };
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

/** Keeps rules/AGENTS.md synchronized with Auto/Manual & permission mode in the UI. */
export function syncAgentsRule(autoDelegate = true, permissionMode = null) {
  const auto = Boolean(autoDelegate);
  const st = loadState();
  const effectivePerm = PERMISSION_MODES.includes(permissionMode)
    ? permissionMode
    : (st.permissionMode || 'acceptEdits');
  const writesDirectly = effectivePerm === 'acceptEdits' || effectivePerm === 'full';
  const header = auto
    ? (writesDirectly
      ? `PRIORITÉ ABSOLUE — Mode Automatique actif (permission : \`${effectivePerm}\`) : pour **toute création de fichier, modification, refactorisation, débogage, exploration de code, planification${effectivePerm === 'full' ? ', exécution de tests/commandes' : ''} ou analyse technique**, appelle **IMMÉDIATEMENT EN PREMIER** \`fs_delegate\` avec \`workspaceRoot\` (chemin absolu du projet), \`contextMode="minimal"\` et \`waitSeconds=45\`. **INTERDICTION** de lire les fichiers (\`read_file\`, \`grep_search\`, \`find_by_name\`) ou de les éditer (\`edit_file\`, \`write_file\`) en natif avant d’appeler \`fs_delegate\` : France Student dispose de ses propres outils locaux (\`list_directory\`, \`search_files\`, \`read_file\`, \`edit_file\`, \`write_file\`${effectivePerm === 'full' ? ', \`run_command\`' : ''}) avec sauvegarde atomique \`/undo\`, agit directement sur le disque et te renvoie un bilan court (\`filesWritten\`, \`commandsRun\`).`
      : 'PRIORITÉ ABSOLUE — Mode Automatique actif (permission : `plan` — lecture seule) : délègue immédiatement en premier à `fs_delegate` (`workspaceRoot`, `contextMode="minimal"`, `waitSeconds=45`) **sans lire les fichiers en natif avant** pour : **modifications (`executionMode="patch"`), plans (`executionMode="plan"`), exploration, revues/audits, debug et génération de code**.')
    : 'Mode Manuel actif : n’appelle `fs_delegate`, `fs_undo`, `fs_memory`, `fs_session`, `fs_logs`, `fs_quota` ou `fs_diagnostics` **que** si l’utilisateur mentionne France Student, `@[plugin:fs-atg]` ou une commande slash officielle (`/fs`, `/max`, `/patch`, `/plan`, `/eco`, `/undo`, `/remember`, `/quota`).';
  const content = [
    '# France Student [ATG]',
    '',
    header,
    '',
    '- **Commandes slash officielles** (Mode Automatique et Mode Manuel) : `/fs` (déléguer, écriture directe `workspaceRoot` + `/undo`), `/max` (`reasoningEffort="max"` + modèle Fort), `/patch` (patch ciblé), `/plan` (plan en lecture seule), `/eco` (profil Éco), `/undo` → `fs_undo`, `/remember` → `fs_memory`, `/quota` → `fs_quota` + `fs_diagnostics`.',
    writesDirectly
      ? '- **Zéro gaspillage de quota Antigravity** : ne fais jamais d’exploration ou de réécriture native quand `fs_delegate` peut tout exécuter de bout en bout sur disque avec `workspaceRoot`. Une fois `fs_delegate` terminé (`status: "done"` avec `filesWritten`), présente directement le résultat à l’utilisateur sans relire ni rééditer les fichiers modifiés. Si besoin d’annuler : `/undo` → `fs_undo`.'
      : '- **Lecture seule (`plan`)** : passe `workspaceRoot` à `fs_delegate`, utilise `executionMode="patch"` ou `executionMode="plan"`, et applique uniquement les courts extraits retournés avec `edit_file`.',
    '- **Exceptions natives strictes** : garde en natif Antigravity **uniquement** : (1) micro-retouche triviale `< 5 lignes` déjà visible dans le message, (2) question purement conversationnelle sans accès au code, (3) recherche web externe (`search_web`) ou navigateur (`browser`).',
    '- **Raisonnement boosté & Mémoire** : utilise `reasoningEffort="max"` (ou `/max`) sur les tâches complexes ; `/remember` appelle `fs_memory` (`FRST.md` + notes + faits appris sont injectés automatiquement au 1er tour).',
    '- **Contrôle par modèle (Oui / À demander / Non)** : si `fs_delegate` renvoie `status: "needs_approval"`, demande explicitement l’accord de l’utilisateur avant d’utiliser le modèle recommandé (ou propose une alternative autorisée), puis relance `fs_delegate` avec `approveModel="<modelId>"` (ou `model="<alternative>"`). N’utilise jamais un modèle réglé sur « Non ».',
    '- **Cascade 502/429 & Cooldown 10 min (`IA non dispo`)** : en cas d’erreur 502/503/429, France Student bascule automatiquement du meilleur modèle au moins fort (`heavy` → `medium` → `light`). Si aucun modèle ne répond, un cooldown de 10 min est activé avec le motif `IA non dispo` : pendant ce cooldown, exécute directement la tâche en natif sans rappeler `fs_delegate`.',
    '- **Plan B** : si Plan A échoue hors `IA non dispo`, relance en `planB: true` avec `parts` (2–4 petits blocs) ; n’exécute nativement qu’en tout dernier recours.',
    '- **Quota & état** : `/quota` → `fs_quota` (quota, cooldown `IA non dispo`) puis `fs_diagnostics` (connexion, modèles) ; `fs_logs` et `fs_session` restent disponibles comme outils. `/usage` mesure Antigravity.',
    '',
  ].join('\n');
  mkdirSync(dirname(RULES_PATH), { recursive: true });
  writeFileSync(RULES_PATH, content, 'utf-8');
  logEvent('info', 'core', 'settings.rule_synced', `Règle Antigravity mise à jour : mode ${auto ? 'Automatique' : 'Manuel'} (${effectivePerm}).`, { autoDelegate: auto, permissionMode: effectivePerm });
  return { autoDelegate: auto, permissionMode: effectivePerm, path: RULES_PATH };
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
  if (state?._ephemeral === true) return String(state?.apiKey || '').trim();

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

let webAccessCache = { token: '', expiresAtMs: 0, version: '' };
let webRefreshPromise = null;

export function primeWebAccessCache(token, expiresAtMs, version = '') {
  const clean = String(token || '').trim();
  webAccessCache = clean
    ? { token: clean, expiresAtMs: Number(expiresAtMs) || (Date.now() + 300_000), version: String(version || '') }
    : { token: '', expiresAtMs: 0, version: '' };
}

export function clearWebAccessCache() {
  webAccessCache = { token: '', expiresAtMs: 0, version: '' };
  webRefreshPromise = null;
}

export function parseApiTokenResponse(data, nowMs = Date.now()) {
  const accessToken = String(data?.accessToken ?? '').trim();
  if (!accessToken) return null;
  const rawExpAt = Number(data?.expiresAt);
  let expiresAtMs = (Number.isFinite(rawExpAt) && rawExpAt > 0)
    ? (rawExpAt < 1_000_000_000_000 ? rawExpAt * 1000 : rawExpAt)
    : 0;
  if (!(expiresAtMs > nowMs)) {
    const rawExpIn = Number(data?.expiresIn);
    expiresAtMs = nowMs + (Number.isFinite(rawExpIn) && rawExpIn > 0 ? rawExpIn * 1000 : 300_000);
  }
  return { accessToken, expiresAtMs };
}

export function extractSetCookieValue(headers, names = SESSION_COOKIE_NAMES) {
  let rawList = [];
  if (typeof headers?.getSetCookie === 'function') {
    rawList = headers.getSetCookie();
  } else {
    const headerVal = typeof headers?.get === 'function' ? headers.get('set-cookie') : headers?.['set-cookie'];
    if (Array.isArray(headerVal)) rawList = headerVal;
    else if (typeof headerVal === 'string' && headerVal.trim()) {
      rawList = headerVal.split(/,(?=\s*[^;,\s=]+=)/);
    }
  }
  const found = new Map();
  for (const raw of rawList) {
    const parts = String(raw || '').split(';');
    const pair = parts[0] || '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!names.includes(name)) continue;
    const value = pair.slice(eq + 1).trim();
    const attrs = parts.slice(1).map((a) => a.trim());
    const maxAge = attrs.find((a) => /^max-age=/i.test(a));
    const expires = attrs.find((a) => /^expires=/i.test(a));
    const dead = !value
      || (maxAge && Number(maxAge.split('=')[1]) <= 0)
      || (expires && Date.parse(expires.slice(expires.indexOf('=') + 1)) <= Date.now());
    if (dead) found.delete(name);
    else found.set(name, value);
  }
  for (const name of names) {
    if (found.has(name)) return { name, value: found.get(name) };
  }
  return null;
}

export async function fetchAccessTokenFromWebSession(session, { fetchImpl = fetch } = {}) {
  const sessionToken = String(session?.sessionToken ?? '').trim();
  if (!sessionToken) {
    const err = new Error('Session France Student manquante.');
    err.status = 401;
    err.sessionExpired = true;
    throw err;
  }
  const cookieName = String(session?.cookieName || 'next-auth.session-token').trim() || 'next-auth.session-token';
  const deviceId = String(session?.deviceId || '').trim() || randomUUID();
  const cookieStr = `${cookieName}=${sessionToken}; francestudent-device-id=${deviceId}`;
  const res = await fetchImpl(`${OFFICIAL_WEB_ORIGIN}/api/auth/api-token`, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Cookie: cookieStr,
      Accept: '*/*',
      Origin: OFFICIAL_WEB_ORIGIN,
      Referer: `${OFFICIAL_WEB_ORIGIN}/`,
      'francestudent-client-platform': 'web_fs_ai',
      'francestudent-client-version': '4005601',
      'francestudent-device-id': deviceId,
    },
  });
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    const err = new Error('Session France Student expirée ou refusée — reconnecte-toi dans Réglages.');
    err.status = 401;
    err.sessionExpired = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`api-token HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    const err = new Error('Réponse api-token illisible (JSON attendu).');
    err.status = 401;
    err.sessionExpired = true;
    throw err;
  }
  const parsed = parseApiTokenResponse(data);
  if (!parsed) {
    const err = new Error('Session France Student invalide (aucun accessToken reçu).');
    err.status = 401;
    err.sessionExpired = true;
    throw err;
  }
  const renewed = extractSetCookieValue(res.headers);
  return {
    accessToken: parsed.accessToken,
    expiresAtMs: parsed.expiresAtMs,
    renewedCookie: renewed?.value ?? null,
    renewedCookieName: renewed?.name ?? null,
  };
}

export async function saveWebSessionAndPrime(state, session, accessToken, expiresAtMs) {
  const result = await saveWebSession(state, session);
  await clearStateCredential(state).catch(() => {});
  state.credentialVersion = randomUUID();
  if (!saveState(state)) {
    throw new Error('La session est enregistrée, mais l’état local n’a pas pu être mis à jour.');
  }
  credentialCache = '';
  credentialCacheLoaded = false;
  credentialCacheVersion = '';
  primeWebAccessCache(accessToken, expiresAtMs, state.credentialVersion);
  logEvent('info', 'core', 'auth.web_session_saved', 'Session France Student longue durée enregistrée.');
  return result;
}

export async function resolveAuthToken(state, { forceRefresh = false, fetchImpl = fetch, persist = true } = {}) {
  const environment = String(process.env.FS_ATG_API_KEY || '').trim();
  if (environment) return environment;

  const hasWebHint = Boolean(state?.webSessionConfigured || state?.webSession?.sessionToken);
  const version = String(state?.credentialVersion || '');
  if (
    !forceRefresh &&
    hasWebHint &&
    webAccessCache.token &&
    webAccessCache.version === version &&
    webAccessCache.expiresAtMs - Date.now() > TOKEN_REFRESH_MARGIN_MS
  ) {
    return webAccessCache.token;
  }

  let session = null;
  if (hasWebHint || (!state?.apiKey && !state?.credentialStorage)) {
    session = await readWebSession(state);
  }
  if (session?.sessionToken) {
    const runRefresh = async () => {
      const fresh = await fetchAccessTokenFromWebSession(session, { fetchImpl });
      if (fresh.renewedCookie && fresh.renewedCookie !== session.sessionToken) {
        const updatedSession = {
          ...session,
          sessionToken: fresh.renewedCookie,
          cookieName: fresh.renewedCookieName || session.cookieName,
          updatedAt: Date.now(),
        };
        if (persist && state && state._ephemeral !== true) {
          await saveWebSession(state, updatedSession).catch(() => {});
          state.credentialVersion = randomUUID();
          saveState(state);
        } else if (state && typeof state === 'object') {
          state.webSession = updatedSession;
          state.webSessionUpdatedAt = updatedSession.updatedAt;
        }
      }
      primeWebAccessCache(fresh.accessToken, fresh.expiresAtMs, String(state?.credentialVersion || ''));
      return fresh.accessToken;
    };
    webRefreshPromise ??= runRefresh().finally(() => {
      webRefreshPromise = null;
    });
    return await webRefreshPromise;
  }

  return await resolveApiKey(state);
}

/** A status-only representation suitable for the panel and MCP diagnostics. */
export async function apiCredentialStatus(state) {
  if (String(process.env.FS_ATG_API_KEY || '').trim()) {
    return { configured: true, mode: 'environment', storage: 'environment', sessionActive: false };
  }
  const hasWebHint = Boolean(state?.webSessionConfigured || state?.webSession?.sessionToken);
  const webSession = hasWebHint
    ? await readWebSession(state)
    : ((!state?.apiKey && !state?.credentialStorage) ? await readWebSession(state) : null);
  if (webSession?.sessionToken) {
    return {
      configured: true,
      mode: 'web-session',
      storage: state?.webSessionStorage || (process.platform === 'win32' ? 'windows-credential-manager' : 'state-file'),
      sessionActive: true,
      sessionUpdatedAt: state?.webSessionUpdatedAt || webSession.updatedAt || null,
    };
  }
  const value = await resolveApiKey(state);
  if (value) {
    return {
      configured: true,
      mode: 'api-key',
      storage: state?.apiKey ? 'state-file' : 'windows-credential-manager',
      sessionActive: false,
    };
  }
  const status = await stateCredentialStatus(state);
  const configured = Boolean(status.configured);
  return {
    configured,
    mode: configured ? 'api-key' : 'none',
    storage: status.storage,
    sessionActive: false,
  };
}

/** Stores a new user-entered key without ever persisting it in Windows JSON state. */
export async function saveApiKey(state, value) {
  const result = await saveStateCredential(state, value);
  await clearWebSession(state).catch(() => {});
  clearWebAccessCache();
  state.credentialVersion = randomUUID();
  if (!saveState(state)) {
    throw new Error('La clé est protégée, mais l’état local n’a pas pu être mis à jour. Réessaie avant de fermer Antigravity.');
  }
  credentialCache = String(value || '').trim();
  credentialCacheLoaded = true;
  credentialCacheVersion = String(state.credentialVersion);
  return result;
}

/** Removes locally managed credentials (manual key and web session); an environment variable remains untouched. */
export async function removeApiKey(state) {
  await clearStateCredential(state);
  await clearWebSession(state);
  clearWebAccessCache();
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
  let apiKey = await resolveAuthToken(state);
  if (!apiKey) throw new Error('Aucune clé API / session France Student enregistrée.');
  const base = OFFICIAL_API_BASE_URL;
  const doRequest = (token) => fetch(base + path, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let res = await doRequest(apiKey);
  if (res.status === 401 && state?.webSessionConfigured) {
    await res.text().catch(() => {});
    apiKey = await resolveAuthToken(state, { forceRefresh: true });
    res = await doRequest(apiKey);
  }
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
    const policy = getModelPolicy(id, state);
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
      policy,
      blocked: policy === 'deny',
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
  const groups = { light: [], medium: [], heavy: [] };
  for (const id of available || []) {
    const t = classifyTier(id, state);
    const meta = metaMap?.get(id);
    const policy = getModelPolicy(id, state);
    groups[t].push({
      id,
      name: meta?.name || id,
      provider: meta?.provider || (id.startsWith('claude') ? 'anthropic' : 'openai'),
      policy,
      blocked: policy === 'deny',
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

const ARTIFACT_STUB_PATTERN = /(?:create_artifact|artefact|panneau latéral|disponibles? dans|se trouve dans|voir dans [«"'])/i;

/** A text-only fallback detects explicit refusals and short server-artifact redirects. */
export function refusalReasonFromText(text) {
  const value = String(text ?? '').trim();
  if (!value || value.length > 1800) return null;
  const hasRealCode = /```[\s\S]{80,}```/.test(value);
  if (!hasRealCode && value.length < 500 && ARTIFACT_STUB_PATTERN.test(value)) {
    return 'Redirection vers artefact serveur sans code inline';
  }
  if (/```/.test(value)) return null;
  return REFUSAL_TEXT_AT_START.test(value) ? value : null;
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
  let permissionMode = null;
  let reasoningEffort = null;
  let quotaQuery = false;
  // `/plan /security audit src/auth` is valid: all recognised directives are local.
  for (;;) {
    const slash = /^\s*\/([a-zA-ZÀ-ÿ0-9_-]+)(?:\s+|$)/.exec(prompt);
    if (!slash) break;
    const command = normalizedDirective(slash[1]);
    const next = prompt.slice(slash[0].length);
    // `/fs` is the official alias of `/send` (plain delegation).
    if (command === 'send' || command === 'fs') { prompt = next; continue; }
    // `/quota` is a local query (fs_quota / fs_diagnostics): never sent in the prompt.
    if (command === 'quota') { quotaQuery = true; prompt = next; continue; }
    if (command === 'plan') { executionMode = 'plan'; prompt = next; continue; }
    if (command === 'patch') { executionMode = 'patch'; prompt = next; continue; }
    if (command === 'dry-run' || command === 'dryrun' || command === 'preview') { executionMode = 'dry-run'; prompt = next; continue; }
    if (command === 'apply') { executionMode = 'apply'; prompt = next; continue; }
    if (command === 'think' || command === 'deep' || command === 'reason') { reasoningEffort = 'deep'; prompt = next; continue; }
    if (command === 'max' || command === 'boost' || command === 'xhigh') { reasoningEffort = 'max'; requested = requested ?? { kind: 'tier', value: 'heavy' }; prompt = next; continue; }
    if (command === 'mode') {
      const m = /^(\S+)(?:\s+|$)/.exec(next);
      const val = m ? normalizedDirective(m[1]) : '';
      if (val === 'plan' || val === 'readonly' || val === 'lecture') { permissionMode = 'plan'; prompt = next.slice(m[0].length); continue; }
      if (val === 'acceptedits' || val === 'edit' || val === 'edits') { permissionMode = 'acceptEdits'; prompt = next.slice(m[0].length); continue; }
      if (val === 'full' || val === 'complet' || val === 'shell') { permissionMode = 'full'; prompt = next.slice(m[0].length); continue; }
      break;
    }
    const profileValue = normalizeRoutingProfile(command);
    if (profileValue) { profile = profileValue; prompt = next; continue; }
    if (command === 'auto') { requested = { kind: 'auto', value: 'auto' }; prompt = next; continue; }
    if (TIER_ALIASES[command]) { requested = { kind: 'tier', value: TIER_ALIASES[command] }; prompt = next; continue; }
    if (MODEL_ALIASES[command]) { requested = { kind: 'model', value: MODEL_ALIASES[command] }; prompt = next; continue; }
    break;
  }
  return { prompt: prompt.trim(), tagModel, requested, profile, executionMode, permissionMode, reasoningEffort, quotaQuery };
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

export function pickModel(raw, available, state, explicit, { approvedModel = null } = {}) {
  const has = (id, pats) => pats.some((p) => id.toLowerCase().includes(p.toLowerCase()));
  const pool = (available || []).filter((id) => getModelPolicy(id, state) !== 'deny');
  if (!pool.length) throw new Error('Aucun modèle autorisé disponible (vérifie l’onglet Modèles).');
  const directives = parseTaskDirectives(raw);
  const prompt = directives.prompt;
  const requested = directives.requested;
  const wanted = requested?.kind === 'auto' ? undefined : (requested?.value || explicit || directives.tagModel);
  const wantedNorm = wanted ? normalizedDirective(wanted).replace(/^tier:/, '') : '';
  const forcedTier = requested?.kind === 'tier' ? requested.value : TIER_ALIASES[wantedNorm];
  const profile = directives.profile || normalizeRoutingProfile(state?.routingProfile) || 'auto';

  const finalize = (result) => {
    const policy = getModelPolicy(result.model, state);
    const needsApproval = policy === 'ask' && approvedModel !== result.model;
    const alternatives = needsApproval
      ? rankModelsBestToWorst(pool, state, { includeAsk: false }).slice(0, 3)
      : [];
    return { ...result, policy, needsApproval, alternatives };
  };

  const effectiveEffort = normalizeReasoningEffort(directives.reasoningEffort || state?.reasoningEffort, 'deep');
  if (wanted && !forcedTier) {
    const hit = pool.find((id) => has(id, [wanted]));
    if (hit) return finalize({ model: hit, prompt, reason: `forcé : ${wanted}`, profile, executionMode: directives.executionMode, permissionMode: directives.permissionMode, reasoningEffort: effectiveEffort });
    const rawHit = (available || []).find((id) => has(id, [wanted]));
    if (rawHit && getModelPolicy(rawHit, state) === 'deny') {
      throw new Error(`Modèle « ${wanted} » désactivé (Non) dans l’onglet Modèles.`);
    }
    throw new Error(`Modèle « ${wanted} » indisponible ou bloqué.`);
  }

  const preferredTier = effectiveEffort === 'max' ? 'heavy' : profileTier(profile, prompt);
  const tier = forcedTier || preferredTier || (HEAVY.test(prompt) || prompt.length > 4000 ? 'heavy'
    : LIGHT.test(prompt) && prompt.length < 800 ? 'light' : 'medium');
  const order = tier === 'heavy' ? ['heavy', 'medium', 'light']
    : tier === 'light' ? ['light', 'medium', 'heavy'] : ['medium', 'heavy', 'light'];
  for (const t of order) {
    const hit = pickTierCandidate(pool, t, state);
    if (hit) {
      const label = t === 'light' ? 'faible' : t === 'heavy' ? 'fort' : 'équilibré';
      return finalize({
        model: hit,
        prompt,
        reason: forcedTier ? `catégorie : ${label}`
          : (effectiveEffort === 'max' ? `raisonnement max : ${label}`
            : (preferredTier ? `profil ${profile} : ${label}${t !== tier ? ' (repli)' : ''}`
              : `auto : ${label}${t !== tier ? ' (repli)' : ''}`)),
        profile,
        executionMode: directives.executionMode,
        permissionMode: directives.permissionMode,
        reasoningEffort: effectiveEffort,
      });
    }
  }
  return finalize({
    model: pool[0],
    prompt,
    reason: profile === 'auto' ? 'auto : premier modèle autorisé' : `profil ${profile} : premier modèle autorisé`,
    profile,
    executionMode: directives.executionMode,
    permissionMode: directives.permissionMode,
    reasoningEffort: effectiveEffort,
  });
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
  let apiKey = await resolveAuthToken(state);
  if (!apiKey || !chatId || !lastEventId) return null;
  const base = OFFICIAL_API_BASE_URL;
  const doFetch = (token) => fetch(`${base}/chats/${encodeURIComponent(chatId)}/stream`, {
    method: 'GET',
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'Last-Event-ID': String(lastEventId),
    },
  });
  let res = await doFetch(apiKey);
  if (res.status === 401 && state?.webSessionConfigured) {
    await res.body?.cancel?.().catch(() => {});
    apiKey = await resolveAuthToken(state, { forceRefresh: true });
    res = await doFetch(apiKey);
  }
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

function normalizeApiToolCall(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const callId = raw.callId ?? raw.call_id;
  const name = raw.name;
  if (typeof callId !== 'string' || !callId || typeof name !== 'string' || !name) return null;
  let args = raw.arguments ?? {};
  let argsError = null;
  if (typeof args === 'string') {
    try { args = args.trim() ? JSON.parse(args) : {}; }
    catch { argsError = 'Arguments JSON invalides.'; args = {}; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    argsError ??= 'Les arguments doivent être un objet JSON.';
    args = {};
  }
  const call = { callId, name, arguments: args };
  if (argsError) call.argsError = argsError;
  return call;
}

function extractApiToolCalls(message) {
  const list = message?.toolCalls;
  return Array.isArray(list) ? list.map(normalizeApiToolCall).filter(Boolean) : [];
}

async function cancelChatStreamBestEffort(base, apiKey, chatId) {
  if (!chatId || !apiKey) return;
  try {
    await fetch(`${base}/chats/${encodeURIComponent(chatId)}/stream/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* best-effort server cancel */ }
}

export async function streamGeneration({
  state,
  model,
  agentMap,
  instructions,
  prompt,
  chatId: existingChatId,
  clientTools = [],
  executeToolCall = null,
  maxToolTurns = 12,
  signal,
  timeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
  onText,
  onReasoning,
  onChatId,
  onToolCall,
}) {
  const base = OFFICIAL_API_BASE_URL;
  let apiKey = await resolveAuthToken(state);
  if (!apiKey) throw new Error('Aucune clé API / session France Student enregistrée.');
  const agentId = agentMap?.get(model);
  const localPromptEstimateTokens = estimateTokens(prompt);
  let activeChatId = existingChatId ?? null;

  const timeoutCtrl = new AbortController();
  const timeoutTimer = setTimeout(() => {
    const err = new Error(`Délai dépassé (${Math.round(timeoutMs / 1000)}s).`);
    err.retryable = true;
    timeoutCtrl.abort(err);
  }, Math.max(10_000, Number(timeoutMs) || DEFAULT_STREAM_TIMEOUT_MS));
  const onParentAbort = () => {
    timeoutCtrl.abort(new Error('Annulé.'));
    if (activeChatId) void cancelChatStreamBestEffort(base, apiKey, activeChatId);
  };
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutTimer);
      throw new Error('Annulé.');
    }
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const effectiveSignal = timeoutCtrl.signal;

  const eff = normalizeReasoningEffort(state?.reasoningEffort, 'deep');
  const apiEffort = eff === 'max' ? 'high' : (eff === 'deep' ? 'medium' : 'low');

  const runOpenAiResponses = async () => {
    const body = {
      model,
      instructions,
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    };
    if (state.showReasoning !== false) body.reasoning = { effort: apiEffort, summary: 'auto' };
    const doResponses = (token) => fetch(base + '/v1/responses', {
      method: 'POST',
      signal: effectiveSignal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    let res = await doResponses(apiKey);
    if (res.status === 401 && state?.webSessionConfigured) {
      await res.body?.cancel?.().catch(() => {});
      apiKey = await resolveAuthToken(state, { forceRefresh: true });
      res = await doResponses(apiKey);
    }
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
    activeChatId = chatId;
    const toolsList = Array.isArray(clientTools) && clientTools.length && typeof executeToolCall === 'function'
      ? [...clientTools]
      : [];
    let lastNonEmptyTurnText = '';
    let combinedText = '';
    let aggregateUsage = null;
    let toolTurns = 0;

    const addUsage = (tu) => {
      if (!tu) return;
      const inT = tu.promptTokenCount ?? tu.input_tokens;
      const outT = tu.candidatesTokenCount ?? tu.output_tokens;
      const totT = tu.totalTokenCount ?? tu.total_tokens;
      const reasT = tu.reasoningTokenCount ?? tu.reasoning_tokens;
      if (inT == null && outT == null && totT == null) return;
      aggregateUsage ??= { input_tokens: 0, output_tokens: 0, total_tokens: 0, reasoning_tokens: 0 };
      if (typeof inT === 'number') aggregateUsage.input_tokens += inT;
      if (typeof outT === 'number') aggregateUsage.output_tokens += outT;
      if (typeof totT === 'number') aggregateUsage.total_tokens += totT;
      if (typeof reasT === 'number') aggregateUsage.reasoning_tokens += reasT;
    };

    const consumeTurn = async (res, turn = { text: '', toolCalls: [] }, allowResume = true) => {
      if (!res.ok || !res.body) {
        const txt = (await res.text().catch(() => '')).slice(0, 260);
        const fail = providerFailure({ message: txt }, `HTTP ${res.status}${txt ? ' — ' + txt : ''}`, { status: res.status, chatId });
        if (res.status === 400 && /client tools are not supported/i.test(txt)) {
          fail.clientToolsUnsupported = true;
          fail.retryable = true;
        } else if (res.status === 403 && /client[_ ]?tools|2026_11_client_tools/i.test(txt)) {
          fail.clientToolsAccountDisabled = true;
          fail.retryable = true;
        }
        throw fail;
      }
      const ct = String(res.headers?.get?.('content-type') ?? '');
      if (/application\/json/i.test(ct)) {
        const data = await res.json();
        const cid = data?.chat_id ?? data?.chatId;
        if (cid) {
          chatId = cid;
          activeChatId = cid;
          onChatId?.(cid);
        }
        const msg = data?.message ?? data;
        const refusal = refusalReasonFromEvent(data);
        if (refusal) throw new ModelRefusalError(refusal, { chatId });
        if (typeof msg?.reasoning === 'string' && msg.reasoning) onReasoning?.(msg.reasoning);
        if (typeof msg?.content === 'string' && msg.content) {
          turn.text += msg.content;
          combinedText += (combinedText ? '\n' : '') + msg.content;
          onText?.(msg.content);
        }
        turn.toolCalls = extractApiToolCalls(msg);
        addUsage(msg?.tokenUsage ?? data?.response?.usage ?? data?.usage);
        if (turn.text.trim()) lastNonEmptyTurnText = turn.text;
        return turn;
      }
      let lastEventId;
      let completed = false;
      try {
        for await (const frame of readSseFrames(res.body)) {
          if (frame.id) lastEventId = frame.id;
          const ev = frame.event;
          if (ev?.type === 'stream.open' && ev.chat_id) {
            chatId = ev.chat_id;
            activeChatId = chatId;
            onChatId?.(chatId);
          } else if (ev?.type === 'response.output_text.delta') {
            const d = ev.delta ?? '';
            turn.text += d;
            combinedText += d;
            onText?.(d);
          } else if (ev?.type === 'response.output_text.done' && !turn.text && ev.text) {
            turn.text += ev.text;
            combinedText += ev.text;
            onText?.(ev.text);
          } else if (
            ev?.type === 'response.reasoning_summary_text.delta' ||
            ev?.type === 'response.reasoning.delta' ||
            ev?.type === 'reasoning.delta' ||
            ev?.type === 'thinking.delta'
          ) {
            onReasoning?.(ev.delta ?? ev.text ?? '');
          } else if (ev?.type === 'completed' || ev?.type === 'response.completed' || ev?.type === 'stream.completed') {
            const refusal = refusalReasonFromEvent(ev);
            if (refusal) throw new ModelRefusalError(refusal, { chatId });
            completed = true;
            if (typeof ev.message?.reasoning === 'string' && ev.message.reasoning) {
              onReasoning?.(ev.message.reasoning);
            }
            if (!turn.text && ev.message?.content) {
              turn.text = String(ev.message.content);
              combinedText += (combinedText ? '\n' : '') + turn.text;
            }
            turn.toolCalls = extractApiToolCalls(ev.message);
            addUsage(ev.message?.tokenUsage ?? ev.response?.usage ?? ev.usage);
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
      if (turn.text.trim()) lastNonEmptyTurnText = turn.text;
      return turn;
    };

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(toolsList.length ? {
        'francestudent-client-platform': 'cli',
        'francestudent-client-version': CONNECTOR_VERSION,
      } : {}),
    };

    const continuing = Boolean(chatId);
    // Prompt placed BEFORE rules/context annex to preserve prompt cache and prevent GPT instruction refusals.
    const initialContent = instructions ? `${prompt}\n\n---\n\n${instructions}` : prompt;
    const firstPayload = continuing
      ? {
        content: prompt,
        agentId: id,
        enableCanvas: false,
        ...(toolsList.length ? { clientTools: toolsList } : {}),
      }
      : {
        agentId: id,
        enableCanvas: false,
        ...(state?.enableWebSearch !== undefined ? { enableWebSearch: Boolean(state.enableWebSearch) } : {}),
        initialContent,
        ...(toolsList.length ? { clientTools: toolsList } : {}),
      };

    const postChat = async (url, payload) => {
      let res = await fetch(url, {
        method: 'POST',
        signal: effectiveSignal,
        headers,
        body: JSON.stringify(payload),
      });
      if (res.status === 401 && state?.webSessionConfigured) {
        await res.body?.cancel?.().catch(() => {});
        apiKey = await resolveAuthToken(state, { forceRefresh: true });
        headers.Authorization = `Bearer ${apiKey}`;
        res = await fetch(url, {
          method: 'POST',
          signal: effectiveSignal,
          headers,
          body: JSON.stringify(payload),
        });
      }
      return res;
    };

    let turn = await consumeTurn(await postChat(base + (continuing ? `/chats/${chatId}` : '/chats/stream'), firstPayload));

    while (turn.toolCalls?.length && toolsList.length && toolTurns < maxToolTurns && !effectiveSignal.aborted) {
      toolTurns += 1;
      const rawResults = [];
      for (const call of turn.toolCalls.slice(0, 32)) {
        if (effectiveSignal.aborted) break;
        onToolCall?.({ turn: toolTurns, name: call.name, args: call.arguments });
        const result = await executeToolCall(call);
        rawResults.push({
          callId: call.callId,
          output: String(result?.output ?? ''),
          ...(result?.isError ? { isError: true } : {}),
        });
      }
      if (!rawResults.length || !chatId) break;
      const toolResults = fitToolOutputs(rawResults);
      turn = await consumeTurn(await postChat(`${base}/chats/${encodeURIComponent(chatId)}`, { toolResults, clientTools: toolsList }));
    }

    const finalText = toolTurns > 0 ? (lastNonEmptyTurnText || combinedText) : combinedText;
    if (!toolTurns) {
      const refusal = refusalReasonFromText(finalText);
      if (refusal) throw new ModelRefusalError(refusal, { chatId });
    }

    return {
      text: finalText,
      usage: aggregateUsage,
      written: [],
      toolTurns,
      chatId,
      tokenMeasurement: {
        localPromptEstimateTokens,
        providerUsage: normalizeProviderTokenUsage(aggregateUsage),
      },
    };
  };

  const tryChatCleanly = async (id, chatId) => {
    try {
      return await runChatStream(id, chatId);
    } catch (e) {
      const status = Number(e?.status ?? 0);
      if (chatId && !effectiveSignal.aborted && !(e instanceof ModelRefusalError) && !e?.clientToolsUnsupported && !e?.clientToolsAccountDisabled && (status === 400 || status === 404 || status === 410 || status >= 500)) {
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
 * Retries refusals, empty completions, 502/429/upstream errors or timeouts by
 * cascading through available models from BEST to WORST (heavy -> medium -> light).
 * If no model succeeds, activates a 10-minute cooldown with motif "IA non dispo".
 */
export async function streamGenerationWithRefusalFallback({ availableModels = [], approvedModel = null, onRetry, ...request }) {
  const gc = getGlobalCooldown(request.state);
  if (gc.active) {
    const mins = Math.max(1, Math.ceil(gc.remainingSec / 60));
    const cdErr = new Error(`${UNAVAILABLE_REASON} (cooldown 10 min actif : réessaie dans ~${mins} min)`);
    cdErr.noPlanB = true;
    cdErr.reason = UNAVAILABLE_REASON;
    cdErr.cooldownUntil = gc.until;
    throw cdErr;
  }

  const rankedAll = rankModelsBestToWorst(
    availableModels?.length ? availableModels : [request.model].filter(Boolean),
    request.state,
    { includeAsk: false, approvedModel }
  );
  const tried = new Set();
  const refusals = [];
  let model = request.model && rankedAll.includes(request.model) ? request.model : (rankedAll[0] || request.model);
  if (isModelOnCooldown(model)) {
    const firstReady = rankedAll.find((m) => !isModelOnCooldown(m));
    if (firstReady) model = firstReady;
  }
  let chatId = request.chatId;
  let activeRequest = { ...request };
  const maxAttempts = Math.max(1, rankedAll.length || 1);

  const pickNextBestToWorst = (current, reason = '') => {
    const untried = rankedAll.filter((c) => !tried.has(c));
    if (!untried.length) return null;
    const ready = untried.filter((c) => !isModelOnCooldown(c));
    const pool = ready.length ? ready : untried;

    // If an entire provider upstream just returned 502/429 capacity error, prefer trying the other provider family first while keeping best-to-worst order.
    const isUpstreamOutage = /502|503|504|BAD_GATEWAY|no responses upstream has available capacity|rate_limit_error|TOO_MANY_REQUESTS|\b429\b/i.test(String(reason));
    if (isUpstreamOutage && current) {
      const curIsClaude = /claude|opus|sonnet|haiku|fable/i.test(current);
      const otherFamily = pool.find((id) => (/claude|opus|sonnet|haiku|fable/i.test(id)) !== curIsClaude);
      if (otherFamily) return otherFamily;
    }

    if (/artefact|tronquée|sans bloc de code|client tools are not supported/i.test(String(reason))) {
      for (const kw of ['opus', 'sonnet', 'haiku']) {
        const hit = pool.find((id) => id.toLowerCase().includes(kw));
        if (hit) return hit;
      }
    }
    return pool[0] ?? null;
  };

  for (;;) {
    tried.add(model);
    const attemptNum = tried.size;
    const t0 = Date.now();
    logEvent('info', 'core', 'stream.attempt', `Essai ${attemptNum}/${maxAttempts} avec ${model} (cascade meilleur -> pire).`, { model, attempt: attemptNum, maxAttempts, hasChatId: Boolean(chatId), clientTools: Boolean(activeRequest.clientTools?.length) });
    try {
      const result = await streamGeneration({
        ...activeRequest,
        model,
        chatId,
      });
      const trimmedText = String(result?.text ?? '').trim();
      if (!trimmedText && !(result?.toolTurns > 0)) {
        const emptyErr = new Error('Réponse vide reçue du modèle.');
        emptyErr.retryable = true;
        throw emptyErr;
      }
      const expectsCodeBlock = /(?:bloc|TARGET|```|javascript|typescript|python|html|css)/i.test(String(activeRequest.instructions ?? ''));
      if (!result?.toolTurns && expectsCodeBlock && trimmedText.length < 65 && !trimmedText.includes('```')) {
        const stubErr = new Error('Réponse trop courte/tronquée sans bloc de code.');
        stubErr.retryable = true;
        throw stubErr;
      }
      logEvent('info', 'core', 'stream.done', `Réponse reçue de ${model} (${result.text.length} car., ${Math.round((Date.now() - t0) / 1000)}s).`, {
        model,
        chars: result.text.length,
        durationMs: Date.now() - t0,
        toolTurns: result.toolTurns ?? 0,
        usage: result.usage ?? null,
      });
      return { ...result, model, refusals, attemptedModels: [...tried] };
    } catch (error) {
      const isRefusal = error instanceof ModelRefusalError;
      const status = Number(error?.status ?? 0);
      const msg = String(error?.message ?? '');
      const isUnavailableOr502 =
        status === 429 ||
        status >= 500 ||
        /502|503|504|BAD_GATEWAY|TOO_MANY_REQUESTS|rate_limit_error|limit reached|no responses upstream has available capacity|upstream|capacity|STREAM_FAILED|\b429\b/i.test(msg);

      if (isUnavailableOr502) {
        recordModelCooldown(model, msg, UNAVAILABLE_REASON);
      }

      // Account lacks clientTools flag: retry cleanly once in inline/patch mode without clientTools.
      if (error?.clientToolsAccountDisabled && activeRequest.clientTools?.length && !activeRequest.signal?.aborted) {
        logEvent('warn', 'core', 'client_tools.disabled_fallback', `Outils client indisponibles sur ce compte ; bascule en mode texte/patch (${model}).`, { model });
        activeRequest = { ...activeRequest, clientTools: [], executeToolCall: null };
        chatId = undefined;
        onRetry?.({ from: model, to: model, reason: 'Outils client désactivés -> mode texte/patch', attempt: attemptNum });
        continue;
      }

      const isAuthErr = (status === 401 || status === 403) && !error?.clientToolsAccountDisabled;
      const isTransient = !isAuthErr && (
        isUnavailableOr502 ||
        Boolean(error?.retryable) ||
        Boolean(error?.clientToolsUnsupported) ||
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

      if (activeRequest.signal?.aborted || (!isRefusal && !isTransient)) {
        throw error;
      }

      const next = pickNextBestToWorst(model, msg);
      if (!next) {
        if (activeRequest.clientTools?.length) {
          activeRequest = { ...activeRequest, clientTools: [], executeToolCall: null };
          chatId = undefined;
          onRetry?.({ from: model, to: model, reason: 'Outils client indisponibles -> repli texte/patch', attempt: attemptNum });
          continue;
        }
        // Aucun modèle n'a fonctionné du meilleur au pire -> Cooldown global de 10 min avec motif "IA non dispo"
        const cd = recordGlobalCooldown(UNAVAILABLE_REASON, msg);
        const allFailedErr = new Error(`${UNAVAILABLE_REASON} — aucun modèle disponible après test du meilleur au moins fort (${tried.size} modèles testés, cooldown 10 min activé).`);
        allFailedErr.noPlanB = true;
        allFailedErr.reason = UNAVAILABLE_REASON;
        allFailedErr.cooldownUntil = cd.until;
        allFailedErr.attemptedModels = [...tried];
        allFailedErr.refusals = refusals;
        throw allFailedErr;
      }

      const reason = isRefusal ? (msg || MISSING_REFUSAL_REASON) : (isUnavailableOr502 ? `${UNAVAILABLE_REASON} (${msg.slice(0, 80)})` : msg.slice(0, 120));
      logEvent('warn', 'core', 'stream.fallback', `Bascule ${model} → ${next} (essai ${tried.size + 1}/${maxAttempts}).`, { from: model, to: next, reason });
      onRetry?.({ from: model, to: next, reason, attempt: tried.size + 1 });
      model = next;
      chatId = undefined;
    }
  }
}

/**
 * Estimates net Antigravity tokens conservatively saved by offloading work
 * directly (clientTools edits/writes) or via compact response synthesis.
 */
export function estimateAntigravityJobSavings(job, { waitedInline = false, partsCount = 1 } = {}) {
  const outputChars = Number(job?.receivedChars ?? 0);
  const responseTokens = Math.max(0, Math.round(outputChars / 4));
  const mode = String(job?.executionMode || 'generate');
  const isPlanOrReadOnly = mode === 'plan' || mode === 'dry-run';
  const isPatch = mode === 'patch';
  const filesWritten = Array.isArray(job?.filesWritten) ? job.filesWritten : [];
  const writtenChars = filesWritten.reduce((acc, f) => acc + Number(f?.charsWritten ?? 0), 0);
  const toolTurns = Number(job?.toolTurns ?? 0);

  if (filesWritten.length > 0 || toolTurns > 0) {
    // Autonomous execution: Antigravity skipped reading, coding, and writing files directly;
    // it only reads back the short completion summary.
    const savedWriteTokens = Math.round(writtenChars / 4);
    const savedToolTurnsTokens = Math.max(1, toolTurns) * 850 + 1_600;
    const summaryReadCost = Math.round(responseTokens * 0.5);
    const netSaved = Math.max(0, savedToolTurnsTokens + savedWriteTokens - summaryReadCost);
    const turnsSavedEst = (waitedInline ? 1 : 0) + Math.max(2, toolTurns);
    return {
      source: 'local-estimate',
      turnsSavedEst,
      inputTokensSavedEst: Math.max(0, savedToolTurnsTokens - summaryReadCost),
      outputTokensSavedEst: savedWriteTokens,
      totalTokensSavedEst: netSaved,
    };
  }

  const offloadedFiles = Array.isArray(job?.files) ? Math.min(6, job.files.length) : 0;
  const avoidedFileReadTokens = offloadedFiles * 600;
  const avoidedExplorationTokens = (isPlanOrReadOnly
    ? 2_200
    : (isPatch ? 2_600 : (responseTokens >= 300 ? 2_800 : 900))) + avoidedFileReadTokens;
  const readCostTokens = Math.round(responseTokens * (isPlanOrReadOnly ? 0.35 : (isPatch ? 0.45 : 0.65)));
  const netSaved = Math.max(0, avoidedExplorationTokens + Math.round(responseTokens * 0.8) - readCostTokens);
  const turnsSavedEst = (waitedInline ? 1 : 0) + Math.max(1, Number(partsCount) || 1);
  return {
    source: 'local-estimate',
    turnsSavedEst,
    inputTokensSavedEst: Math.max(0, avoidedExplorationTokens - readCostTokens),
    outputTokensSavedEst: Math.round(responseTokens * 0.8),
    totalTokensSavedEst: netSaved,
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
