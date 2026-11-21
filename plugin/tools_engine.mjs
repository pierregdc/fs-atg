import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { redactSecrets } from './logger.mjs';
import { workspaceHash } from './memory_store.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
export const UNDO_DIR = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_undo');

export const PERMISSION_MODES = Object.freeze(['plan', 'acceptEdits', 'full']);
export const READ_TOOLS = Object.freeze(['list_directory', 'read_file', 'search_files']);

// Short-lived cache for discovery tools; any mutation clears it entirely.
export const READ_CACHE_TTL_MS = 60_000;
const READ_CACHE = new Map();
export function clearReadCache() { READ_CACHE.clear(); }
export function readCacheSize() { return READ_CACHE.size; }
export const EDIT_TOOLS = Object.freeze(['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file']);
export const FULL_TOOLS = Object.freeze(['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file', 'run_command']);

export const SENSITIVE_FILE_RE = /^(\.env.*|\.npmrc|\.netrc|\.pgpass|(id_rsa|id_ed25519|credentials|secrets?)(\..*)?|.*\.(pem|key|p12|pfx|kdbx|keystore|jks))$/i;

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_UNDO_ENTRIES = 30;
const MAX_UNDO_SNAPSHOT_BYTES = 256 * 1024;
const SNIFF_BYTES = 4096;
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.frst-tmp']);

const DENIED_PROGRAMS = new Set([
  'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'wsl',
  'rm', 'rmdir', 'rd', 'del', 'erase', 'format', 'mkfs', 'dd', 'diskpart',
  'sudo', 'su', 'doas', 'runas',
  'reg', 'schtasks', 'shutdown', 'mshta', 'rundll32', 'regsvr32', 'cscript', 'wscript',
  'curl', 'wget', 'nc', 'netcat', 'ssh', 'scp', 'ftp',
]);

const GIT_DENIED = new Map([
  ['push', 'git push est interdit depuis l’agent.'],
  ['clean', 'git clean supprime des fichiers non suivis : interdit.'],
  ['filter-branch', 'git filter-branch réécrit l’historique : interdit.'],
  ['filter-repo', 'git filter-repo réécrit l’historique : interdit.'],
  ['update-ref', 'git update-ref modifie les références directement : interdit.'],
  ['credential', 'git credential manipule des identifiants : interdit.'],
]);
const GIT_EXEC_FLAGS = ['--upload-pack', '--receive-pack', '--exec', '--exec-path'];
const GIT_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--namespace']);
const NPM_DENIED = new Set(['publish', 'unpublish', 'login', 'logout', 'adduser', 'add-user', 'token', 'owner', 'access', 'hook', 'profile']);
const NODE_EVAL_FLAGS = new Set(['-e', '-p', '--eval', '--print']);
const WINDOWS_SWITCH_RE = /^\/[a-z?]{1,10}$/i;
const SENSITIVE_ENV_RE = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL/i;

/** Returns fixed tool array for the active permission & execution mode. */
export function toolsForPermissionMode(permissionMode = 'acceptEdits', executionMode = 'generate') {
  if (executionMode === 'plan' || executionMode === 'dry-run' || executionMode === 'patch' || permissionMode === 'plan') {
    return READ_TOOLS;
  }
  if (permissionMode === 'full') return FULL_TOOLS;
  return EDIT_TOOLS;
}

/** Clips long text preserving head and tail (often where summaries/errors live). */
export function clipText(text, max = 16_000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const marker = `\n... [tronqué : ${s.length} car., début et fin conservés] ...\n`;
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return s.slice(0, head) + marker + (tail > 0 ? s.slice(-tail) : '');
}

