import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ATG } from './api';

export class LiveLog implements vscode.Disposable {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly fallbackDir: vscode.Uri) {}

  /** <workspace>/.fsatg/fs_live.log → pense à ajouter .fsatg/ dans .gitignore */
  get uri(): vscode.Uri {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    return vscode.Uri.joinPath(ws ?? this.fallbackDir, '.fsatg', 'fs_live.log');
  }

  write(line: string) {
    const target = this.uri.fsPath;
    const stamp = new Date().toLocaleTimeString('fr-FR');
    this.chain = this.chain
      .then(async () => {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.appendFile(target, `[${stamp}] ${line}\n`, 'utf8');
      })
      .catch(() => { /* le log ne doit jamais casser un job */ });
  }

  async open() {
    this.write(`${ATG} — ouverture du journal`);
    await this.chain;
    const doc = await vscode.workspace.openTextDocument(this.uri);
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  dispose() { /* rien */ }
}
