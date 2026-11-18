import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ATG, FranceStudentClient } from './api';
import { QuotaGuard } from './quota';
import { LiveLog } from './liveLog';
import { Orchestrator } from './orchestrator';
import { PanelProvider } from './panel';
import { ProposedContent } from './applier';
import { startMcpServer } from './mcp';

export async function activate(ctx: vscode.ExtensionContext) {
  const client = new FranceStudentClient(ctx.secrets);
  const quota = new QuotaGuard(client);
  const log = new LiveLog(ctx.globalStorageUri);
  const orch = new Orchestrator(client, quota, log, ctx);
  const panel = new PanelProvider(client, quota, orch);

  // Jeton local pour que seul Antigravity (via mcp_config.json) parle au serveur MCP.
  let token = ctx.globalState.get<string>('fsatg.mcpToken');
  if (!token) { token = randomUUID(); await ctx.globalState.update('fsatg.mcpToken', token); }
  const port = vscode.workspace.getConfiguration('francestudent').get<number>('mcpPort', 3047);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(rocket) FS —';
  status.tooltip = 'France Student [ATG] : quota restant';
  status.command = 'workbench.view.extension.fsatg';
  status.show();
  quota.onDidChange(s => {
    status.text = `$(rocket) FS ${s.remainingPct == null ? '?' : Math.round(s.remainingPct) + ' %'}`;
  });

  ctx.subscriptions.push(
    status, orch, log,
    vscode.window.registerWebviewViewProvider('fsatg.panel', panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(ProposedContent.scheme, ProposedContent.instance),

    vscode.commands.registerCommand('fsatg.setApiKey', async () => {
      const k = await vscode.window.showInputBox({ prompt: 'Clé API France Student', password: true, ignoreFocusOut: true });
      if (!k) return;
      await client.setKey(k);
      try {
        await quota.snapshot(true); // valide la clé tout de suite
        vscode.window.showInformationMessage(`${ATG} Clé enregistrée et vérifiée ✅`);
      } catch (e) {
        vscode.window.showErrorMessage(`${ATG} Clé enregistrée mais refusée : ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('fsatg.clearApiKey', async () => {
      await client.clearKey();
      vscode.window.showInformationMessage(`${ATG} Clé supprimée du trousseau.`);
    }),

    vscode.commands.registerCommand('fsatg.delegate', async () => {
      const task = await vscode.window.showInputBox({ prompt: `${ATG} Tâche à déléguer`, ignoreFocusOut: true });
      if (task) orch.submit({ task, source: 'command' });
    }),

    vscode.commands.registerCommand('fsatg.openLog', () => log.open()),

    vscode.commands.registerCommand('fsatg.copyMcpConfig', async () => {
      const snippet = JSON.stringify({
        mcpServers: { 'francestudent-atg': { serverUrl: `http://127.0.0.1:${port}/mcp?token=${token}` } },
      }, null, 2);
      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage(
        `${ATG} Config copiée. Colle-la dans ~/.gemini/config/mcp_config.json (Agent → … → MCP Servers → View raw config).`);
    }),
  );

  try {
    ctx.subscriptions.push(await startMcpServer(orch, quota, token, port));
    log.write(`${ATG} Serveur MCP prêt sur 127.0.0.1:${port}`);
  } catch (e) {
    orch.setMcpStatus('error', (e as Error).message);
    vscode.window.showWarningMessage(`${ATG} Serveur MCP non démarré (port ${port} occupé ?) : ${(e as Error).message}`);
  }

  if (await client.hasKey()) quota.snapshot().catch(() => undefined);
}

export function deactivate() { /* les disposables font le ménage */ }