/** Compresses TAP output (node --test) to failures + summary only. */
export function createTapDigest() {
  let pending = '';
  let tap = false;
  let preamble = '';
  let failures = '';
  let failuresOmitted = 0;
  let inFailure = false;
  let passed = 0;
  const summary = [];
  const MAX_PREAMBLE = 1500;
  const MAX_FAILURES = 10_000;
  const SUMMARY_RE = /^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;
  const RESULT_RE = /^\s*(not ok|ok) \d+/;

  function addFailure(lineText) {
    if (failures.length + lineText.length + 1 > MAX_FAILURES) {
      failuresOmitted += lineText.length + 1;
      return;
    }
    failures += `${lineText}\n`;
  }

  function handleLine(raw) {
    const lineText = raw.replace(/\r$/, '');
    if (!tap) {
      if (/^TAP version \d+/.test(lineText)) {
        tap = true;
        return;
      }
      if (preamble.length < MAX_PREAMBLE) {
        preamble += `${lineText}\n`.slice(0, MAX_PREAMBLE - preamble.length);
      }
      return;
    }
    if (SUMMARY_RE.test(lineText)) {
      inFailure = false;
      summary.push(lineText);
      return;
    }
    const resMatch = RESULT_RE.exec(lineText);
    if (resMatch) {
      inFailure = resMatch[1] === 'not ok';
      if (inFailure) addFailure(lineText);
      else passed += 1;
      return;
    }
    if (/^\s*# Subtest:/.test(lineText)) {
      inFailure = false;
      return;
    }
    if (inFailure) addFailure(lineText);
  }

  return {
    push(chunk) {
      pending += String(chunk ?? '');
      const parts = pending.split('\n');
      pending = parts.pop();
      for (const p of parts) handleLine(p);
    },
    render() {
      if (pending) {
        handleLine(pending);
        pending = '';
      }
      if (!tap) return null;
      const out = [];
      if (preamble.trim()) out.push(preamble.trimEnd());
      out.push(`[sortie TAP condensée : ${passed} test(s) réussi(s) omis]`);
      if (failures) {
        out.push(`Échecs :\n${failures.trimEnd()}`);
        if (failuresOmitted) out.push(`[... ${failuresOmitted} car. d'échecs omis ...]`);
      }
      if (summary.length) out.push(summary.join('\n'));
      return out.join('\n\n');
    },
  };
}

/** Compresses command stdout/stderr using TAP digest when applicable or clipText. */
export function digestCommandOutput(output, max = 12_000) {
  const clean = String(output ?? '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  if (/^TAP version \d+/m.test(clean)) {
    const tap = createTapDigest();
    tap.push(clean);
    const digested = tap.render();
    if (digested) return clipText(digested, max);
  }
  return clipText(clean, max);
}

function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function isInsideDir(baseReal, targetReal) {
  const rel = relative(baseReal, targetReal);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertSegmentsSafe(relNorm) {
  const parts = relNorm.split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    if (part === '.git') throw new Error('Accès interdit à .git.');
    if (SENSITIVE_FILE_RE.test(part)) throw new Error(`Fichier sensible interdit : ${part}`);
  }
}

/** Resolves a relative path safely inside workspaceRoot, blocking symlink escapes and sensitive files. */
export function resolveWorkspacePath(workspaceRoot, rawPath = '.') {
  if (!workspaceRoot || !String(workspaceRoot).trim()) throw new Error('workspaceRoot requis.');
  const rootAbs = resolve(String(workspaceRoot));
  const rootReal = existsSync(rootAbs) ? realpathSync(rootAbs) : rootAbs;

  const candidate = String(rawPath ?? '.').trim() || '.';
  if (isAbsolute(candidate)) {
    const relFromRoot = relative(rootAbs, resolve(candidate));
    if (!relFromRoot || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
      if (resolve(candidate).toLowerCase() !== rootAbs.toLowerCase()) {
        throw new Error(`Chemin hors workspace interdit : ${rawPath}`);
      }
    }
  }
  const abs = resolve(rootAbs, candidate);
  const rel = normalize(relative(rootAbs, abs)).replace(/\\/g, '/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`Chemin hors workspace interdit : ${rawPath}`);
  }
  if (rel && rel !== '.') assertSegmentsSafe(rel);

  if (existsSync(abs)) {
    const real = realpathSync(abs);
    if (!isInsideDir(rootReal, real)) throw new Error(`Évasion par lien symbolique interdite : ${rawPath}`);
    try {
      const lst = lstatSync(abs);
      if (lst.isSymbolicLink() && !isInsideDir(rootReal, real)) {
        throw new Error(`Lien symbolique hors workspace interdit : ${rawPath}`);
      }
    } catch (e) {
      if (/interdit/i.test(String(e?.message))) throw e;
    }
  } else {
    let probe = dirname(abs);
    while (probe && probe !== dirname(probe) && !existsSync(probe)) {
      probe = dirname(probe);
    }
    if (existsSync(probe)) {
      const realParent = realpathSync(probe);
      if (!isInsideDir(rootReal, realParent)) {
        throw new Error(`Dossier parent hors workspace interdit : ${rawPath}`);
      }
    }
  }
  return { abs, rel: rel || '.', rootAbs, rootReal };
}

