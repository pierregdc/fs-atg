import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MEMORY_DIR = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_memory');

const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 240;
const MAX_PREPROMPT_CHARS = 1500;
const MAX_FACTS_STORED = 40;
const MAX_FACTS_SHOWN = 8;
const MIN_SIGNAL_COUNT = 3;
const MAX_INSTRUCTIONS_CHARS = 2000;
const MAX_ANNEX_CHARS = 3000;

const SENSITIVE_ENTRY_RE = /^(?:\.git|node_modules|\.env.*|\.npmrc|\.netrc|\.pgpass|(?:id_rsa|id_ed25519|credentials|secrets?)(?:\..*)?|.*\.(?:pem|key|p12|pfx|kdbx|keystore|jks))$/i;

const SIGNAL_PATTERNS = [
  ['TypeScript', /\btypescript\b|\.tsx?\b/i],
  ['Python', /\bpython\b|\.py\b/i],
  ['React', /\breact\b|\.jsx\b/i],
  ['Node.js', /\bnode(?:\.js)?\b|\bmjs\b|\bnpm\b/i],
  ['CSS/UI', /\bcss\b|\bhtml\b|\bui\b|\binterface\b/i],
  ['Tests', /\btests?\b|\bassert\b/i],
  ['Git', /\bgit\b|\bcommits?\b/i],
  ['SQL', /\bsql\b|\bsqlite\b|\bpostgres\b/i],
  ['API', /\bapi\b|\bfetch\b|\brest\b|\bsse\b/i],
];

const PLATFORMS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** SHA-256 (12 hex chars) of the normalized lowercase workspace path. */
export function workspaceHash(workspaceRoot) {
  if (!workspaceRoot || !String(workspaceRoot).trim()) return 'global';
  const normalized = resolve(String(workspaceRoot)).toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

function clipMiddle(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const marker = '\n…[tronqué]…\n';
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil(room * 0.65);
  const tail = room - head;
  return s.slice(0, head) + marker + (tail > 0 ? s.slice(-tail) : '');
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback();
    const raw = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback();
  } catch {
    return fallback();
  }
}

function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const payload = JSON.stringify(data, null, 2);
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  writeFileSync(tmp, payload, 'utf-8');
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, payload, 'utf-8');
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function globalProfilePath() {
  return join(MEMORY_DIR, 'profile.json');
}

function projectMemoryPath(workspaceRoot) {
  return join(MEMORY_DIR, `${workspaceHash(workspaceRoot)}.json`);
}

function emptyProjectData() {
  return { notes: [], preprompt: '', facts: [], signals: {} };
}

function normalizeStore(raw) {
  return {
    notes: Array.isArray(raw?.notes)
      ? raw.notes.filter((n) => n && typeof n.text === 'string' && n.text.trim())
      : [],
    preprompt: typeof raw?.preprompt === 'string' ? raw.preprompt : '',
    facts: Array.isArray(raw?.facts)
      ? raw.facts.filter((f) => f && typeof f.text === 'string' && Number.isFinite(f.weight))
      : [],
    signals: raw?.signals && typeof raw.signals === 'object' ? { ...raw.signals } : {},
  };
}

function loadGlobalProfile() {
  return normalizeStore(readJsonSafe(globalProfilePath(), emptyProjectData));
}

function loadProjectStore(workspaceRoot) {
  if (!workspaceRoot || !String(workspaceRoot).trim()) return loadGlobalProfile();
  return normalizeStore(readJsonSafe(projectMemoryPath(workspaceRoot), emptyProjectData));
}

function saveStore(workspaceRoot, data) {
  const path = workspaceRoot && String(workspaceRoot).trim()
    ? projectMemoryPath(workspaceRoot)
    : globalProfilePath();
  writeJsonAtomic(path, data);
}

/** Returns merged project + global facts/preprompt snapshot and project notes. */
export function getProjectMemory(workspaceRoot) {
  const globalData = loadGlobalProfile();
  const hasWs = Boolean(workspaceRoot && String(workspaceRoot).trim());
  const projData = hasWs ? loadProjectStore(workspaceRoot) : globalData;
  const combinedPreprompt = [globalData.preprompt, hasWs ? projData.preprompt : '']
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_PREPROMPT_CHARS);
  const factsMap = new Map();
  for (const f of [...(hasWs ? globalData.facts : []), ...projData.facts]) {
    const k = f.text.toLowerCase();
    const prev = factsMap.get(k);
    if (!prev || f.weight > prev.weight) factsMap.set(k, { ...f });
  }
  const facts = [...factsMap.values()].sort((a, b) => b.weight - a.weight || String(b.at || '').localeCompare(String(a.at || '')));
  return {
    workspaceHash: workspaceHash(workspaceRoot),
    notes: projData.notes,
    preprompt: hasWs ? projData.preprompt : globalData.preprompt,
    globalPreprompt: globalData.preprompt,
    effectivePreprompt: combinedPreprompt,
    facts,
  };
}

