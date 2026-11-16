import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ATG, ClientToolCall, ClientToolResult } from './api';

export interface FileBlock { path: string; content: string; }
const FILE_RE = /<<<FILE[ \t]+([^\n]+)\n([\s\S]*?)\n?>>>END/g;

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
  return clean === '.' || clean === '' ? root : vscode.Uri.joinPath(root, clean);
}

export function workspaceRoot(): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('Ouvre un dossier de projet dans Antigravity.');
  return root;
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

export async function applyFiles(blocks: FileBlock[], jobId: string, jobTitle: string): Promise<string[]> {
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
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(t.uri, '..'));
    await vscode.workspace.fs.writeFile(t.uri, Buffer.from(t.content, 'utf8'));
  }
  return targets.map(t => t.path);
}

const MAX_TOOL_OUTPUT = 38_000;
const MAX_BATCH_OUTPUT = 115_000;

function listDirTree(rootFs: string, dirFs: string, depth: number, curDepth = 1, out: string[] = []): string[] {
  const entries = readdirSync(dirFs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name.startsWith('.env')) continue;
    const child = path.join(dirFs, e.name);
    const rel = path.relative(rootFs, child).replace(/\\/g, '/');
    out.push(e.isDirectory() ? `${rel}/` : rel);
    if (out.length >= 400) break;
    if (e.isDirectory() && curDepth < depth) listDirTree(rootFs, child, depth, curDepth + 1, out);
  }
  return out;
}

function searchWorkspace(rootFs: string, dirFs: string, query: string, maxResults: number): string {
  let re: RegExp | null = null;
  try { re = new RegExp(query, 'i'); } catch { /* plain match */ }
  const hits: string[] = [];
  const walk = (d: string) => {
    if (hits.length >= maxResults) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= maxResults) break;
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.env')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try {
        if (statSync(full).size > 512 * 1024) continue;
        const lines = readFileSync(full, 'utf8').split(/\r?\n/);
        const rel = path.relative(rootFs, full).replace(/\\/g, '/');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (re ? re.test(line) : line.toLowerCase().includes(query.toLowerCase())) {
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

export async function runClientToolBatch(calls: ClientToolCall[], jobTitle: string, writtenSet: Set<string>): Promise<ClientToolResult[]> {
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
          const lines = readFileSync(uri.fsPath, 'utf8').split(/\r?\n/);
          const s = Math.max(1, Number(args.start_line ?? 1));
          const e = Math.min(lines.length, Number(args.end_line ?? lines.length));
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
          if (!auto) {
            const ok = await vscode.window.showInformationMessage(
              `${jobTitle} souhaite écrire « ${rel} »`, { modal: true }, 'Autoriser');
            if (ok !== 'Autoriser') { output = 'Écriture refusée par l’utilisateur'; isError = true; break; }
          }
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
          await vscode.workspace.fs.writeFile(uri, Buffer.from(String(args.content ?? ''), 'utf8'));
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
          if (!auto) {
            const ok = await vscode.window.showInformationMessage(
              `${jobTitle} souhaite modifier « ${rel} »`, { modal: true }, 'Autoriser');
            if (ok !== 'Autoriser') { output = 'Modification refusée par l’utilisateur'; isError = true; break; }
          }
          const next = args.replace_all ? cur.split(oldT).join(newT) : cur.replace(oldT, newT);
          await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
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