/** Reads UTF-8 text safely, rejecting directories, oversized files, binary files, and invalid UTF-8. */
export function readSafeUtf8(absPath, maxBytes = MAX_READ_BYTES) {
  const st = statSync(absPath);
  if (!st.isFile()) throw new Error('Ce chemin n’est pas un fichier.');
  if (st.size > maxBytes) throw new Error(`Fichier trop grand (${st.size} octets, max ${maxBytes}).`);
  if (st.size === 0) return '';

  const buf = Buffer.allocUnsafe(st.size);
  const fd = openSync(absPath, 'r');
  let offset = 0;
  try {
    const headLen = Math.min(SNIFF_BYTES, st.size);
    const n1 = readSync(fd, buf, 0, headLen, 0);
    offset += n1;
    if (buf.subarray(0, n1).includes(0)) throw new Error('Fichier binaire non pris en charge.');
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
  const bytes = buf.subarray(0, offset);
  if (bytes.includes(0)) throw new Error('Fichier binaire non pris en charge.');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('Fichier non encodé en UTF-8 valide.');
  }
}

/** Atomically writes UTF-8 text via sibling temporary file + rename. */
export function writeAtomicUtf8(absPath, content) {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.fsatg.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  try {
    renameSync(tmp, absPath);
  } catch {
    writeFileSync(absPath, content, 'utf-8');
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function undoFilePath(workspaceRoot) {
  return join(UNDO_DIR, `${workspaceHash(workspaceRoot)}.json`);
}

function loadUndoStack(workspaceRoot) {
  try {
    const p = undoFilePath(workspaceRoot);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUndoStack(workspaceRoot, stack) {
  const p = undoFilePath(workspaceRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeAtomicUtf8(p, JSON.stringify(stack.slice(0, MAX_UNDO_ENTRIES), null, 2));
}

function pushUndoEntry(workspaceRoot, entry) {
  const prevBytes = entry.previousContent != null ? Buffer.byteLength(entry.previousContent, 'utf8') : 0;
  if (prevBytes > MAX_UNDO_SNAPSHOT_BYTES) return null;
  const id = randomUUID().slice(0, 8);
  const fullEntry = { id, at: new Date().toISOString(), ...entry };
  const stack = [fullEntry, ...loadUndoStack(workspaceRoot)].slice(0, MAX_UNDO_ENTRIES);
  saveUndoStack(workspaceRoot, stack);
  return id;
}

/** Lists stored reversible mutations for a workspace (without full content snapshots). */
export function listUndoEntries(workspaceRoot, limit = 15) {
  if (!workspaceRoot) return [];
  return loadUndoStack(workspaceRoot)
    .slice(0, Math.max(1, limit))
    .map(({ id, at, jobId, rel, existedBefore, newSummary }) => ({
      id,
      at,
      jobId: jobId || null,
      rel,
      existedBefore: Boolean(existedBefore),
      summary: newSummary || '',
    }));
}

/** Compact before/after diff (common prefix/suffix trimmed) of a stored mutation versus the current file. */
export function diffTexts(before = '', after = '', context = 3, maxLines = 400) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }
  const out = [];
  const ctxStart = Math.max(0, start - context);
  for (let i = ctxStart; i < start; i += 1) out.push(`  ${a[i]}`);
  for (let i = start; i <= endA; i += 1) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i += 1) out.push(`+ ${b[i]}`);
  for (let i = endA + 1; i < Math.min(a.length, endA + 1 + context); i += 1) out.push(`  ${a[i]}`);
  const removed = Math.max(0, endA - start + 1);
  const added = Math.max(0, endB - start + 1);
  const truncated = out.length > maxLines;
  return { added, removed, truncated, lines: out.slice(0, maxLines), line: start + 1 };
}

export function getUndoDiff(workspaceRoot, undoId) {
  if (!workspaceRoot) throw new Error('workspaceRoot requis.');
  const entry = loadUndoStack(workspaceRoot).find((e) => e.id === undoId);
  if (!entry) return { ok: false, message: `Sauvegarde introuvable : ${undoId}.` };
  const { abs, rel } = resolveWorkspacePath(workspaceRoot, entry.rel);
  const before = entry.existedBefore ? String(entry.previousContent ?? '') : '';
  const after = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
  return { ok: true, id: entry.id, rel, existedBefore: Boolean(entry.existedBefore), ...diffTexts(before, after) };
}

/** Reverts the most recent (or specified) workspace file mutation atomically. */
export function undoLastChange(workspaceRoot, undoId = null) {
  if (!workspaceRoot) throw new Error('workspaceRoot requis pour /undo.');
  const stack = loadUndoStack(workspaceRoot);
  if (!stack.length) return { ok: false, message: 'Aucune modification à annuler.', remaining: 0 };
  const idx = undoId ? stack.findIndex((e) => e.id === undoId) : 0;
  if (idx < 0) return { ok: false, message: `Sauvegarde introuvable : ${undoId}.`, remaining: stack.length };

  const entry = stack[idx];
  const { abs, rel } = resolveWorkspacePath(workspaceRoot, entry.rel);
  let action;
  if (entry.existedBefore) {
    writeAtomicUtf8(abs, String(entry.previousContent ?? ''));
    action = 'restored';
  } else {
    if (existsSync(abs)) unlinkSync(abs);
    action = 'deleted';
  }
  stack.splice(idx, 1);
  saveUndoStack(workspaceRoot, stack);
  return {
    ok: true,
    undone: { id: entry.id, rel, action, at: entry.at },
    remaining: stack.length,
  };
}

/** Tracks hashes & partial reads within a session/job to avoid unsafe overwrites or duplicate full reads. */
export class FreshnessTracker {
  constructor() {
    this.known = new Map();
  }
  record(rel, text, partial = false) {
    this.known.set(rel, { hash: sha256(text), partial: Boolean(partial) });
  }
  get(rel) {
    return this.known.get(rel) ?? null;
  }
  freshProblem(rel, currentText, { allowPartial = false } = {}) {
    const k = this.known.get(rel);
    if (!k) return `${rel} n'a pas encore été lu.`;
    if (k.hash !== sha256(currentText)) return `${rel} a été modifié depuis la dernière lecture.`;
    if (k.partial && !allowPartial) return `${rel} n'a été lu que partiellement.`;
    return null;
  }
}

/** Splits a single command string into argv without spawning a shell; rejects shell metacharacters. */
function parseCommandArgv(commandStr) {
  const s = String(commandStr ?? '').trim();
  if (!s) throw new Error('Commande vide.');
  const tokens = [];
  let cur = '';
  let quote = null;
  let hadToken = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) {
        cur += s[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hadToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hadToken || cur.length) {
        tokens.push(cur);
        cur = '';
        hadToken = false;
      }
      continue;
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '<' || ch === '>' || ch === '`') {
      throw new Error(`Opérateur shell interdit (${ch}) : lance une commande simple directe.`);
    }
    if (ch === '$' && s[i + 1] === '(') {
      throw new Error('Substitution shell $(...) interdite.');
    }
    cur += ch;
    hadToken = true;
  }
  if (quote) throw new Error('Guillemet non fermé dans la commande.');
  if (hadToken || cur.length) tokens.push(cur);
  if (!tokens.length) throw new Error('Commande vide.');
  return tokens;
}