/** Adds a deduplicated persistent note (max 40 notes, 240 chars each). */
export function addProjectNote(workspaceRoot, text) {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
  if (!cleaned) throw new Error('Note vide.');
  const store = loadProjectStore(workspaceRoot);
  const low = cleaned.toLowerCase();
  const existing = store.notes.find((n) => n.text.toLowerCase() === low);
  if (existing) {
    existing.at = new Date().toISOString();
    saveStore(workspaceRoot, store);
    return { added: false, note: existing, total: store.notes.length };
  }
  const note = { id: randomUUID().slice(0, 8), text: cleaned, at: new Date().toISOString() };
  store.notes = [note, ...store.notes].slice(0, MAX_NOTES);
  saveStore(workspaceRoot, store);
  return { added: true, note, total: store.notes.length };
}

/** Removes a project note by id or 1-based index. */
export function removeProjectNote(workspaceRoot, idOrIndex) {
  const store = loadProjectStore(workspaceRoot);
  const key = String(idOrIndex ?? '').trim();
  const before = store.notes.length;
  let removed = null;
  if (/^\d+$/.test(key)) {
    const idx = Number(key) - 1;
    if (idx >= 0 && idx < store.notes.length) {
      removed = store.notes[idx];
      store.notes.splice(idx, 1);
    }
  } else {
    const idx = store.notes.findIndex((n) => n.id === key || n.text.toLowerCase() === key.toLowerCase());
    if (idx >= 0) {
      removed = store.notes[idx];
      store.notes.splice(idx, 1);
    }
  }
  if (store.notes.length !== before) saveStore(workspaceRoot, store);
  return { removed, total: store.notes.length };
}

/** Clears project notes, preprompt, facts, and signal counters. */
export function clearProjectMemory(workspaceRoot) {
  const empty = emptyProjectData();
  saveStore(workspaceRoot, empty);
  return { cleared: true, workspaceHash: workspaceHash(workspaceRoot) };
}

/** Sets persistent preprompt (global when !workspaceRoot, project-scoped otherwise). */
export function setPreprompt(workspaceRoot, text) {
  const cleaned = String(text ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_PREPROMPT_CHARS);
  const store = loadProjectStore(workspaceRoot);
  store.preprompt = cleaned;
  saveStore(workspaceRoot, store);
  return { scope: workspaceRoot ? 'project' : 'global', preprompt: cleaned };
}

function reinforceInStore(store, factText, delta = 1) {
  const cleanFact = String(factText ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
  if (!cleanFact) return null;
  const now = new Date().toISOString();
  const low = cleanFact.toLowerCase();
  let entry = store.facts.find((f) => f.text.toLowerCase() === low);
  if (entry) {
    entry.weight = Number(entry.weight || 0) + delta;
    entry.at = now;
  } else {
    entry = { text: cleanFact, weight: delta, at: now };
    store.facts.push(entry);
  }
  store.facts.sort((a, b) => b.weight - a.weight || String(b.at || '').localeCompare(String(a.at || '')));
  store.facts = store.facts.slice(0, MAX_FACTS_STORED);
  return entry;
}

/** Reinforces a learned fact in project memory (or global profile if no workspaceRoot). */
export function learnFact(workspaceRoot, text) {
  const entry = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!entry) throw new Error('Fait vide.');
  const store = loadProjectStore(workspaceRoot);
  const saved = reinforceInStore(store, entry, 1);
  saveStore(workspaceRoot, store);
  return saved;
}

/** Removes a learned fact by 1-based index or text match. */
export function forgetFact(workspaceRoot, indexOrText) {
  const store = loadProjectStore(workspaceRoot);
  const key = String(indexOrText ?? '').trim();
  const sorted = [...store.facts].sort((a, b) => b.weight - a.weight);
  let targetText = null;
  if (/^\d+$/.test(key)) {
    const idx = Number(key) - 1;
    if (idx >= 0 && idx < sorted.length) targetText = sorted[idx].text;
  } else if (key) {
    const hit = store.facts.find((f) => f.text.toLowerCase() === key.toLowerCase() || f.text.toLowerCase().includes(key.toLowerCase()));
    if (hit) targetText = hit.text;
  }
  if (!targetText) return { removed: null, total: store.facts.length };
  store.facts = store.facts.filter((f) => f.text !== targetText);
  saveStore(workspaceRoot, store);
  return { removed: targetText, total: store.facts.length };
}

/** Detects recurring stack/workflow signals in prompts; reinforces facts at >= 3 mentions. */
export function observePromptSignals(workspaceRoot, promptText) {
  const text = String(promptText ?? '');
  if (!text.trim()) return [];
  const store = loadProjectStore(workspaceRoot);
  const reinforced = [];
  let dirty = false;
  for (const [label, re] of SIGNAL_PATTERNS) {
    if (!re.test(text)) continue;
    dirty = true;
    const count = Number(store.signals[label] ?? 0) + 1;
    store.signals[label] = count;
    if (count >= MIN_SIGNAL_COUNT) {
      const factLabel = `Sujet récurrent du projet : ${label}`;
      const existing = store.facts.find((f) => f.text === factLabel);
      const entry = reinforceInStore(store, factLabel, existing ? 1 : count);
      if (entry) reinforced.push(entry);
    }
  }
  if (dirty) saveStore(workspaceRoot, store);
  return reinforced;
}

