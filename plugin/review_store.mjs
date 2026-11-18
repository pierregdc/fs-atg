import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_PATH, resolveSafe } from './fs_core.mjs';

export const REVIEW_TTL_MS = 24 * 60 * 60 * 1000;
export const REVIEW_MAX_FILE_BYTES = 256 * 1024;
export const REVIEW_MAX_TOTAL_BYTES = 768 * 1024;
export const REVIEW_DIR = join(dirname(STATE_PATH), '.fsatg_reviews');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const reviewPath = (id, storeDir = REVIEW_DIR) => join(storeDir, `${id}.json`);
const SENSITIVE_REVIEW_PATH = /(^|\/)(?:\.env[^/]*|id_rsa(?:\.pub)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))(?:\/|$)/i;

function textFile(abs) {
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

function compactDiff(before, after) {
  if (before === after) return 'Aucun changement.';
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) { oldEnd--; newEnd--; }
  const removed = oldLines.slice(start, Math.min(oldEnd + 1, start + 50));
  const added = newLines.slice(start, Math.min(newEnd + 1, start + 50));
  const lines = [`@@ ligne ${start + 1} @@`];
  if (removed.length) lines.push(...removed.map((line) => `- ${line}`));
  if (oldEnd - start + 1 > removed.length) lines.push('- …');
  if (added.length) lines.push(...added.map((line) => `+ ${line}`));
  if (newEnd - start + 1 > added.length) lines.push('+ …');
  return lines.join('\n');
}

export function publicReview(record) {
  if (!record) return null;
  return {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    appliedAt: record.appliedAt ?? null,
    undoneAt: record.undoneAt ?? null,
    recoveryError: record.recoveryError ?? null,
    files: (record.changes ?? []).map((change) => ({
      path: change.path,
      action: change.existed ? 'modify' : 'create',
      diff: change.diff,
    })),
    canApply: record.status === 'pending' && Date.now() <= record.expiresAt,
    canUndo: record.status === 'applied' && Date.now() <= record.expiresAt,
  };
}