function baseProgramName(prog) {
  const b = win32.basename(String(prog)).toLowerCase();
  const ext = win32.extname(b);
  return ext ? b.slice(0, -ext.length) : b;
}

function looksLikePathArg(val) {
  return /[\\/]/.test(val) || val.startsWith('.') || val.startsWith('~') || /^[a-z]:/i.test(val) || SENSITIVE_FILE_RE.test(val);
}

/** Evaluates a shell-free command against security policy and workspace boundaries. */
export function evaluateCommandPolicy(commandStr, cwd, workspaceRoot) {
  const argv = parseCommandArgv(commandStr);
  const rawProg = argv[0];
  const prog = baseProgramName(rawProg);
  const args = argv.slice(1);

  if (!prog) throw new Error('Programme manquant.');
  if (DENIED_PROGRAMS.has(prog)) throw new Error(`Programme interdit : ${prog}.`);
  if (args.some((a) => /%[^%\s]+%/.test(a) || /^\$[A-Za-z_]/.test(a))) {
    throw new Error('Expansion de variable d’environnement interdite sans shell.');
  }

  const effectiveCwd = cwd ? resolveWorkspacePath(workspaceRoot, cwd).abs : resolve(workspaceRoot);

  if (prog === 'node') {
    for (const a of args) {
      if (a === '--') break;
      if (NODE_EVAL_FLAGS.has(a) || a.startsWith('--eval=') || a.startsWith('--print=') || (/^-[a-z]{2,}$/i.test(a) && /[ep]/i.test(a))) {
        throw new Error(`Option Node inline interdite (${a}). Utilise un fichier .js/.mjs dans le workspace.`);
      }
    }
  } else if (/^(python[0-9.]*w?|py|pypy[0-9.]*)$/.test(prog)) {
    for (const a of args) {
      if (a === '--' || !a.startsWith('-')) break;
      if (/^-[a-z]*c/i.test(a)) throw new Error('Exécution Python inline (-c) interdite.');
    }
  } else if (prog === 'git') {
    let sub = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (GIT_EXEC_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) {
        throw new Error(`Option git dangereuse interdite : ${a}.`);
      }
      if (GIT_VALUE_FLAGS.has(a)) { i += 1; continue; }
      if (a.startsWith('-')) continue;
      sub = a.toLowerCase();
      break;
    }
    if (sub && GIT_DENIED.has(sub)) throw new Error(GIT_DENIED.get(sub));
  } else if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'npx') {
    const sub = args.find((a) => !a.startsWith('-'))?.toLowerCase();
    if (sub && NPM_DENIED.has(sub)) throw new Error(`Sous-commande ${prog} ${sub} interdite.`);
  }

  // Validate all path-like arguments stay inside workspaceRoot and avoid sensitive files.
  const checkArgPath = (candidate) => {
    if (!candidate || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return;
    if (process.platform === 'win32' && WINDOWS_SWITCH_RE.test(candidate) && candidate.length <= 3) return;
    let val = candidate;
    const rev = /^[^\\/:]{2,}:(.*)$/.exec(val);
    if (rev) val = rev[1];
    if (!val || !looksLikePathArg(val)) return;
    const joined = isAbsolute(val) ? val : relative(resolve(workspaceRoot), resolve(effectiveCwd, val));
    resolveWorkspacePath(workspaceRoot, joined);
  };

  if (looksLikePathArg(rawProg)) checkArgPath(rawProg);
  for (const a of args) {
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      if (eq > 0) checkArgPath(a.slice(eq + 1));
    } else {
      checkArgPath(a);
    }
  }

  return { prog: rawProg, baseProg: prog, args, cwd: effectiveCwd };
}

