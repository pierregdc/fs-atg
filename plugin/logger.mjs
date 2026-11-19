import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LOG_PATH = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_logs.jsonl');

const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINES = 400;
const KEEP_LOG_LINES = 250;
const VALID_LEVELS = new Set(['info', 'warn', 'error']);
const VALID_SOURCES = new Set(['mcp', 'panel', 'core']);
const SECRET_KEY_RE = /^(?:api[-_]?key|session[-_]?token|access[-_]?token|refresh[-_]?token|token|secret|authorization|password|cookie)$/i;

function redactString(str) {
  return String(str)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/((?:api[-_]?key|sessionToken|token|secret|authorization)\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

export function redactSecrets(value, seen = new WeakSet(), depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 5) return '[truncated]';
  if (typeof value !== 'object') return redactString(String(value));
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSecrets(item, seen, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 40)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redactSecrets(v, seen, depth + 1);
  }
  return out;
}

function rotateIfNeeded() {
  try {
    if (!existsSync(LOG_PATH)) return;
    const size = statSync(LOG_PATH).size;
    if (size <= MAX_LOG_BYTES) {
      // Quick line count check only if moderately large (> 64KB)
      if (size < 64 * 1024) return;
    }
    const raw = readFileSync(LOG_PATH, 'utf-8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    if (size <= MAX_LOG_BYTES && lines.length <= MAX_LOG_LINES) return;
    const trimmed = lines.slice(-KEEP_LOG_LINES).join('\n') + '\n';
    const tmp = `${LOG_PATH}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, trimmed, 'utf-8');
      renameSync(tmp, LOG_PATH);
    } catch {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      writeFileSync(LOG_PATH, trimmed, 'utf-8');
    }
  } catch { /* logging never breaks execution */ }
}

export function logEvent(level, source, event, message, details = null) {
  try {
    const lvl = VALID_LEVELS.has(level) ? level : 'info';
    const src = VALID_SOURCES.has(source) ? source : 'core';
    const entry = {
      ts: new Date().toISOString(),
      ms: Date.now(),
      level: lvl,
      source: src,
      event: String(event ?? 'event'),
      message: redactString(String(message ?? '')).slice(0, 1500),
      ...(details != null ? { details: redactSecrets(details) } : {}),
    };
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
    rotateIfNeeded();
  } catch { /* silent */ }
}

function parseAllLogEntries() {
  try {
    if (!existsSync(LOG_PATH)) return [];
    const lines = readFileSync(LOG_PATH, 'utf-8').split(/\r?\n/);
    const entries = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object') entries.push(parsed);
      } catch { /* ignore malformed line */ }
    }
    return entries;
  } catch {
    return [];
  }
}

export function readLogs({ limit = 40, level = 'all', jobId = '' } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 40));
  const wantedLevel = String(level || 'all').toLowerCase();
  const targetJob = String(jobId || '').trim();
  const entries = parseAllLogEntries();
  const filtered = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (wantedLevel === 'error' && e.level !== 'error') continue;
    if (wantedLevel === 'warn' && e.level !== 'warn' && e.level !== 'error') continue;
    if (targetJob && e.details?.jobId !== targetJob) continue;
    filtered.push(e);
    if (filtered.length >= max) break;
  }
  return filtered;
}

export function countRecentErrors(windowMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - Math.max(0, Number(windowMs) || 0);
  const entries = parseAllLogEntries();
  let count = 0;
  for (const e of entries) {
    if (e.level === 'error' && Number(e.ms ?? 0) >= cutoff) count++;
  }
  return count;
}

export function clearLogs() {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    writeFileSync(LOG_PATH, '', 'utf-8');
    logEvent('info', 'core', 'logs.cleared', 'Journal de bord vidé.');
  } catch { /* ignore */ }
}
