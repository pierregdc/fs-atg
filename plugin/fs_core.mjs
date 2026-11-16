import tls from 'node:tls';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load Windows / OS system root certificates so HTTPS works even when intermediate CAs rely on the OS store.
if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  } catch { /* ignore */ }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ATG = '[ATG]';
export const STATE_PATH = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_state.json');
export const LIVE_PATH = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_live.json');

const MAX_TOOL_OUTPUT = 38_000; // cap below 40,000 char backend limit
const MAX_BATCH_OUTPUT = 115_000; // cap below 120,000 char backend limit

export const DEFAULT_AGENTS = [
  { id: 66, name: 'gpt-5.6-terra', model: 'gpt-5.6-terra', modelProvider: 'openai' },
  { id: 65, name: 'gpt-5.6-luna', model: 'gpt-5.6-luna', modelProvider: 'openai' },
  { id: 64, name: 'gpt-5.6-sol', model: 'gpt-5.6-sol', modelProvider: 'openai' },
  { id: -1001, name: 'GPT 6 Sol', model: 'gpt-6-sol', modelProvider: 'openai' },
  { id: -1002, name: 'GPT 6 Luna', model: 'gpt-6-luna', modelProvider: 'openai' },
  { id: -1003, name: 'GPT 6.1 Sol', model: 'gpt-6.1-sol', modelProvider: 'openai' },
  { id: -1004, name: 'GPT-6 Astra', model: 'gpt-6-astra', modelProvider: 'openai' },
  { id: -1005, name: 'GPT-6.1 Terra', model: 'gpt-6.1-terra', modelProvider: 'openai' },
  { id: -2001, name: 'Claude Opus 5.5', model: 'claude-opus-5-5', modelProvider: 'anthropic' },
  { id: -2002, name: 'Claude Haiku 5.5', model: 'claude-haiku-5-5', modelProvider: 'anthropic' },
  { id: -2003, name: 'Claude Sonnet 5.5', model: 'claude-sonnet-5-5', modelProvider: 'anthropic' },
  { id: -2005, name: 'Claude Fable 5.2', model: 'claude-fable-5-2', modelProvider: 'anthropic' },
];