function findNodePackageCli(name) {
  const candidates = [process.execPath];
  for (const exe of candidates) {
    const cli = join(dirname(exe), 'node_modules', 'npm', 'bin', `${name}-cli.js`);
    if (existsSync(cli)) return { file: exe, cli };
  }
  return null;
}

function safeChildEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^FS_/i.test(k) || SENSITIVE_ENV_RE.test(k) || /^FORCE_COLOR$/i.test(k)) continue;
    env[k] = v;
  }
  env.NO_COLOR = '1';
  return env;
}

function buildCompactDiffCount(prevText, nextText) {
  const a = String(prevText).split(/\r?\n/);
  const b = String(nextText).split(/\r?\n/);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return {
    removed: Math.max(0, a.length - prefix - suffix),
    added: Math.max(0, b.length - prefix - suffix),
  };
}

function stripLineNumbers(block) {
  const lines = String(block).split(/\r?\n/);
  const stripped = [];
  for (const l of lines) {
    const m = /^\s*\d+\t(.*)$/.exec(l);
    if (!m) return null;
    stripped.push(m[1]);
  }
  return stripped.join('\n');
}

function normalizeToolCallArgs(name, rawArgs) {
  const a = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  switch (name) {
    case 'list_directory':
      return { path: a.path || '.', depth: Math.min(3, Math.max(1, Number(a.depth) || 2)) };
    case 'read_file': {
      const start = a.start_line ?? a.offset;
      const limit = a.limit != null ? Number(a.limit) : null;
      const end = a.end_line ?? (start != null && limit != null ? Number(start) + limit - 1 : undefined);
      return { path: a.path, start_line: start != null ? Number(start) : undefined, end_line: end != null ? Number(end) : undefined };
    }
    case 'search_files':
      return {
        query: a.query,
        path: a.path || '.',
        glob: a.glob,
        max_results: Math.min(100, Math.max(1, Number(a.max_results) || 50)),
      };
    case 'edit_file':
      return {
        path: a.path,
        old_string: a.old_string ?? a.old_text ?? '',
        new_string: a.new_string ?? a.new_text ?? '',
        replace_all: Boolean(a.replace_all === true || a.replace_all === 'true'),
      };
    case 'write_file':
      return { path: a.path, content: a.content };
    case 'run_command':
      return {
        command: a.command ?? a.name ?? '',
        cwd: a.cwd,
        timeout_ms: a.timeout_ms ?? (a.timeout_seconds != null ? Number(a.timeout_seconds) * 1000 : 30_000),
      };
    default:
      throw new Error(`Outil inconnu : ${name}.`);
  }
}