/** Reads hierarchical FRST.md / FRSTCLI.md in parent and workspace root. */
export function readProjectInstructions(workspaceRoot) {
  if (!workspaceRoot || !String(workspaceRoot).trim()) return '';
  const absRoot = resolve(String(workspaceRoot));
  const parentDir = dirname(absRoot);
  const dirs = parentDir && parentDir !== absRoot ? [parentDir, absRoot] : [absRoot];
  const chunks = [];
  for (const dir of dirs) {
    for (const name of ['FRST.md', 'FRSTCLI.md']) {
      const p = join(dir, name);
      try {
        if (!existsSync(p) || !statSync(p).isFile()) continue;
        const body = readFileSync(p, 'utf-8').replace(/^\uFEFF/, '').trim();
        if (body) chunks.push(`[${name} (${dir === absRoot ? 'projet' : 'parent'})]\n${clipMiddle(body, 1200)}`);
      } catch { /* ignore unreadable instruction file */ }
    }
  }
  return clipMiddle(chunks.join('\n\n'), MAX_INSTRUCTIONS_CHARS);
}

function readGitBranch(workspaceRoot) {
  let dir = resolve(workspaceRoot);
  for (let i = 0; i < 8; i++) {
    const dotGit = join(dir, '.git');
    try {
      const st = statSync(dotGit);
      let headPath = null;
      if (st.isDirectory()) headPath = join(dotGit, 'HEAD');
      else if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf-8'));
        if (m) headPath = join(resolve(dir, m[1]), 'HEAD');
      }
      if (headPath && existsSync(headPath)) {
        const head = readFileSync(headPath, 'utf-8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return ref[1].slice(0, 80);
        if (/^[0-9a-f]{7,64}$/i.test(head)) return head.slice(0, 7);
      }
    } catch { /* keep climbing */ }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Builds a compact ~300-800 char environment snapshot without spawning any shell. */
export function buildShortContext(workspaceRoot) {
  if (!workspaceRoot || !String(workspaceRoot).trim()) return '';
  const abs = resolve(String(workspaceRoot));
  const osLabel = PLATFORMS[process.platform] || process.platform;
  const parts = [`OS: ${osLabel}`];
  const branch = readGitBranch(abs);
  if (branch) parts.push(`Git: ${branch}`);

  const pkgPath = join(abs, 'package.json');
  try {
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const scripts = ['test', 'build', 'lint']
        .filter((k) => typeof pkg?.scripts?.[k] === 'string')
        .map((k) => `${k}=\"${pkg.scripts[k].slice(0, 60)}\"`);
      const pkgBits = [pkg?.name ? `pkg=${pkg.name}` : null, ...scripts].filter(Boolean);
      if (pkgBits.length) parts.push(pkgBits.join(' '));
    }
  } catch { /* ignore invalid package.json */ }

  let top = [];
  try {
    const entries = readdirSync(abs, { withFileTypes: true });
    top = entries
      .filter((e) => !e.isSymbolicLink() && (e.isDirectory() || e.isFile()) && !SENSITIVE_ENTRY_RE.test(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'fr'))
      .slice(0, 24)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch { /* ignore */ }

  const header = parts.join(' | ');
  const treeLine = top.length ? `Racine: ${top.join(', ')}` : '';
  return clipMiddle([header, treeLine].filter(Boolean).join('\n'), 800);
}

/** Assembles turn-1 project memory, preprompt, learned facts, instructions, and short context (<= 3000 chars). */
export function buildTurn1Annex(workspaceRoot, { includeShortContext = false } = {}) {
  const mem = getProjectMemory(workspaceRoot);
  const blocks = [];
  if (mem.effectivePreprompt) blocks.push(`Pré-prompt :\n${mem.effectivePreprompt}`);
  const topFacts = mem.facts.slice(0, MAX_FACTS_SHOWN);
  if (topFacts.length) blocks.push(`Faits retenus :\n${topFacts.map((f) => `- ${f.text}`).join('\n')}`);
  if (mem.notes.length) {
    blocks.push(`Notes projet (/remember) :\n${mem.notes.slice(0, 10).map((n) => `- ${n.text}`).join('\n')}`);
  }
  const inst = readProjectInstructions(workspaceRoot);
  if (inst) blocks.push(`Instructions projet :\n${inst}`);
  if (includeShortContext) {
    const sc = buildShortContext(workspaceRoot);
    if (sc) blocks.push(`Contexte court :\n${sc}`);
  }
  return clipMiddle(blocks.join('\n\n'), MAX_ANNEX_CHARS);
}