export function cleanupReviews(storeDir = REVIEW_DIR, now = Date.now()) {
  try {
    if (!existsSync(storeDir)) return 0;
    let removed = 0;
    for (const name of readdirSync(storeDir)) {
      if (!/^[a-f0-9-]{16,64}\.json$/i.test(name)) continue;
      const path = join(storeDir, name);
      if (now - statSync(path).mtimeMs > REVIEW_TTL_MS) {
        unlinkSync(path);
        removed++;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

function save(record, storeDir) {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const target = reviewPath(record.id, storeDir);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
  }
}

export function loadReview(id, { storeDir = REVIEW_DIR } = {}) {
  if (!/^[a-f0-9-]{16,64}$/i.test(String(id ?? ''))) throw new Error('Identifiant de revue invalide.');
  const path = reviewPath(id, storeDir);
  if (!existsSync(path)) throw new Error('Revue introuvable ou expirée.');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (Date.now() > Number(record.expiresAt ?? 0)) {
    unlinkSync(path);
    throw new Error('Revue expirée ; relance un dry-run.');
  }
  return record;
}

/** Stages text file blocks locally. Nothing in this function writes the workspace. */
export function stageReview(workspaceRoot, blocks, { storeDir = REVIEW_DIR, now = Date.now() } = {}) {
  if (!workspaceRoot) throw new Error('Un workspace est requis pour la revue.');
  if (!Array.isArray(blocks) || !blocks.length) return null;
  cleanupReviews(storeDir, now);
  let bytes = 0;
  const changes = [];
  const seen = new Set();
  for (const block of blocks) {
    const requestedPath = String(block?.path ?? '').trim();
    const content = String(block?.content ?? '');
    if (!requestedPath) throw new Error('Chemin de revue invalide ou dupliqué : (vide).');
    const { rel: path, abs } = resolveSafe(workspaceRoot, requestedPath);
    if (SENSITIVE_REVIEW_PATH.test(path)) {
      throw new Error(`Chemin sensible exclu de la revue persistante : ${path}.`);
    }
    if (seen.has(path)) throw new Error(`Chemin de revue invalide ou dupliqué : ${path}.`);
    seen.add(path);
    const existed = existsSync(abs);
    const before = existed ? textFile(abs) : '';
    const fileBytes = Buffer.byteLength(before, 'utf8') + Buffer.byteLength(content, 'utf8');
    if (fileBytes > REVIEW_MAX_FILE_BYTES) throw new Error(`Revue trop volumineuse pour ${path} (maximum 256 Ko).`);
    bytes += fileBytes;
    if (bytes > REVIEW_MAX_TOTAL_BYTES) throw new Error('Revue trop volumineuse (maximum 768 Ko).');
    changes.push({
      path,
      content,
      existed,
      before,
      beforeHash: sha256(before),
      afterHash: sha256(content),
      diff: compactDiff(before, content),
    });
  }
  const record = {
    schema: 1,
    id: randomUUID(),
    workspaceRoot,
    status: 'pending',
    createdAt: now,
    expiresAt: now + REVIEW_TTL_MS,
    changes,
  };
  save(record, storeDir);
  return publicReview(record);
}

function writeChange(workspaceRoot, change, content) {
  const { abs } = resolveSafe(workspaceRoot, change.path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function rollbackAppliedChanges(record, applied) {
  const failures = [];
  for (const change of [...applied].reverse()) {
    try {
      const { abs } = resolveSafe(record.workspaceRoot, change.path);
      if (change.existed) writeChange(record.workspaceRoot, change, change.before);
      else if (existsSync(abs)) unlinkSync(abs);
    } catch (error) {
      failures.push(`${change.path}: ${String(error?.message ?? error)}`);
    }
  }
  return failures;
}

export function applyReview(id, { storeDir = REVIEW_DIR } = {}) {
  const record = loadReview(id, { storeDir });
  if (record.status !== 'pending') throw new Error('Cette revue a déjà été appliquée, annulée ou est expirée.');
  for (const change of record.changes ?? []) {
    const { abs } = resolveSafe(record.workspaceRoot, change.path);
    if (change.existed) {
      if (!existsSync(abs) || sha256(textFile(abs)) !== change.beforeHash) {
        throw new Error(`Le fichier a changé depuis le dry-run : ${change.path}. Relance une revue.`);
      }
    } else if (existsSync(abs)) {
      throw new Error(`Le fichier existe désormais : ${change.path}. Relance une revue.`);
    }
  }
  const applied = [];
  try {
    for (const change of record.changes ?? []) {
      applied.push(change);
      writeChange(record.workspaceRoot, change, change.content);
    }
    record.status = 'applied';
    record.appliedAt = Date.now();
    save(record, storeDir);
  } catch (error) {
    const rollbackFailures = rollbackAppliedChanges(record, applied);
    record.status = rollbackFailures.length ? 'recovery-required' : 'pending';
    delete record.appliedAt;
    if (rollbackFailures.length) record.recoveryError = rollbackFailures.join(' | ');
    else delete record.recoveryError;
    try { save(record, storeDir); } catch { /* the original record stays as the recovery source */ }
    const suffix = rollbackFailures.length ? ` Restauration partielle impossible : ${rollbackFailures.join(' | ')}` : '';
    throw new Error(`Application interrompue ; les fichiers déjà écrits ont été restaurés.${suffix} ${String(error?.message ?? error)}`.trim());
  }
  return publicReview(record);
}

export function undoReview(id, { storeDir = REVIEW_DIR } = {}) {
  const record = loadReview(id, { storeDir });
  if (record.status !== 'applied') throw new Error('Seule une revue appliquée peut être restaurée.');
  for (const change of record.changes ?? []) {
    const { abs } = resolveSafe(record.workspaceRoot, change.path);
    if (!existsSync(abs) || sha256(textFile(abs)) !== change.afterHash) {
      throw new Error(`Le fichier a changé depuis l’application : ${change.path}. Restauration annulée.`);
    }
  }
  const restored = [];
  try {
    for (const change of [...record.changes].reverse()) {
      restored.push(change);
      const { abs } = resolveSafe(record.workspaceRoot, change.path);
      if (change.existed) writeChange(record.workspaceRoot, change, change.before);
      else if (existsSync(abs)) unlinkSync(abs);
    }
    record.status = 'undone';
    record.undoneAt = Date.now();
    save(record, storeDir);
  } catch (error) {
    const rollbackFailures = [];
    for (const change of restored.reverse()) {
      try { writeChange(record.workspaceRoot, change, change.content); }
      catch (rollbackError) { rollbackFailures.push(`${change.path}: ${String(rollbackError?.message ?? rollbackError)}`); }
    }
    record.status = rollbackFailures.length ? 'recovery-required' : 'applied';
    delete record.undoneAt;
    if (rollbackFailures.length) record.recoveryError = rollbackFailures.join(' | ');
    else delete record.recoveryError;
    try { save(record, storeDir); } catch { /* the original record stays as the recovery source */ }
    const suffix = rollbackFailures.length ? ` Réapplication partielle impossible : ${rollbackFailures.join(' | ')}` : '';
    throw new Error(`Restauration interrompue ; les fichiers déjà restaurés ont été réappliqués.${suffix} ${String(error?.message ?? error)}`.trim());
  }
  return publicReview(record);
}