/** Bounds multiple tool results in a single API turn (32k per tool, 96k total). */
export function fitToolOutputs(results, perResult = 32_000, total = 96_000) {
  const fitted = results.slice();
  const order = results.map((_, i) => i).sort((a, b) => String(results[a].output || '').length - String(results[b].output || '').length);
  let remaining = total;
  order.forEach((idx, rank) => {
    const share = Math.floor(remaining / (order.length - rank));
    const clipped = clipText(results[idx].output ?? '', Math.min(perResult, Math.max(512, share)));
    fitted[idx] = { ...results[idx], output: clipped };
    remaining -= clipped.length;
  });
  return fitted;
}

/** Creates an isolated, permission-enforced workspace tool runner for one delegation job. */
export function createWorkspaceToolRunner({ workspaceRoot, permissionMode = 'acceptEdits', jobId = null, onMutation, onCommand }) {
  const freshness = new FreshnessTracker();
  const mutations = new Map();
  const commandsRun = [];
  const allowedTools = new Set(toolsForPermissionMode(permissionMode));

  function recordMutation(rel, info) {
    const prev = mutations.get(rel);
    mutations.set(rel, {
      path: rel,
      action: info.action,
      added: (prev?.added ?? 0) + (info.added ?? 0),
      removed: (prev?.removed ?? 0) + (info.removed ?? 0),
      undoId: info.undoId || prev?.undoId || null,
      charsWritten: (prev?.charsWritten ?? 0) + (info.charsWritten ?? 0),
    });
    onMutation?.([...mutations.values()]);
  }

  function runListDirectory({ path: relPath, depth }) {
    const { abs, rel } = resolveWorkspacePath(workspaceRoot, relPath);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Dossier introuvable : ${rel}`);
    const lines = [];
    const MAX_LINES = 160;
    const walk = (dirAbs, prefix, curDepth) => {
      if (lines.length >= MAX_LINES) return;
      let entries;
      try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
      entries
        .filter((e) => !e.isSymbolicLink() && (e.isDirectory() || e.isFile()) && !IGNORE_DIRS.has(e.name) && !SENSITIVE_FILE_RE.test(e.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'fr'))
        .forEach((e) => {
          if (lines.length >= MAX_LINES) return;
          if (e.isDirectory()) {
            lines.push(`${prefix}${e.name}/`);
            if (curDepth < depth) walk(join(dirAbs, e.name), `${prefix}  `, curDepth + 1);
          } else {
            lines.push(`${prefix}${e.name}`);
          }
        });
    };
    walk(abs, '', 1);
    if (!lines.length) return '(dossier vide)';
    if (lines.length >= MAX_LINES) lines.push(`... [limité à ${MAX_LINES} entrées]`);
    return lines.join('\n');
  }

  function runReadFile({ path: relPath, start_line, end_line }) {
    if (!relPath) throw new Error('Paramètre path manquant.');
    const { abs, rel } = resolveWorkspacePath(workspaceRoot, relPath);
    const text = readSafeUtf8(abs);
    const partial = start_line != null || end_line != null;
    const prev = freshness.get(rel);
    if (!partial && prev && !prev.partial && prev.hash === sha256(text)) {
      return `[Déjà lu en entier et inchangé (${text.split(/\r?\n/).length} lignes) — utilise start_line/end_line si besoin d'une plage]`;
    }
    const allLines = text.split(/\r?\n/);
    const s = Math.max(1, start_line ?? 1);
    const e = Math.min(allLines.length, end_line ?? (s + 399));
    freshness.record(rel, text, partial && (s > 1 || e < allLines.length));
    const slice = allLines.slice(s - 1, e).map((l, idx) => `${s + idx}\t${l}`).join('\n');
    const note = e < allLines.length ? `\n[Lignes ${s}-${e} sur ${allLines.length}]` : '';
    return clipText(slice + note, 24_000);
  }

  function runSearchFiles({ query, path: relPath, glob, max_results }) {
    if (!query || !String(query).trim()) throw new Error('Requête search_files vide.');
    const qRaw = String(query);
    let filesOnly = false;
    let qClean = qRaw;
    if (qClean.startsWith('files:')) { filesOnly = true; qClean = qClean.slice(6); }
    let matcher;
    if (qClean.startsWith('literal:')) {
      const lit = qClean.slice(8).toLowerCase();
      matcher = (line) => line.toLowerCase().includes(lit);
    } else {
      try {
        const rx = new RegExp(qClean.startsWith('regex:') ? qClean.slice(6) : qClean, 'i');
        matcher = (line) => rx.test(line);
      } catch {
        const lit = qClean.toLowerCase();
        matcher = (line) => line.toLowerCase().includes(lit);
      }
    }
    const globRx = glob
      ? new RegExp('^' + String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
      : null;

    const { abs, rootAbs } = resolveWorkspacePath(workspaceRoot, relPath);
    const grouped = new Map();
    let totalMatches = 0;

    const scanFile = (fileAbs) => {
      if (totalMatches >= max_results) return;
      const name = basename(fileAbs);
      if (SENSITIVE_FILE_RE.test(name)) return;
      if (globRx && !globRx.test(name)) return;
      let text;
      try { text = readSafeUtf8(fileAbs, 256 * 1024); } catch { return; }
      const fileRel = relative(rootAbs, fileAbs).replace(/\\/g, '/');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && totalMatches < max_results; i++) {
        if (matcher(lines[i])) {
          const hits = grouped.get(fileRel) || [];
          hits.push(`${i + 1}: ${lines[i].trim().slice(0, 140)}`);
          grouped.set(fileRel, hits);
          totalMatches += 1;
          if (filesOnly) break;
        }
      }
    };

    const walk = (dirAbs) => {
      if (totalMatches >= max_results) return;
      let st;
      try { st = statSync(dirAbs); } catch { return; }
      if (st.isFile()) { scanFile(dirAbs); return; }
      if (!st.isDirectory()) return;
      let entries;
      try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (totalMatches >= max_results) break;
        if (e.isSymbolicLink() || IGNORE_DIRS.has(e.name) || SENSITIVE_FILE_RE.test(e.name)) continue;
        const p = join(dirAbs, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) scanFile(p);
      }
    };
    walk(abs);
    if (!grouped.size) return 'Aucune correspondance.';
    const out = [];
    for (const [f, hits] of grouped.entries()) {
      out.push(filesOnly ? f : `${f}\n${hits.map((h) => `  ${h}`).join('\n')}`);
    }
    return clipText(out.join('\n'), 18_000);
  }

  function runEditFile({ path: relPath, old_string, new_string, replace_all }) {
    if (!relPath) throw new Error('Paramètre path manquant.');
    if (!old_string) throw new Error('old_string doit être non vide.');
    const { abs, rel } = resolveWorkspacePath(workspaceRoot, relPath);
    if (!existsSync(abs)) throw new Error(`Fichier introuvable : ${rel}. Utilise write_file pour le créer.`);
    const previous = readSafeUtf8(abs);

    if (old_string === new_string) return `Aucun changement : texte déjà présent dans ${rel}.`;

    let needle = old_string;
    let repl = new_string;
    if (!previous.includes(needle) && previous.includes('\r\n')) {
      needle = needle.replace(/\r?\n/g, '\r\n');
      repl = repl.replace(/\r?\n/g, '\r\n');
    }
    let count = previous.split(needle).length - 1;
    if (count === 0) {
      const stripped = stripLineNumbers(needle);
      if (stripped !== null) {
        needle = previous.includes('\r\n') ? stripped.replace(/\r?\n/g, '\r\n') : stripped;
        const replStripped = stripLineNumbers(repl);
        if (replStripped !== null) repl = previous.includes('\r\n') ? replStripped.replace(/\r?\n/g, '\r\n') : replStripped;
        count = previous.split(needle).length - 1;
      }
    }
    if (count === 0) throw new Error(`old_string introuvable dans ${rel}. Relis la plage exacte avec read_file.`);
    if (count > 1 && !replace_all) throw new Error(`old_string apparaît ${count} fois dans ${rel}. Ajoute du contexte ou passe replace_all: true.`);

    const updated = replace_all ? previous.split(needle).join(repl) : previous.replace(needle, () => repl);
    if (Buffer.byteLength(updated, 'utf8') > MAX_WRITE_BYTES) throw new Error('Fichier modifié trop grand.');

    const { added, removed } = buildCompactDiffCount(previous, updated);
    const undoId = pushUndoEntry(workspaceRoot, {
      jobId,
      rel,
      existedBefore: true,
      previousContent: previous,
      newSummary: `edit +${added} -${removed}`,
    });
    writeAtomicUtf8(abs, updated);
    freshness.record(rel, updated, false);
    recordMutation(rel, { action: 'edited', added, removed, undoId, charsWritten: Math.abs(repl.length - needle.length) + repl.length });
    return `OK ${rel} : +${added} -${removed} ligne(s)${undoId ? ` [undo:${undoId}]` : ''}`;
  }

  function runWriteFile({ path: relPath, content }) {
    if (!relPath) throw new Error('Paramètre path manquant.');
    if (typeof content !== 'string') throw new Error('content doit être une chaîne.');
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error('Contenu trop grand.');
    const { abs, rel } = resolveWorkspacePath(workspaceRoot, relPath);
    const existed = existsSync(abs);
    let previous = '';
    if (existed) {
      previous = readSafeUtf8(abs);
      const err = freshness.freshProblem(rel, previous, { allowPartial: false });
      if (err) throw new Error(`${err} Relis le fichier complet ou utilise edit_file.`);
    }
    const { added, removed } = existed ? buildCompactDiffCount(previous, content) : { added: content.split(/\r?\n/).length, removed: 0 };
    const undoId = pushUndoEntry(workspaceRoot, {
      jobId,
      rel,
      existedBefore: existed,
      previousContent: existed ? previous : null,
      newSummary: `${existed ? 'overwrite' : 'create'} +${added} -${removed}`,
    });
    writeAtomicUtf8(abs, content);
    freshness.record(rel, content, false);
    recordMutation(rel, { action: existed ? 'overwritten' : 'created', added, removed, undoId, charsWritten: content.length });
    return `OK ${rel} (${existed ? 'réécrit' : 'créé'}, +${added} -${removed} ligne(s))${undoId ? ` [undo:${undoId}]` : ''}`;
  }

  async function runShellSafe({ command, cwd, timeout_ms }) {
    const policy = evaluateCommandPolicy(command, cwd, workspaceRoot);
    const timeout = Math.min(120_000, Math.max(1_000, Number(timeout_ms) || 30_000));
    const t0 = Date.now();
    let execFileTarget = policy.prog;
    let execArgs = policy.args;
    if (process.platform === 'win32' && (policy.baseProg === 'npm' || policy.baseProg === 'npx')) {
      const cli = findNodePackageCli(policy.baseProg);
      if (cli) {
        execFileTarget = cli.file;
        execArgs = [cli.cli, ...policy.args];
      }
    }
    let exitCode = 0;
    let combined = '';
    try {
      const { stdout, stderr } = await execFileAsync(execFileTarget, execArgs, {
        cwd: policy.cwd,
        shell: false,
        windowsHide: true,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        env: safeChildEnv(),
      });
      combined = [stdout, stderr].filter(Boolean).join('\n');
    } catch (err) {
      exitCode = Number.isInteger(err?.code) ? err.code : (err?.killed ? 124 : 1);
      combined = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n');
    }
    const durationMs = Date.now() - t0;
    const digested = redactSecrets(digestCommandOutput(combined, 12_000));
    commandsRun.push({ command: String(command).slice(0, 140), exitCode, durationMs });
    onCommand?.([...commandsRun]);
    return `exit=${exitCode} (${durationMs}ms)\n${digested || '(aucune sortie)'}`;
  }

  return {
    async execute(call) {
      if (call.argsError) return { callId: call.callId, output: `Erreur arguments : ${call.argsError}`, isError: true };
      if (!allowedTools.has(call.name)) {
        return { callId: call.callId, output: `Outil « ${call.name} » non autorisé en mode « ${permissionMode} ».`, isError: true };
      }
      try {
        const args = normalizeToolCallArgs(call.name, call.arguments);
        let output;
        const cacheable = call.name === 'list_directory' || call.name === 'search_files';
        const cacheKey = cacheable ? `${workspaceRoot}\u0000${call.name}\u0000${JSON.stringify(args)}` : '';
        if (cacheable) {
          const hit = READ_CACHE.get(cacheKey);
          if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) {
            return { callId: call.callId, output: hit.output };
          }
        }
        switch (call.name) {
          case 'list_directory': output = runListDirectory(args); break;
          case 'read_file': output = runReadFile(args); break;
          case 'search_files': output = runSearchFiles(args); break;
          case 'edit_file': output = runEditFile(args); break;
          case 'write_file': output = runWriteFile(args); break;
          case 'run_command': output = await runShellSafe(args); break;
          default: throw new Error(`Outil inconnu : ${call.name}`);
        }
        if (cacheable) READ_CACHE.set(cacheKey, { at: Date.now(), output: String(output ?? '') });
        else if (call.name === 'edit_file' || call.name === 'write_file' || call.name === 'run_command') clearReadCache();
        return { callId: call.callId, output: String(output ?? '') };
      } catch (err) {
        return { callId: call.callId, output: `Erreur ${call.name} : ${err?.message ?? err}`, isError: true };
      }
    },
    getFilesWritten() { return [...mutations.values()]; },
    getCommandsRun() { return [...commandsRun]; },
  };
}
