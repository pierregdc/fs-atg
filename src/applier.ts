import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ATG, ClientToolCall, ClientToolResult } from './api';

export interface FileBlock { path: string; content: string; }
const FILE_RE = /<<<FILE[ \t]+([^\n]+)\n([\s\S]*?)\n?>>>END/g;
const MAX_UNDO_FILE_BYTES = 512 * 1024;
const MAX_UNDO_TOTAL_BYTES = 2 * 1024 * 1024;

export function parseFileBlocks(text: string): FileBlock[] {
  const out: FileBlock[] = [];
  for (const m of text.matchAll(FILE_RE)) out.push({ path: m[1].trim(), content: m[2] });
  return out;
}

export function stripFileBlocks(text: string): string {
  return text.replace(FILE_RE, (_m, p: string) => `[fichier : ${p.trim()}]`).trim();
}

/** Empêche toute écriture hors du workspace et protège .git / .env. */
export function resolveSafe(root: vscode.Uri, rel: string): vscode.Uri {
  const cleaned = (rel || '.').trim() || '.';
  const clean = path.posix.normalize(cleaned.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (clean.startsWith('..') || path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new Error(`Chemin refusé (hors workspace) : ${rel}`);
  }
  if (/(^|\/)\.git(\/|$)/.test(clean) || /(^|\/)\.env/.test(clean)) {
    throw new Error(`Chemin protégé : ${rel}`);
  }
  const target = clean === '.' || clean === '' ? root : vscode.Uri.joinPath(root, clean);

  // path.normalize ne voit pas les liens symboliques / junctions Windows. Vérifier le
  // plus proche parent existant empêche une écriture vers l'extérieur du workspace.
  if (root.scheme === 'file' && target.scheme === 'file' && existsSync(root.fsPath)) {
    const real = realpathSync.native ?? realpathSync;
    const realRoot = real(root.fsPath);
    let probe = target.fsPath;
    while (!existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realProbe = real(probe);
    const normalize = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    const rootPath = normalize(realRoot);
    const probePath = normalize(realProbe);
    if (probePath !== rootPath && !probePath.startsWith(rootPath + path.sep.toLowerCase())) {
      throw new Error(`Chemin refusé (lien hors workspace) : ${rel}`);
    }
  }
  return target;
}

export function workspaceRoot(): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('Ouvre un dossier de projet dans Antigravity.');
  return root;
}

/** Parent directory computed from an already validated workspace-relative path. */
function safeParent(root: vscode.Uri, rel: string): vscode.Uri {
  const normalized = rel.replace(/\\/g, '/');
  const parent = path.posix.dirname(normalized);
  return parent === '.' || parent === '' ? root : resolveSafe(root, parent);
}

/** Contenu virtuel pour afficher les diffs avant écriture. */
export class ProposedContent implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'fsatg-proposed';
  static readonly instance = new ProposedContent();
  private readonly store = new Map<string, string>();
  set(key: string, content: string) {
    this.store.set(key, content);
    return vscode.Uri.from({ scheme: ProposedContent.scheme, path: '/' + key });
  }
  provideTextDocumentContent(uri: vscode.Uri) { return this.store.get(uri.path.slice(1)) ?? ''; }
}

interface Snapshot {
  path: string;
  existed: boolean;
  content?: Uint8Array;
  /** SHA-256 of the exact bytes written by this job. Undefined means no write completed. */
  appliedHash?: string;
}