export const DEFAULT_STATE = {
  apiKey: '',
  baseUrl: 'https://api.francestudent.org',
  cutoffPercent: 15,
  mode: 'eco',
  maxParallel: 3,
  showReasoning: true,
  useClientTools: true,
  allowedModels: [],
  blockedModels: [],
  tiers: {
    light: ['haiku', 'luna', 'mini', 'nano', 'flash'],
    medium: ['sonnet', 'terra', 'gpt-5.6-sol', 'kimi-k2'],
    heavy: ['fable', 'opus', 'astra', 'gpt-6-sol', 'gpt-6.1-sol', 'kimi-k3'],
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
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(st, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

export function readLiveJobs() {
  try {
    if (existsSync(LIVE_PATH)) {
      const data = JSON.parse(readFileSync(LIVE_PATH, 'utf-8'));
      if (Array.isArray(data)) return data;
    }
  } catch { /* ignore */ }
  return [];
}

export function writeLiveJobs(list) {
  try {
    mkdirSync(dirname(LIVE_PATH), { recursive: true });
    writeFileSync(LIVE_PATH, JSON.stringify(list, null, 2), 'utf-8');
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
  if (!state.apiKey) throw new Error('Aucune clé API / sessionToken enregistré.');
  const base = state.baseUrl.replace(/\/+$/, '');
  const res = await fetch(base + path, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${state.apiKey}`,
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

export function defaultModelsBundle() {
  const agentMap = new Map();
  const metaMap = new Map();
  const ids = [];
  for (const a of DEFAULT_AGENTS) {
    agentMap.set(a.model, a.id);
    metaMap.set(a.model, { id: a.model, name: a.name, provider: a.modelProvider });
    ids.push(a.model);
  }
  return { ids, agentMap, metaMap };
}

export async function fetchAgentsAndModels(state) {
  const agents = await fsJson(state, 'GET', '/chats/agents').catch(() => null);
  const agentMap = new Map();
  const metaMap = new Map();
  const ids = [];
  if (Array.isArray(agents) && agents.length) {
    for (const a of agents) {
      if (a?.isActive === false) continue;
      const modelId = String(a.model || a.name || a.id);
      if (!agentMap.has(modelId)) {
        agentMap.set(modelId, a.id);
        metaMap.set(modelId, {
          id: modelId,
          name: String(a.name || modelId),
          provider: String(a.modelProvider || (modelId.startsWith('claude') ? 'anthropic' : 'openai')),
        });
        ids.push(modelId);
      }
    }
    return { ids, agentMap, metaMap };
  }
  try {
    const r = await fsJson(state, 'GET', '/v1/models');
    const list = (r?.data ?? []).map((m) => {
      metaMap.set(m.id, { id: m.id, name: m.name || m.id, provider: m.owned_by || 'api' });
      return m.id;
    });
    if (list.length) return { ids: list, agentMap, metaMap };
  } catch { /* fallback to pre-registered defaults */ }
  return defaultModelsBundle();
}

const HEAVY = /(architect|refactor|migration|sécurité|security|concurren|optimi[sz]|algorithm|debug|bug|race condition|performance|plusieurs fichiers)/i;
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

export function pickModel(raw, available, state, explicit) {
  const has = (id, pats) => pats.some((p) => id.toLowerCase().includes(p.toLowerCase()));
  const allowed = state.allowedModels || [];
  const blocked = state.blockedModels || [];
  const pool = available.filter((id) => (!allowed.length || has(id, allowed)) && !has(id, blocked));
  if (!pool.length) throw new Error('Aucun modèle autorisé disponible.');
  let prompt = raw;
  const tag = /^\s*\[([\w.\- ]+)\]\s*/.exec(raw);
  const tagModel = tag && tag[1].toUpperCase() !== 'ATG' ? tag[1] : undefined;
  if (tagModel) prompt = raw.slice(tag[0].length);

  const slash = /^\s*\/([a-zA-ZÀ-ÿ0-9_-]+)(?:\s+|$)/.exec(prompt);
  const slashNorm = slash ? slash[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';
  const SLASH_CMDS = {
    auto: 'auto',
    faible: 'light', leger: 'light', light: 'light',
    mid: 'medium', moyen: 'medium', equilibre: 'medium', intermediaire: 'medium', medium: 'medium',
    eleve: 'heavy', fort: 'heavy', puissant: 'heavy', heavy: 'heavy',
  };
  const slashTarget = SLASH_CMDS[slashNorm];
  if (slashTarget) prompt = prompt.slice(slash[0].length);

  const wanted = slashTarget === 'auto' ? undefined : (slashTarget || explicit || tagModel);

  const TIER_ALIAS = {
    faible: 'light', leger: 'light', light: 'light',
    mid: 'medium', moyen: 'medium', equilibre: 'medium', intermediaire: 'medium', medium: 'medium',
    fort: 'heavy', eleve: 'heavy', puissant: 'heavy', heavy: 'heavy',
  };
  const normKey = wanted ? wanted.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^tier:/, '') : '';
  const forcedTier = TIER_ALIAS[normKey];

  if (wanted && !forcedTier) {
    const hit = pool.find((id) => has(id, [wanted]));
    if (hit) return { model: hit, prompt, reason: `forcé : ${wanted}` };
    throw new Error(`Modèle « ${wanted} » indisponible ou bloqué.`);
  }

  const tier = forcedTier || (HEAVY.test(prompt) || prompt.length > 4000 ? 'heavy'
    : LIGHT.test(prompt) && prompt.length < 800 ? 'light' : 'medium');
  const order = tier === 'heavy' ? ['heavy', 'medium', 'light']
    : tier === 'light' ? ['light', 'medium', 'heavy'] : ['medium', 'heavy', 'light'];
  for (const t of order) {
    const hit = pool.find((id) => classifyTier(id, state) === t);
    if (hit) {
      const label = t === 'light' ? 'faible' : t === 'heavy' ? 'fort' : 'équilibré';
      return {
        model: hit,
        prompt,
        reason: forcedTier ? `catégorie : ${label}` : `auto : ${label}${t !== tier ? ' (repli)' : ''}`,
      };
    }
  }
  return { model: pool[0], prompt, reason: 'auto : premier modèle autorisé' };
}

export async function* readSse(stream) {
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
        if (!data || data === '[DONE]') continue;
        try { yield JSON.parse(data); } catch { /* ignore */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
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
  return { rel: normalizedSlash, abs: absTarget };
}

function listDirTree(rootDir, relPath, depth, currentDepth = 1, out = []) {
  const { abs } = resolveSafe(rootDir, relPath || '.');
  const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name.startsWith('.env')) continue;
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

function searchInWorkspace(rootDir, query, subPath = '.', maxResults = 50) {
  const { abs } = resolveSafe(rootDir, subPath || '.');
  let re;
  try { re = new RegExp(query, 'i'); } catch { re = null; }
  const hits = [];
  const walk = (dir) => {
    if (hits.length >= maxResults) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= maxResults) break;
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.env')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try {
        if (statSync(full).size > 512 * 1024) continue;
        const lines = readFileSync(full, 'utf-8').split(/\r?\n/);
        const rel = relative(rootDir, full).replace(/\\/g, '/');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (re ? re.test(line) : line.toLowerCase().includes(query.toLowerCase())) {
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
        const lines = readFileSync(abs, 'utf-8').split(/\r?\n/);
        const start = Math.max(1, Number(args.start_line ?? 1));
        const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
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

export async function streamGeneration({
  state,
  model,
  agentMap,
  instructions,
  prompt,
  workspaceRoot,
  clientTools,
  signal,
  onText,
  onReasoning,
  onChatId,
  onToolCall,
}) {
  const base = state.baseUrl.replace(/\/+$/, '');
  const agentId = agentMap?.get(model);
  const writtenSet = new Set();

  const runOpenAiResponses = async () => {
    const body = {
      model,
      instructions,
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: `${ATG} ${prompt}` }] }],
    };
    if (state.showReasoning) body.reasoning = { summary: 'auto' };
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${state.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const txt = (await res.text().catch(() => '')).slice(0, 220);
      const err = new Error(`HTTP ${res.status}${txt ? ' — ' + txt : ''}`);
      err.status = res.status;
      throw err;
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
      } else if (ev?.type === 'response.completed') {
        usage = ev.response?.usage ?? null;
      } else if (ev?.type === 'response.failed' || ev?.type === 'error') {
        throw new Error(ev.response?.error?.message ?? ev.message ?? 'Échec de génération.');
      }
    }
    return { text, usage, written: [] };
  };

  const runChatStream = async (id, toolsToSend) => {
    let chatId = null;
    let totalText = '';
    let lastUsage = null;

    const consumeTurn = async (res) => {
      if (!res.ok || !res.body) {
        const txt = (await res.text().catch(() => '')).slice(0, 220);
        const err = new Error(`HTTP ${res.status}${txt ? ' — ' + txt : ''}`);
        err.status = res.status;
        throw err;
      }
      let turnText = '';
      let pendingCalls = [];
      for await (const ev of readSse(res.body)) {
        if (ev?.type === 'stream.open' && ev.chat_id) {
          chatId = ev.chat_id;
          onChatId?.(chatId);
        } else if (ev?.type === 'response.output_text.delta') {
          const d = ev.delta ?? '';
          turnText += d;
          totalText += d;
          onText?.(d);
        } else if (ev?.type === 'response.reasoning_summary_text.delta') {
          onReasoning?.(ev.delta ?? '');
        } else if (ev?.type === 'completed') {
          if (!turnText && ev.message?.content) {
            totalText += (totalText ? '\n' : '') + ev.message.content;
          }
          if (Array.isArray(ev.message?.toolCalls) && ev.message.toolCalls.length) {
            pendingCalls = ev.message.toolCalls;
          }
          const tu = ev.message?.tokenUsage;
          if (tu) {
            lastUsage = {
              input_tokens: tu.promptTokenCount ?? 0,
              output_tokens: tu.candidatesTokenCount ?? 0,
              total_tokens: tu.totalTokenCount ?? 0,
              reasoning_tokens: tu.reasoningTokenCount ?? 0,
            };
          }
        } else if (ev?.type === 'error' || ev?.type === 'response.failed') {
          throw new Error(ev.message ?? ev.response?.error?.message ?? 'Échec de génération.');
        } else if (ev?.type === 'cancelled') {
          throw new Error('Génération annulée.');
        }
      }
      return pendingCalls;
    };

    const headers = {
      Authorization: `Bearer ${state.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    const payload = {
      agentId: id,
      initialContent: prompt,
      ...(toolsToSend?.length ? { clientTools: toolsToSend } : {}),
    };
    let pendingCalls = await consumeTurn(await fetch(base + '/chats/stream', {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(payload),
    }));

    let turns = 0;
    while (pendingCalls.length && workspaceRoot && turns < 15) {
      turns++;
      let batchBytes = 0;
      const toolResults = [];
      for (const call of pendingCalls.slice(0, 32)) {
        onToolCall?.(call);
        const res = executeClientTool(workspaceRoot, call, writtenSet);
        let out = String(res.output ?? '');
        if (out.length > MAX_TOOL_OUTPUT) {
          out = out.slice(0, MAX_TOOL_OUTPUT) + '\n[tronqué à 38 000 car. : lis une plage plus étroite]';
        }
        if (batchBytes + out.length > MAX_BATCH_OUTPUT) {
          out = out.slice(0, Math.max(0, MAX_BATCH_OUTPUT - batchBytes));
        }
        batchBytes += out.length;
        toolResults.push({
          callId: call.callId ?? call.call_id,
          output: out,
          ...(res.isError ? { isError: true } : {}),
        });
      }
      pendingCalls = await consumeTurn(await fetch(base + `/chats/${chatId}`, {
        method: 'POST',
        signal,
        headers,
        body: JSON.stringify({ toolResults }),
      }));
    }

    return { text: totalText, usage: lastUsage, written: [...writtenSet] };
  };

  const tryChatWithFallbackTools = async (id) => {
    const tools = (state.useClientTools !== false && workspaceRoot && clientTools?.length) ? clientTools : undefined;
    try {
      return await runChatStream(id, tools);
    } catch (e) {
      // Fallback cleanly without clientTools if account lacks 2026_11_client_tools (403) or model is Gemini (400).
      if (tools && (e?.status === 403 || e?.status === 400)) {
        return await runChatStream(id, undefined);
      }
      throw e;
    }
  };

  if (agentId !== undefined && agentId !== null) {
    return await tryChatWithFallbackTools(agentId);
  }
  try {
    return await runOpenAiResponses();
  } catch (e) {
    if (e?.status === 401 && agentMap?.size) {
      const fallbackId = agentMap.values().next().value;
      return await tryChatWithFallbackTools(fallbackId);
    }
    throw e;
  }
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