function contentHash(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * In-memory, bounded undo journal. It never writes a second copy of project
 * files to persistent extension state and is therefore unavailable after an
 * IDE restart; the UI reports that limitation rather than promising recovery.
 */
export class ChangeJournal {
  private readonly snapshots = new Map<string, Map<string, Snapshot>>();
  private readonly omitted = new Map<string, Set<string>>();
  private bytes = 0;

  async capture(jobId: string, rel: string, uri: vscode.Uri): Promise<boolean> {
    // Once a path is outside the reversible bounds for this job, never take
    // a later snapshot of an AI-written intermediate as if it were the
    // user's original file.
    if (this.omitted.get(jobId)?.has(rel)) return false;
    const perJob = this.snapshots.get(jobId) ?? new Map<string, Snapshot>();
    this.snapshots.set(jobId, perJob);
    if (perJob.has(rel)) return true;

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_UNDO_FILE_BYTES || this.bytes + stat.size > MAX_UNDO_TOTAL_BYTES) {
        const set = this.omitted.get(jobId) ?? new Set<string>();
        set.add(rel);
        this.omitted.set(jobId, set);
        return false;
      }
      const content = await vscode.workspace.fs.readFile(uri);
      perJob.set(rel, { path: rel, existed: true, content });
      this.bytes += content.byteLength;
      return true;
    } catch {
      // A file that did not exist is still recoverable: undo deletes it.
      perJob.set(rel, { path: rel, existed: false });
      return true;
    }
  }

  /**
   * Marks a snapshot only after a successful write. Undo later verifies this
   * hash before touching the file, so it never overwrites an intervening user
   * edit (or deletes a newly changed file).
   */
  async markApplied(jobId: string, rel: string, uri: vscode.Uri): Promise<boolean> {
    const snapshot = this.snapshots.get(jobId)?.get(rel);
    if (!snapshot) return false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_UNDO_FILE_BYTES) {
        this.omit(jobId, rel, snapshot);
        return false;
      }
      snapshot.appliedHash = contentHash(await vscode.workspace.fs.readFile(uri));
      return true;
    } catch {
      // A completed write must be readable to be safely reversible.
      this.omit(jobId, rel, snapshot);
      return false;
    }
  }

  private omit(jobId: string, rel: string, snapshot?: Snapshot) {
    const set = this.omitted.get(jobId) ?? new Set<string>();
    set.add(rel);
    this.omitted.set(jobId, set);
    const perJob = this.snapshots.get(jobId);
    const known = snapshot ?? perJob?.get(rel);
    if (known) this.bytes -= known.content?.byteLength ?? 0;
    perJob?.delete(rel);
    if (perJob && !perJob.size) this.snapshots.delete(jobId);
  }

  status(jobId: string) {
    const captured = [...(this.snapshots.get(jobId)?.values() ?? [])]
      .filter(snapshot => !!snapshot.appliedHash)
      .map(snapshot => snapshot.path);
    const omitted = [...(this.omitted.get(jobId) ?? [])];
    return { available: captured.length > 0, captured, omitted };
  }

  async restore(jobId: string): Promise<{ restored: string[]; unavailable: string[]; changed: string[] }> {
    const snapshots = this.snapshots.get(jobId);
    if (!snapshots?.size) return { restored: [], unavailable: [...(this.omitted.get(jobId) ?? [])], changed: [] };
    const root = workspaceRoot();
    const restored: string[] = [];
    const changed: string[] = [];
    // Restore in reverse insertion order, although each path only appears once.
    for (const snapshot of [...snapshots.values()].reverse()) {
      if (!snapshot.appliedHash) continue;
      const uri = resolveSafe(root, snapshot.path);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_UNDO_FILE_BYTES) {
          changed.push(snapshot.path);
          continue;
        }
        const current = await vscode.workspace.fs.readFile(uri);
        if (contentHash(current) !== snapshot.appliedHash) {
          changed.push(snapshot.path);
          continue;
        }
      } catch {
        // The expected post-apply file is gone or unreadable. It may have
        // been changed/deleted by the user, so never recreate/delete blindly.
        changed.push(snapshot.path);
        continue;
      }
      if (snapshot.existed) {
        await vscode.workspace.fs.createDirectory(safeParent(root, snapshot.path));
        await vscode.workspace.fs.writeFile(uri, snapshot.content ?? new Uint8Array());
      } else {
        try { await vscode.workspace.fs.delete(uri, { useTrash: true }); } catch { /* already absent */ }
      }
      restored.push(snapshot.path);
      this.bytes -= snapshot.content?.byteLength ?? 0;
      snapshots.delete(snapshot.path);
    }
    if (!snapshots.size) this.snapshots.delete(jobId);
    return { restored, unavailable: [...(this.omitted.get(jobId) ?? [])], changed };
  }
}

export async function applyFiles(blocks: FileBlock[], jobId: string, jobTitle: string, journal?: ChangeJournal): Promise<string[]> {
  if (!blocks.length) return [];
  const root = workspaceRoot();
  const targets = blocks.map(b => ({ ...b, uri: resolveSafe(root, b.path) }));
  const auto = vscode.workspace.getConfiguration('francestudent').get<boolean>('autoApply', false);

  if (!auto) {
    for (const t of targets.slice(0, 5)) { // on évite d'ouvrir 30 onglets
      let left: vscode.Uri;
      try { await vscode.workspace.fs.stat(t.uri); left = t.uri; }
      catch { left = ProposedContent.instance.set(`${jobId}/empty/${t.path}`, ''); }
      const right = ProposedContent.instance.set(`${jobId}/new/${t.path}`, t.content);
      await vscode.commands.executeCommand('vscode.diff', left, right, `${ATG} ${t.path} (proposition)`, { preview: false });
    }
    const choice = await vscode.window.showInformationMessage(
      `${jobTitle} : appliquer ${targets.length} fichier(s) ?`,
      { modal: true, detail: targets.map(t => '• ' + t.path).join('\n') },
      'Appliquer');
    if (choice !== 'Appliquer') return [];
  }

  for (const t of targets) {
    await journal?.capture(jobId, t.path, t.uri);
    await vscode.workspace.fs.createDirectory(safeParent(root, t.path));
    await vscode.workspace.fs.writeFile(t.uri, Buffer.from(t.content, 'utf8'));
    await journal?.markApplied(jobId, t.path, t.uri);
  }
  return targets.map(t => t.path);
}

/**
 * A small local index is useful in smart mode: it sends paths, exported
 * symbols and local import paths, never complete source files.
 */
export async function workspaceSymbolIndex(maxFiles = 60, maxEntries = 90): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,cs,php,rb,swift}',
    '{**/.git/**,**/node_modules/**,**/dist/**,**/build/**,**/.env*,**/vendor/**}',
    maxFiles,
  );
  const entries: string[] = [];
  const exportRe = /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+|(?:async\s+)?(?:function|class)\s+)([A-Za-z_$][\w$]*)/gm;
  const importRe = /^\s*(?:import(?:[^'"\n]*?from\s+)?|export\s+[^'"\n]*?from\s+|(?:const|let|var)\s+\w+\s*=\s*require\()\s*['"]([^'"]+)['"]/gm;

  for (const uri of uris) {
    if (entries.length >= maxEntries) break;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 256 * 1024) continue;
      const source = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').slice(0, 24_000);
      const symbols = [...source.matchAll(exportRe)].map(match => match[1]).slice(0, 8);
      const imports = [...source.matchAll(importRe)].map(match => match[1]).filter(value => value.startsWith('.')).slice(0, 6);
      if (!symbols.length && !imports.length) continue;
      const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      const parts = [`${rel}`];
      if (symbols.length) parts.push(`exports: ${symbols.join(', ')}`);
      if (imports.length) parts.push(`imports: ${imports.join(', ')}`);
      entries.push(parts.join(' — '));
    } catch { /* unreadable/non-text file: skip */ }
  }
  return entries;
}

const MAX_TOOL_OUTPUT = 38_000;
const MAX_BATCH_OUTPUT = 115_000;

function listDirTree(rootFs: string, dirFs: string, depth: number, curDepth = 1, out: string[] = []): string[] {
  const entries = readdirSync(dirFs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules' || e.name.startsWith('.env')) continue;
    const child = path.join(dirFs, e.name);
    const rel = path.relative(rootFs, child).replace(/\\/g, '/');
    out.push(e.isDirectory() ? `${rel}/` : rel);
    if (out.length >= 400) break;
    if (e.isDirectory() && curDepth < depth) listDirTree(rootFs, child, depth, curDepth + 1, out);
  }
  return out;
}

function searchWorkspace(rootFs: string, dirFs: string, query: string, maxResults: number): string {
  // Une recherche littérale est prévisible et évite les expressions régulières coûteuses
  // produites par un modèle (ReDoS local).
  const needle = query.toLowerCase();
  const hits: string[] = [];
  const walk = (d: string) => {
    if (hits.length >= maxResults) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= maxResults) break;
      if (e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.env')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try {
        if (statSync(full).size > 512 * 1024) continue;
        const lines = readFileSync(full, 'utf8').split(/\r?\n/);
        const rel = path.relative(rootFs, full).replace(/\\/g, '/');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.toLowerCase().includes(needle)) {
            hits.push(`${rel}:${i + 1}: ${line.slice(0, 220)}`);
            if (hits.length >= maxResults) break;
          }
        }
      } catch { /* ignore */ }
    }
  };
  walk(dirFs);
  return hits.length ? hits.join('\n') : 'Aucun résultat.';
}

export async function runClientToolBatch(
  calls: ClientToolCall[],
  jobTitle: string,
  writtenSet: Set<string>,
  options: { journal?: ChangeJournal; jobId?: string; allowWrites?: boolean } = {},
): Promise<ClientToolResult[]> {
  const root = workspaceRoot();
  const auto = vscode.workspace.getConfiguration('francestudent').get<boolean>('autoApply', false);
  const results: ClientToolResult[] = [];
  let batchChars = 0;

  for (const call of calls.slice(0, 32)) {
    const callId = call.callId ?? call.call_id ?? '';
    const args = call.arguments ?? {};
    let output = '';
    let isError = false;
    try {
      switch (call.name) {
        case 'list_directory': {
          const uri = resolveSafe(root, String(args.path ?? '.'));
          const depth = Math.max(1, Math.min(3, Number(args.depth ?? 1)));
          output = listDirTree(root.fsPath, uri.fsPath, depth).join('\n') || '(dossier vide)';
          break;
        }
        case 'read_file': {
          const uri = resolveSafe(root, String(args.path ?? ''));
          if (statSync(uri.fsPath).size > 512 * 1024) throw new Error('Fichier trop volumineux : utilise search_files ou une plage ciblée.');
          const lines = readFileSync(uri.fsPath, 'utf8').split(/\r?\n/);
          const s = Math.max(1, Number(args.start_line ?? 1));
          const e = Math.min(lines.length, Number(args.end_line ?? lines.length), s + 799);
          const out: string[] = [];
          for (let i = s; i <= e; i++) out.push(`${i}: ${lines[i - 1]}`);
          output = out.join('\n');
          break;
        }
        case 'search_files': {
          const uri = resolveSafe(root, String(args.path ?? '.'));
          const max = Math.max(1, Math.min(100, Number(args.max_results ?? 50)));
          output = searchWorkspace(root.fsPath, uri.fsPath, String(args.query ?? ''), max);
          break;
        }
        case 'write_file': {
          const rel = String(args.path ?? '');
          const uri = resolveSafe(root, rel);
          if (options.allowWrites === false) {
            output = `Écriture différée pour ${rel} : cette exécution ne modifie aucun fichier.`;
            isError = true;
            break;
          }
          if (!auto) {
            const ok = await vscode.window.showInformationMessage(
              `${jobTitle} souhaite écrire « ${rel} »`, { modal: true }, 'Autoriser');
            if (ok !== 'Autoriser') { output = 'Écriture refusée par l’utilisateur'; isError = true; break; }
          }
          await options.journal?.capture(options.jobId ?? jobTitle, rel, uri);
          await vscode.workspace.fs.createDirectory(safeParent(root, rel));
          await vscode.workspace.fs.writeFile(uri, Buffer.from(String(args.content ?? ''), 'utf8'));
          await options.journal?.markApplied(options.jobId ?? jobTitle, rel, uri);
          writtenSet.add(rel);
          output = `Fichier écrit : ${rel}`;
          break;
        }
        case 'edit_file': {
          const rel = String(args.path ?? '');
          const uri = resolveSafe(root, rel);
          const cur = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          const oldT = String(args.old_text ?? '');
          const newT = String(args.new_text ?? '');
          if (!oldT || !cur.includes(oldT)) { output = `old_text introuvable dans ${rel}`; isError = true; break; }
          if (options.allowWrites === false) {
            output = `Modification différée pour ${rel} : cette exécution ne modifie aucun fichier.`;
            isError = true;
            break;
          }
          if (!auto) {
            const ok = await vscode.window.showInformationMessage(
              `${jobTitle} souhaite modifier « ${rel} »`, { modal: true }, 'Autoriser');
            if (ok !== 'Autoriser') { output = 'Modification refusée par l’utilisateur'; isError = true; break; }
          }
          const next = args.replace_all ? cur.split(oldT).join(newT) : cur.replace(oldT, newT);
          await options.journal?.capture(options.jobId ?? jobTitle, rel, uri);
          await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
          await options.journal?.markApplied(options.jobId ?? jobTitle, rel, uri);
          writtenSet.add(rel);
          output = `Fichier modifié : ${rel}`;
          break;
        }
        default:
          output = `Outil non supporté : ${call.name}`;
          isError = true;
      }
    } catch (e) {
      output = (e as Error).message;
      isError = true;
    }

    if (output.length > MAX_TOOL_OUTPUT) output = output.slice(0, MAX_TOOL_OUTPUT) + '\n[tronqué]';
    if (batchChars + output.length > MAX_BATCH_OUTPUT) output = output.slice(0, Math.max(0, MAX_BATCH_OUTPUT - batchChars));
    batchChars += output.length;
    results.push({ callId, output, ...(isError ? { isError: true } : {}) });
  }
  return results;
}
