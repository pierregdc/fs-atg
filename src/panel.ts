import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { FranceStudentClient } from './api';
import { QuotaGuard } from './quota';
import { Orchestrator } from './orchestrator';
import { classifyTier, ExecutionMode, routeConfig, RoutingProfile, Tier } from './router';

const LOGO_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAASzSURBVGhD7VhbjF1jFP6m1dZdoo2G0NaYurTSqHPO3mudkRiioWlKCEGlLuGJEiIRlxeJNwkRqTQVjBAVE52aObP/9Z/21GSIoYJU6INbiw6pUGXKVMt0ZK2953bOmenLXM7D/pL1cvbeZ3/f/r/1r7V+IEWKFClSpEhRBcuKJyGI1iDouAncfUL55VpFnZFldzlI3gfLf2B/BCwlUDFEU+fxdk9NQskF0fmg6HWQ/AWWgZi8CRgAu16E7kVkO+qx0s0pf3z6sKRlNoLiuWB5DOT2xWTlX7DrActrYNkElp/j1bBre0HRQ8i0L0Bm46zyv5tCDMxAxp8J9reD5bOYtBwFy+9gvwWhv8LygP3p4ML1IBGQ/DG0MiQ7EMotCNvmA0/OKP/3yUQdQncqAr8K7Apg+dOIkxwGy3sgdxsyhXnAgN53Nsg9AXIbQO2XIpC7Qe4jsKitjoLdAZBsRhitQGPbKeUvmnjokoeyDOReActPZgty/SD3NUL/IEgW2crYvYV5YFkPloNg+Qfk3kTQOhfc1oBQHgXJbrD028qR/AjyG0DbLkJT53Hlr50YZD6ZhdDfB3J7jBB7/eq/gqIXwIUL0eDmgPzjCISNfChPJ6ujvtck7gNFz5qtNOFzfinYvRxbzmx1CCzfguSOyRHBLbo9qmWUkL5su3k451bbFqlJyfJ5ksiaE38Pkx+KPrDvQl5ythpqG9tyXWf8USyHNqGpWbfbCYYK0ESMiXSD/FUJURXTl2ydgzuNEiknPxj9thr6tdlfg6A0F2FhMVg+teskbyX1YoIxSoDvQrZUH3tcyfjxCI8XmgMlBFEWLDumVkBYmm8FKV+8ESzfH+OrjxW9yMu9aDT7TYOAQZBcm1ipnOAxwv2ArFuO3DvnTK+AzLbTwO6LSoJjhe1gWtQ2WqGbdgEKcivNEhVkq4ZW4qdMuKImBOhL456nnGxlkOsFddyAJV/OtmdrQkC4dTHIWoRKwpWhK7DTeilFbQjwa6sQHS9+Q7Z4sT1bEwLYvVqF5FihSbzLqrFi2gUsalb/f1OF6Hjxi80RiqkXIN1o3LZgqI8P/XXDU1jV0CKnVXfEb9rcyTPxFtzWMDWtBEcdCYFDIO9AUWjdpSYjyUvW38eDzUjy2krvAkkrSHrATps8/W0f2K9D4K4Eu+1DHa41c5MhQNtpcveDZQ/IHR5up+V5ZOUCE6K1gNzbcaNmheoIyG81q2iLvHzzwuQ/1iNw65K5Yv+QUHbfIfR3TU47rVARuegSkCVsPOfGA81XIHkA+WihtcIZdx4ougfsnrP+XlfP0DITl5XqQe4RULQblAw0OidrVc61L5088sOoM9+SWw0WtVQ8UsZfsAuB3Gotsh2faI5oDNQh33oGSO4EuQ+HR0p/AOy2IJCrp2akHIWWmWhsOysmJTtHDPX7ze86qGQKJ5q1wuIKkA5DSljtYkctH4OjNfFuNrVD/WgMHqvo8M5eE1NF6Jy7FyTNIPdGYrfB5O5B6B42u03vsUoZ1OeazEqYhsbJEQdbchChzsBtDZMzMk4M6sw2eiZE8kEyYupqvItcRz5J5ho9WixHU+fJCKO1IHeziUqRIkWKFClSVOJ/3Vji70GskJcAAAAASUVORK5CYII=';

export class PanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pending?: NodeJS.Timeout;
  private autoQuotaTimer?: NodeJS.Timeout;
  private attached: string[] = [];

  constructor(
    private readonly client: FranceStudentClient,
    private readonly quota: QuotaGuard,
    private readonly orch: Orchestrator,
  ) {
    orch.onDidChange(() => this.push());
    quota.onDidChange(() => this.push());
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('francestudent')) { orch.pump(); this.push(); } });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = panelHtml(randomUUID().replace(/-/g, ''));
    view.webview.onDidReceiveMessage(m => this.onMessage(m));
    if (!this.autoQuotaTimer) {
      this.autoQuotaTimer = setInterval(() => {
        if (this.view?.visible) this.quota.snapshot().catch(() => undefined);
      }, 25_000);
      view.onDidDispose(() => {
        if (this.autoQuotaTimer) { clearInterval(this.autoQuotaTimer); this.autoQuotaTimer = undefined; }
      });
    }
  }

  private push() {
    if (this.pending) return;
    this.pending = setTimeout(async () => {
      this.pending = undefined;
      this.view?.webview.postMessage(await this.state());
    }, 120);
  }

  private async state() {
    const c = vscode.workspace.getConfiguration('francestudent');
    const cfg = routeConfig();
    const routedModels = await this.orch.models().catch(() => []);
    // Local routing defaults may be useful when the API is temporarily down,
    // but presenting them as live availability would be misleading.
    const modelsVerified = this.client.modelsVerified();
    const models = modelsVerified ? routedModels : [];
    const tierModels: Record<Tier, Array<{ id: string; name: string; provider: string; blocked: boolean }>> = {
      light: [],
      medium: [],
      heavy: [],
    };
    for (const id of models) {
      const low = id.toLowerCase();
      const blocked = (cfg.allowed.length > 0 && !cfg.allowed.some(a => low.includes(a.toLowerCase()))) ||
        cfg.blocked.some(b => low.includes(b.toLowerCase()));
      const meta = this.client.getModelMeta(id);
      tierModels[classifyTier(id, cfg)].push({ ...meta, blocked });
    }
    const session = await this.orch.session('status').catch(() => ({ chatId: undefined, usagePercent: undefined }));
    const diagnostics = await this.orch.diagnostics(session);
    return {
      type: 'state',
      hasKey: await this.client.hasKey(),
      quota: this.quota.last ?? null,
      cutoff: c.get('cutoffPercent', 15),
      mode: c.get('mode', 'eco'),
      maxParallel: c.get('maxParallel', 3),
      autoPowerUp: c.get('autoPowerUp', 'ask'),
      autoApply: c.get('autoApply', false),
      useClientTools: c.get('useClientTools', true),
      reuseChat: c.get('reuseChat', true),
      contextCompactPercent: c.get('contextCompactPercent', 80),
      contextMode: c.get('contextMode', 'minimal'),
      routingProfile: cfg.routingProfile,
      showReasoning: c.get('showReasoning', true),
      allowedModels: cfg.allowed,
      blockedModels: cfg.blocked,
      tiers: cfg.tiers,
      tierModels,
      models,
      modelsVerified,
      modelsError: modelsVerified ? undefined : 'Disponibilité des modèles non vérifiée auprès du fournisseur.',
      attached: this.attached,
      active: this.orch.active().map(j => this.orch.publicView(j)),
      history: this.orch.historyList().map(j => this.orch.publicView(j)),
      session,
      diagnostics,
    };
  }

  private async onMessage(m: any) {
    const cfg = vscode.workspace.getConfiguration('francestudent');
    switch (m.type) {
      case 'ready':
        this.quota.snapshot().catch(() => undefined);
        this.push();
        break;
      case 'delegate':
        if (typeof m.task !== 'string' || !m.task.trim()) return;
        {
          const executionMode = ['apply', 'plan', 'dry-run'].includes(m.executionMode)
            ? m.executionMode as ExecutionMode
            : undefined;
          const routingProfile = ['eco', 'fast', 'quality', 'security', 'refactor'].includes(m.routingProfile)
            ? m.routingProfile as RoutingProfile
            : undefined;
          this.orch.submit({
            task: m.task,
            model: typeof m.model === 'string' ? m.model || undefined : undefined,
            files: this.attached,
            contextMode: ['minimal', 'targeted', 'smart'].includes(m.contextMode) ? m.contextMode : undefined,
            executionMode,
            routingProfile,
            source: 'panel',
          });
        }
        this.attached = [];
        this.push();
        break;
      case 'attach': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: root, openLabel: 'Joindre [ATG]' });
        if (picked && root) this.attached = [...new Set([...this.attached, ...picked.map(u => vscode.workspace.asRelativePath(u, false))])];
        this.push();
        break;
      }
      case 'detach': this.attached = this.attached.filter(f => f !== m.file); this.push(); break;
      case 'cancel': this.orch.cancel(m.id); break;
      case 'clearHistory': this.orch.clearHistory(); this.push(); break;
      case 'mode': await cfg.update('mode', m.mode, vscode.ConfigurationTarget.Global); break;
      case 'saveSettings':
        if (typeof m.cutoffPercent === 'number') await cfg.update('cutoffPercent', Math.max(0, Math.min(90, m.cutoffPercent)), vscode.ConfigurationTarget.Global);
        if (typeof m.maxParallel === 'number') await cfg.update('maxParallel', Math.max(1, Math.min(6, m.maxParallel)), vscode.ConfigurationTarget.Global);
        if (typeof m.autoPowerUp === 'string') await cfg.update('autoPowerUp', m.autoPowerUp, vscode.ConfigurationTarget.Global);
        if (typeof m.autoApply === 'boolean') await cfg.update('autoApply', m.autoApply, vscode.ConfigurationTarget.Global);
        if (typeof m.useClientTools === 'boolean') await cfg.update('useClientTools', m.useClientTools, vscode.ConfigurationTarget.Global);
        if (typeof m.reuseChat === 'boolean') await cfg.update('reuseChat', m.reuseChat, vscode.ConfigurationTarget.Global);
        if (typeof m.contextCompactPercent === 'number') await cfg.update('contextCompactPercent', Math.max(50, Math.min(95, m.contextCompactPercent)), vscode.ConfigurationTarget.Global);
        if (['minimal', 'targeted', 'smart'].includes(m.contextMode)) await cfg.update('contextMode', m.contextMode, vscode.ConfigurationTarget.Global);
        if (['eco', 'fast', 'quality', 'security', 'refactor'].includes(m.routingProfile)) await cfg.update('routingProfile', m.routingProfile, vscode.ConfigurationTarget.Global);
        if (typeof m.showReasoning === 'boolean') await cfg.update('showReasoning', m.showReasoning, vscode.ConfigurationTarget.Global);
        if (Array.isArray(m.allowedModels)) await cfg.update('allowedModels', m.allowedModels, vscode.ConfigurationTarget.Global);
        if (Array.isArray(m.blockedModels)) await cfg.update('blockedModels', m.blockedModels, vscode.ConfigurationTarget.Global);
        if (m.tiers && typeof m.tiers === 'object') await cfg.update('tiers', m.tiers, vscode.ConfigurationTarget.Global);
        this.push();
        vscode.window.setStatusBarMessage('[ATG] Paramètres enregistrés', 3000);
        break;
      case 'applyReview':
        try {
          const result = await this.orch.applyReview(String(m.id ?? ''));
          vscode.window.setStatusBarMessage(`[ATG] ${result.message ?? `${result.written.length} fichier(s) applique(s).`}`, 5000);
        } catch (error) {
          vscode.window.showWarningMessage(`[ATG] ${(error as Error).message}`);
        }
        this.push();
        break;
      case 'undo': {
        const result = await this.orch.undo(String(m.id ?? ''));
        const notes = [
          result.restored.length ? `${result.restored.length} restaure(s)` : '',
          result.changed.length ? `${result.changed.length} modifie(s), non ecrase(s)` : '',
          result.unavailable.length ? `${result.unavailable.length} indisponible(s)` : '',
        ].filter(Boolean).join(' - ');
        vscode.window.setStatusBarMessage(`[ATG] ${notes || 'Aucune restauration disponible.'}`, 6000);
        this.push();
        break;
      }
      case 'refreshDiagnostics': await this.orch.refreshDiagnostics(); this.push(); break;
      case 'refresh': await this.quota.snapshot(true).catch(e => vscode.window.showWarningMessage(String(e.message))); break;
      case 'session':
        await this.orch.session(m.action === 'compact' || m.action === 'new' ? m.action : 'status');
        this.push();
        break;
      case 'log': await vscode.commands.executeCommand('fsatg.openLog'); break;
      case 'key': await vscode.commands.executeCommand('fsatg.setApiKey'); this.push(); break;
      case 'clearKey': await vscode.commands.executeCommand('fsatg.clearApiKey'); this.push(); break;
      case 'copyMcp': await vscode.commands.executeCommand('fsatg.copyMcpConfig'); break;
    }
  }
}

function panelHtml(nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root {
    --fs-bg: var(--vscode-sideBar-background, #0d1017);
    --fs-card: var(--vscode-editorWidget-background, #141822);
    --fs-surface: var(--vscode-input-background, #1c2130);
    --fs-fg: var(--vscode-foreground, #eef2f8);
    --fs-fg-soft: color-mix(in srgb, var(--fs-fg) 68%, transparent);
    --fs-fg-faint: color-mix(in srgb, var(--fs-fg) 48%, transparent);
    --fs-border: var(--vscode-panel-border, rgba(255, 255, 255, 0.11));
    --fs-blue: var(--vscode-button-background, #0d84ff);
    --fs-blue-fg: var(--vscode-button-foreground, #ffffff);
    --fs-indigo: #5b50e6;
    --fs-ok: #10b981;
    --fs-warn: #f59e0b;
    --fs-bad: #ef4444;
    --fs-r: 16px;
    --fs-r-sm: 12px;
    --fs-pill: 999px;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--fs-fg); background: var(--fs-bg); padding: 10px; margin: 0; font-size: 12.5px; line-height: 1.45; }
  button, input, select, textarea { font: inherit; color: var(--fs-fg); }
  svg.ico { width: 14px; height: 14px; flex-shrink: 0; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  svg.ico-sm { width: 12px; height: 12px; }

  .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; background: var(--fs-card); border: 1px solid var(--fs-border); border-radius: var(--fs-pill); padding: 4px; margin-bottom: 10px; }
  .tab-btn { border: 0; background: transparent; color: var(--fs-fg-soft); padding: 6px 8px; border-radius: var(--fs-pill); cursor: pointer; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .tab-btn.on { background: var(--fs-surface); color: var(--fs-fg); }
  .view[hidden] { display: none; }

  .warnbox { background: color-mix(in srgb, var(--fs-warn) 11%, var(--fs-card)); border: 1px solid color-mix(in srgb, var(--fs-warn) 38%, transparent); border-radius: var(--fs-r); padding: 9px 11px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .warnbox[hidden] { display: none; }
  .warn-left { display: flex; align-items: center; gap: 9px; }
  .warn-ico { width: 28px; height: 28px; border-radius: 999px; background: color-mix(in srgb, var(--fs-warn) 18%, transparent); color: var(--fs-warn); display: grid; place-items: center; flex-shrink: 0; }
  .warn-title { font-weight: 600; font-size: 12px; }
  .warn-sub { font-size: 11px; color: var(--fs-fg-soft); }

  .hero { background: var(--fs-card); border: 1px solid var(--fs-border); border-radius: var(--fs-r); padding: 12px 13px; margin-bottom: 10px; }
  .hero-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 9px; }
  .brand { display: flex; align-items: center; gap: 7px; }
  .brand-logo { width: 20px; height: 20px; border-radius: 6px; object-fit: contain; }
  .hero h1 { font-size: 14px; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 6px; }
  .badge { font-size: 9.5px; font-weight: 800; border-radius: var(--fs-pill); padding: 1px 6px; background: var(--fs-indigo); color: #fff; }
  .status-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: var(--fs-pill); background: var(--fs-surface); color: var(--fs-fg-soft); }
  .status-pill.on { color: #34d399; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fs-fg-faint); }
  .status-pill.on .dot { background: #34d399; }
  .qrow { display: flex; justify-content: space-between; font-size: 11px; color: var(--fs-fg-soft); margin-bottom: 4px; }
  .pct-val { font-size: 14px; font-weight: 800; color: var(--fs-fg); }
  .gauge-wrap { position: relative; padding-bottom: 14px; cursor: pointer; }
  .gauge { height: 7px; background: var(--fs-surface); border-radius: var(--fs-pill); overflow: hidden; }
  .gauge > div { height: 100%; width: 0; background: var(--fs-blue); border-radius: var(--fs-pill); transition: width .45s ease; }
  .gauge.low > div { background: var(--fs-warn); } .gauge.crit > div { background: var(--fs-bad); }
  .cutoff-tick { position: absolute; top: -2px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; pointer-events: none; }
  .cutoff-line { width: 2px; height: 11px; background: var(--fs-warn); }
  .cutoff-lbl { font-size: 9px; font-weight: 700; color: var(--fs-warn); }
  .meta { font-size: 11px; color: var(--fs-fg-soft); display: flex; justify-content: space-between; }

  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; background: var(--fs-card); border: 1px solid var(--fs-border); border-radius: var(--fs-pill); padding: 4px; margin-bottom: 10px; }
  .seg button { border: 0; background: transparent; color: var(--fs-fg-soft); padding: 6px 8px; border-radius: var(--fs-pill); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 5px; font-size: 12px; font-weight: 600; }
  .seg button .sub-txt { font-size: 10.5px; font-weight: 400; }
  .seg button.on { background: var(--fs-blue); color: var(--fs-blue-fg); }

  .composer, .settings-card { background: var(--fs-card); border: 1px solid var(--fs-border); border-radius: var(--fs-r); padding: 11px; margin-bottom: 10px; }
  .settings-card { border-radius: 18px; padding: 13px; }
  textarea, select, input[type="text"], input[type="number"] { width: 100%; background: var(--fs-surface); color: var(--fs-fg); border: 1px solid var(--fs-border); border-radius: var(--fs-r-sm); padding: 7px 10px; font-size: 12px; }
  textarea { min-height: 70px; resize: vertical; margin-bottom: 8px; }
  textarea:focus, select:focus, input:focus { outline: 1px solid var(--fs-blue); border-color: var(--fs-blue); }

  .tier-row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 9px; }
  .chip { font-size: 11px; background: var(--fs-surface); border: 1px solid var(--fs-border); color: var(--fs-fg-soft); border-radius: var(--fs-pill); padding: 4px 10px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; user-select: none; }
  .chip.on { background: color-mix(in srgb, var(--fs-blue) 22%, var(--fs-card)); border-color: var(--fs-blue); color: var(--fs-fg); font-weight: 600; }
  .chip-cnt { font-size: 9.5px; opacity: .75; background: color-mix(in srgb, var(--fs-fg) 10%, transparent); padding: 0 5px; border-radius: var(--fs-pill); }

  .popover { position: fixed; z-index: 999; width: 230px; max-width: calc(100vw - 20px); background: var(--fs-card); border: 1px solid color-mix(in srgb, var(--fs-fg) 20%, transparent); border-radius: 14px; padding: 7px; box-shadow: 0 12px 26px rgba(0,0,0,.45); }
  .popover[hidden] { display: none; }
  .pop-head { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--fs-fg-soft); padding: 3px 6px 5px; border-bottom: 1px solid var(--fs-border); margin-bottom: 4px; display: flex; justify-content: space-between; }
  .pop-item { width: 100%; text-align: left; background: transparent; border: 0; border-radius: 9px; padding: 5px 8px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; }
  .pop-item:hover { background: var(--fs-surface); }
  .pop-item.blocked { opacity: .45; text-decoration: line-through; cursor: not-allowed; }
  .pop-prov { font-size: 10px; color: var(--fs-fg-soft); background: var(--fs-surface); padding: 1px 6px; border-radius: var(--fs-pill); text-transform: capitalize; }

  .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .btn { background: var(--fs-blue); color: var(--fs-blue-fg); border: 0; border-radius: var(--fs-pill); padding: 6px 13px; cursor: pointer; font-weight: 600; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
  .btn.ghost { background: var(--fs-surface); border: 1px solid var(--fs-border); color: var(--fs-fg); font-weight: 500; }
  .btn.danger { background: color-mix(in srgb, var(--fs-bad) 18%, var(--fs-card)); border: 1px solid color-mix(in srgb, var(--fs-bad) 45%, transparent); color: #fca5a5; }
  .btn.sm { padding: 5px 10px; font-size: 11px; }

  .sec-head { display: flex; justify-content: space-between; align-items: center; margin: 11px 0 6px; }
  .sec-title { font-size: 10.5px; font-weight: 700; letter-spacing: .07em; color: var(--fs-fg-soft); text-transform: uppercase; display: flex; align-items: center; gap: 6px; }
  .cnt { background: var(--fs-surface); border-radius: var(--fs-pill); padding: 0 6px; font-size: 10px; color: var(--fs-fg); }
  .link-btn { background: none; border: 0; color: var(--fs-blue); cursor: pointer; font-size: 11px; font-weight: 600; padding: 0; }
  .empty-txt { font-size: 11.5px; color: var(--fs-fg-faint); padding: 5px 3px; }

  .job-card { background: var(--fs-card); border: 1px solid var(--fs-border); border-radius: var(--fs-r); padding: 9px 11px; margin-bottom: 7px; }
  .job-top { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .tag { font-size: 9px; font-weight: 800; background: var(--fs-indigo); color: #fff; border-radius: var(--fs-pill); padding: 1px 6px; }
  .job-title { font-size: 12px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-pill { font-size: 10px; background: var(--fs-surface); border-radius: var(--fs-pill); padding: 1px 7px; color: var(--fs-fg-soft); }
  .x { background: none; border: 0; color: var(--fs-fg-soft); cursor: pointer; padding: 2px; display: grid; place-items: center; }
  .pbar { height: 4px; background: var(--fs-surface); border-radius: var(--fs-pill); overflow: hidden; margin-bottom: 5px; }
  .pbar > div { height: 100%; width: 45%; background: var(--fs-blue); border-radius: var(--fs-pill); animation: ind 1.3s ease-in-out infinite; }
  @keyframes ind { 0% { transform: translateX(-100%); width: 35%; } 50% { width: 65%; } 100% { transform: translateX(270%); width: 35%; } }
  .job-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--fs-fg-soft); margin-bottom: 5px; }
  .term { background: var(--fs-surface); border-radius: 9px; padding: 5px 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fs-fg-soft); }

  .hist-list { background: var(--fs-card); border: 1px solid var(--fs-border); border-radius: var(--fs-r); overflow: hidden; }
  .hist-item { padding: 8px 11px; border-bottom: 1px solid var(--fs-border); cursor: pointer; }
  .hist-item:last-child { border-bottom: 0; }
  .hist-row { display: flex; align-items: center; gap: 8px; }
  .st-ico { width: 20px; height: 20px; border-radius: 999px; display: grid; place-items: center; flex-shrink: 0; }
  .st-ico.done { background: color-mix(in srgb, var(--fs-ok) 18%, transparent); color: #34d399; }
  .st-ico.warn { background: color-mix(in srgb, var(--fs-warn) 18%, transparent); color: #fbbf24; font-weight: 800; }
  .st-ico.error { background: color-mix(in srgb, var(--fs-bad) 18%, transparent); color: #f87171; }
  .st-ico.cancelled { background: color-mix(in srgb, var(--fs-warn) 18%, transparent); color: #fbbf24; }
  .hist-main { flex: 1; min-width: 0; }
  .hist-top { display: flex; align-items: center; gap: 5px; }
  .hist-title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hist-sub { font-size: 11px; color: var(--fs-fg-soft); }
  .hist-detail { margin-top: 7px; background: var(--fs-surface); border-radius: 9px; padding: 7px 9px; font-size: 11px; white-space: pre-wrap; max-height: 150px; overflow: auto; }

  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 11.5px; font-weight: 600; margin-bottom: 4px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .toggle-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 11px; background: var(--fs-surface); border: 1px solid var(--fs-border); border-radius: var(--fs-r-sm); }
  .switch { position: relative; display: inline-block; width: 34px; height: 20px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; cursor: pointer; inset: 0; background: var(--fs-bg); border: 1px solid var(--fs-border); border-radius: 999px; transition: .2s; }
  .slider:before { content: ""; position: absolute; height: 14px; width: 14px; left: 2px; bottom: 2px; background: var(--fs-fg); border-radius: 50%; transition: .2s; }
  .switch input:checked + .slider { background: var(--fs-blue); border-color: var(--fs-blue); }
  .switch input:checked + .slider:before { transform: translateX(14px); background: #fff; }

  /* Visual system v2: calm, information-first, and deliberately compact. */
  :root {
    --fs-canvas: var(--vscode-sideBar-background, #10131a);
    --fs-panel: color-mix(in srgb, var(--vscode-editor-background, #171b24) 90%, var(--fs-bg));
    --fs-elev: color-mix(in srgb, var(--fs-surface) 74%, var(--fs-card));
    --fs-line: color-mix(in srgb, var(--fs-fg) 13%, transparent);
    --fs-accent-soft: color-mix(in srgb, var(--fs-blue) 16%, transparent);
  }
  body {
    padding: 12px 10px 20px;
    background: radial-gradient(110% 340px at 80% -80px, color-mix(in srgb, var(--fs-blue) 13%, transparent), transparent 62%), var(--fs-canvas);
    font-size: 12px;
  }
  .tabs {
    position: sticky; top: 0; z-index: 5;
    grid-template-columns: 1fr 1fr;
    margin: -2px 0 14px; padding: 3px;
    background: color-mix(in srgb, var(--fs-canvas) 88%, transparent);
    border: 1px solid var(--fs-line); border-radius: 10px;
    backdrop-filter: blur(12px);
  }
  .tab-btn { min-height: 30px; padding: 5px 8px; border-radius: 7px; font-size: 11.5px; letter-spacing: .01em; }
  .tab-btn.on { background: var(--fs-elev); box-shadow: 0 1px 0 color-mix(in srgb, #fff 11%, transparent) inset; }
  .warnbox, .hero, .composer, .settings-card, .job-card, .hist-list {
    background: var(--fs-panel); border-color: var(--fs-line); border-radius: 12px;
    box-shadow: none;
  }
  .warnbox { padding: 10px; margin-bottom: 10px; }
  .hero { padding: 13px; margin-bottom: 10px; overflow: hidden; position: relative; }
  .hero::before { content: ''; position: absolute; width: 130px; height: 130px; right: -68px; top: -72px; border-radius: 50%; background: color-mix(in srgb, var(--fs-blue) 13%, transparent); pointer-events: none; }
  .hero-top, .qrow, .meta { position: relative; }
  .brand { gap: 8px; }
  .brand-logo { width: 24px; height: 24px; border-radius: 8px; background: var(--fs-elev); padding: 2px; }
  .hero h1 { font-size: 13px; letter-spacing: -.01em; }
  .badge { background: var(--fs-accent-soft); color: var(--fs-fg); border: 1px solid color-mix(in srgb, var(--fs-blue) 48%, transparent); }
  .status-pill { background: transparent; border: 1px solid var(--fs-line); padding: 3px 7px; font-size: 10px; }
  .qrow { margin-top: 15px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .055em; }
  .pct-val { font-size: 18px; letter-spacing: -.04em; }
  .gauge-wrap { padding-bottom: 13px; }
  .gauge { height: 5px; background: color-mix(in srgb, var(--fs-fg) 10%, transparent); }
  .meta { padding-top: 2px; font-size: 10px; }
  .seg { padding: 3px; margin-bottom: 10px; border-color: var(--fs-line); border-radius: 10px; background: var(--fs-panel); }
  .seg button { min-height: 32px; padding: 5px; border-radius: 7px; font-size: 11px; }
  .seg button.on { background: var(--fs-accent-soft); color: var(--fs-fg); box-shadow: none; }
  .composer { padding: 12px; margin-bottom: 14px; }
  textarea, select, input[type="text"], input[type="number"] { border-color: var(--fs-line); border-radius: 9px; background: var(--fs-elev); font-size: 12px; }
  textarea { min-height: 92px; line-height: 1.5; padding: 10px; }
  textarea::placeholder { color: var(--fs-fg-faint); }
  .tier-row { gap: 5px; margin-bottom: 8px; }
  .chip { min-height: 27px; padding: 4px 8px; border-color: var(--fs-line); background: transparent; font-size: 10.5px; }
  .chip:hover { border-color: color-mix(in srgb, var(--fs-blue) 55%, var(--fs-line)); }
  .chip.on { background: var(--fs-accent-soft); border-color: color-mix(in srgb, var(--fs-blue) 65%, var(--fs-line)); }
  .chip-cnt { background: transparent; padding: 0 0 0 3px; }
  .actions { gap: 7px; }
  .btn { min-height: 31px; padding: 6px 11px; border-radius: 8px; font-size: 11px; }
  .btn.ghost { background: transparent; border-color: var(--fs-line); }
  .btn.ghost:hover { background: var(--fs-elev); }
  .sec-head { margin: 16px 2px 7px; }
  .sec-title { font-size: 10px; letter-spacing: .1em; }
  .cnt { border: 1px solid var(--fs-line); background: transparent; }
  .job-card { padding: 10px; margin-bottom: 6px; border-left: 2px solid var(--fs-blue); }
  .job-top { margin-bottom: 7px; }
  .tag { background: transparent; border: 1px solid var(--fs-line); color: var(--fs-fg-soft); padding: 1px 5px; }
  .model-pill { background: transparent; border: 1px solid var(--fs-line); font-size: 9.5px; }
  .pbar { height: 3px; background: color-mix(in srgb, var(--fs-fg) 8%, transparent); }
  .term { border: 1px solid var(--fs-line); background: transparent; color: var(--fs-fg-soft); }
  .hist-list { overflow: hidden; }
  .hist-item { padding: 9px 10px; }
  .hist-item:hover { background: color-mix(in srgb, var(--fs-blue) 5%, transparent); }
  .st-ico { width: 19px; height: 19px; }
  .hist-detail { background: var(--fs-elev); border: 1px solid var(--fs-line); border-radius: 8px; }
  .settings-card { padding: 12px; margin-bottom: 10px; }
  .field { margin-bottom: 12px; }
  .field label { color: var(--fs-fg-soft); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; }
  .toggle-row { gap: 9px; padding: 8px 9px; background: transparent; border-color: var(--fs-line); border-radius: 9px; }
  .popover { background: var(--fs-panel); border-color: color-mix(in srgb, var(--fs-blue) 35%, var(--fs-line)); box-shadow: 0 14px 34px rgba(0, 0, 0, .35); }
  .pop-item:hover { background: var(--fs-elev); }
  .empty-txt { padding: 8px 2px; color: var(--fs-fg-faint); }
  @media (max-width: 260px) { .grid-2 { grid-template-columns: 1fr; } .sub-txt { display: none; } }
  .review-actions { display:flex; gap:6px; margin-top:7px; flex-wrap:wrap; }
  .token-note { margin-top:5px; color:var(--fs-fg-faint); font-size:10.5px; }
  .diagnostic-grid { display:grid; gap:6px; margin-top:8px; }
  .diagnostic-row { display:flex; justify-content:space-between; gap:8px; padding:6px 0; border-bottom:1px solid var(--fs-border); font-size:11px; }
  .diagnostic-row:last-child { border-bottom:0; }
  .diagnostic-value { text-align:right; color:var(--fs-fg-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
</style></head>
<body>
  <div class="tabs">
    <button class="tab-btn on" data-tab="dash">Tableau de bord</button>
    <button class="tab-btn" data-tab="settings">Paramètres</button>
  </div>

  <div id="tab-dash" class="view">
    <div id="nokey" class="warnbox" hidden>
      <div class="warn-left">
        <div class="warn-ico"><svg class="ico" viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg></div>
        <div><div class="warn-title">Aucune clé API enregistrée</div><div class="warn-sub">Configure ton jeton France Student.</div></div>
      </div>
      <button class="btn sm" id="setkey">Configurer</button>
    </div>

    <div class="hero">
      <div class="hero-top">
        <div class="brand">
          <img class="brand-logo" alt="France Student" src="${LOGO_DATA_URI}" />
          <h1>France Student <span class="badge">ATG</span></h1>
        </div>
        <span class="status-pill" id="connPill"><span class="dot"></span><span id="connTxt">Vérification…</span></span>
      </div>
      <div class="qrow"><span>Budget chat restant</span><span class="pct-val" id="pct">—</span></div>
      <div class="gauge-wrap" id="gauge" title="Actualisé automatiquement (clic pour forcer)">
        <div class="gauge" id="gaugeBar"><div id="bar"></div></div>
        <div class="cutoff-tick" id="cutoffTick" hidden><div class="cutoff-line"></div><div class="cutoff-lbl" id="cutoffNum">—</div></div>
      </div>
      <div class="meta"><span id="qtxt">Vérification en cours…</span><span>Coupe-circuit : <b id="cutoff">—</b></span></div>
    </div>

    <div class="seg" id="mode">
      <button data-mode="eco">Éco <span class="sub-txt">· 1 agent</span></button>
      <button data-mode="fast">Rapide <span class="sub-txt">· multi</span></button>
    </div>

    <div class="composer">
      <textarea id="task" placeholder="Décris la tâche… (/plan, /dry-run, /eco, /security, /fable)"></textarea>
      <div class="tier-row" id="cmdBar" hidden></div>
      <div class="tier-row" id="attachedChips"></div>
      <div class="tier-row" id="tierRow">
        <button class="chip on" data-choice="">Auto</button>
        <button class="chip" data-choice="tier:light" data-tier="light">Modèle faible <span class="chip-cnt" id="cnt-light">—</span></button>
        <button class="chip" data-choice="tier:medium" data-tier="medium">Modèle équilibré <span class="chip-cnt" id="cnt-medium">—</span></button>
        <button class="chip" data-choice="tier:heavy" data-tier="heavy">Modèle fort <span class="chip-cnt" id="cnt-heavy">—</span></button>
      </div>
      <div class="actions">
        <button class="btn" id="go">Déléguer</button>
        <button class="btn ghost" id="attach">Fichiers</button>
        <button class="btn ghost" id="log">fs_live.log</button>
      </div>
    </div>

    <div id="tierPopover" class="popover" hidden>
      <div class="pop-head"><span id="popTitle">Modèles</span><span>Clic pour forcer</span></div>
      <div id="popList"></div>
    </div>

    <div class="sec-head"><div class="sec-title">Agents actifs <span class="cnt" id="activeCount">—</span></div></div>
    <div id="active"></div>

    <div class="sec-head">
      <div class="sec-title">Historique <span class="cnt" id="historyCount">—</span></div>
      <button class="link-btn" id="clearHistory" hidden>Tout effacer</button>
    </div>
    <div id="history"></div>
  </div>

  <div id="tab-settings" class="view" hidden>
    <div class="settings-card">
      <div class="field"><label>Clé API / Jeton de session</label>
        <div class="actions"><button class="btn sm" id="keyBtn">Enregistrer</button><button class="btn danger sm" id="clearKeyBtn">Oublier</button><button class="btn ghost sm" id="copyMcpBtn">Config MCP</button></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Coupe-circuit (%)</label><div style="display:flex;gap:6px;align-items:center"><input type="number" id="cutoffInput" min="0" max="90" /><button type="button" class="btn ghost sm" id="useAllBtn" title="Désactiver la réserve (0 %)">Tout utiliser</button></div></div>
        <div class="field"><label>Agents parallèles</label><input type="number" id="maxParallelInput" min="1" max="6" /></div>
      </div>
      <div class="field"><label>Power-up HTTP 429</label>
        <select id="powerUpInput"><option value="ask">Demander confirmation</option><option value="auto">Automatique</option><option value="off">Désactivé</option></select>
      </div>
      <div class="field"><div class="toggle-row"><span>Appliquer sans confirmation</span><label class="switch"><input type="checkbox" id="autoApplyInput" /><span class="slider"></span></label></div></div>
      <div class="field"><div class="toggle-row"><span>Outils client natifs</span><label class="switch"><input type="checkbox" id="useClientToolsInput" /><span class="slider"></span></label></div></div>
       <div class="field"><div class="toggle-row"><span>Chat direct persistant (contexte compacté automatiquement)</span><label class="switch"><input type="checkbox" id="reuseChatInput" /><span class="slider"></span></label></div></div>
       <div class="field"><label>Compacter le contexte à partir de (%)</label><input type="number" id="contextCompactInput" min="50" max="95" /></div>
       <div class="field"><label>Contexte envoyé</label><select id="contextModeInput"><option value="minimal">Minimal — demande seule</option><option value="targeted">Ciblé — fichiers choisis</option><option value="smart">Intelligent — index local de symboles/imports</option></select></div>
      <div class="field"><div class="toggle-row"><span>Résumé de raisonnement</span><label class="switch"><input type="checkbox" id="showReasoningInput" /><span class="slider"></span></label></div></div>
    </div>
    <div class="settings-card">
      <div class="field"><label>Profil de routage</label><select id="routingProfileInput"><option value="eco">Éco — modèle léger par défaut</option><option value="fast">Rapide — modèle léger</option><option value="quality">Qualité — modèle puissant</option><option value="security">Sécurité — modèle puissant</option><option value="refactor">Refactorisation — modèle puissant</option></select></div>
      <div class="field"><label>Modèle faible (légers)</label><input type="text" id="tierLightInput" /></div>
      <div class="field"><label>Modèle équilibré (intermédiaires)</label><input type="text" id="tierMediumInput" /></div>
      <div class="field"><label>Modèle fort (puissants)</label><input type="text" id="tierHeavyInput" /></div>
      <div class="grid-2">
        <div class="field"><label>Autorisés</label><input type="text" id="allowedInput" placeholder="Vide = tous" /></div>
        <div class="field"><label>Interdits</label><input type="text" id="blockedInput" placeholder="Ex: fable" /></div>
      </div>
      <button class="btn sm" id="saveSettingsBtn">Enregistrer les paramètres</button>
    </div>
    <div class="settings-card">
      <div class="field"><label>Diagnostic vérifiable</label>
        <div class="actions"><button class="btn ghost sm" id="refreshDiagnosticsBtn">Actualiser</button></div>
        <div id="diagnostics" class="diagnostic-grid"><div class="empty-txt">Diagnostic en cours…</div></div>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let S = {
    loaded: false,
    active: [], history: [],
    models: [], modelsVerified: false, modelsError: 'Chargement des données réelles…',
    tierModels: { light: [], medium: [], heavy: [] },
    tiers: { light: [], medium: [], heavy: [] },
    attached: [], cutoff: null, mode: '', routingProfile: 'eco', diagnostics: null
  };
  let selectedChoice = '';
  let settingsLoaded = false;
  let hoverTimer = null;
  let popHideTimer = null;
  const expanded = new Set();

  window.addEventListener('message', e => { if (e.data.type === 'state') { S = { ...e.data, loaded: true }; render(); } });
  function fmt(sec) { return sec >= 60 ? Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s' : sec + ' s'; }
  function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $('tab-dash').hidden = tab !== 'dash';
    $('tab-settings').hidden = tab !== 'settings';
  }
  function syncSettings() {
    $('cutoffInput').value = S.cutoff ?? 15;
    $('maxParallelInput').value = S.maxParallel ?? 3;
    $('powerUpInput').value = S.autoPowerUp || 'ask';
    $('autoApplyInput').checked = !!S.autoApply;
    $('useClientToolsInput').checked = S.useClientTools !== false;
    $('reuseChatInput').checked = S.reuseChat !== false;
    $('contextCompactInput').value = S.contextCompactPercent ?? 80;
    $('contextModeInput').value = S.contextMode || 'minimal';
    $('routingProfileInput').value = S.routingProfile || 'eco';
    $('showReasoningInput').checked = S.showReasoning !== false;
    $('tierLightInput').value = (S.tiers?.light || []).join(', ');
    $('tierMediumInput').value = (S.tiers?.medium || []).join(', ');
    $('tierHeavyInput').value = (S.tiers?.heavy || []).join(', ');
    $('allowedInput').value = (S.allowedModels || []).join(', ');
    $('blockedInput').value = (S.blockedModels || []).join(', ');
  }
  function renderTiers() {
    const tm = S.tierModels || { light: [], medium: [], heavy: [] };
    const count = tier => S.modelsVerified ? (tm[tier]?.length ?? 0) : '—';
    $('cnt-light').textContent = count('light');
    $('cnt-medium').textContent = count('medium');
    $('cnt-heavy').textContent = count('heavy');
    document.querySelectorAll('#tierRow .chip').forEach(btn => {
      const ch = btn.dataset.choice;
      const tier = btn.dataset.tier;
      const match = tier && (tm[tier] || []).some(m => m.id === selectedChoice);
      btn.classList.toggle('on', selectedChoice === ch || Boolean(match));
      // Tier selection is meaningful only after the supplier list is verified.
      btn.disabled = Boolean(tier && !S.modelsVerified);
      btn.title = tier && !S.modelsVerified ? (S.modelsError || 'Disponibilité non vérifiée') : '';
    });
  }
  function showTierPopover(tier, anchor) {
    const list = (S.tierModels && S.tierModels[tier]) || [];
    const titles = { light: 'Modèles faibles', medium: 'Modèles équilibrés', heavy: 'Modèles forts' };
    $('popTitle').textContent = titles[tier] || 'Modèles';
    $('popList').innerHTML = list.length ? list.map(m =>
      '<button class="pop-item ' + (m.blocked ? 'blocked' : '') + '" data-pick="' + esc(m.id) + '" ' + (m.blocked ? 'disabled' : '') + '>' +
      '<span>' + esc(m.name) + '</span><span class="pop-prov">' + esc(m.provider) + '</span></button>'
    ).join('') : '<div class="empty-txt">' + esc(S.modelsVerified ? 'Aucun modèle disponible' : (S.modelsError || 'Disponibilité non vérifiée')) + '</div>';
    const r = anchor.getBoundingClientRect();
    const pop = $('tierPopover');
    pop.hidden = false;
    pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 6) + 'px';
    pop.style.left = Math.min(window.innerWidth - pop.offsetWidth - 8, Math.max(8, r.left)) + 'px';
  }
  function hidePopover() { clearTimeout(hoverTimer); $('tierPopover').hidden = true; }

  function diagTime(value) {
    return typeof value === 'number' ? new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'non vérifié';
  }
  function renderDiagnostics() {
    const target = $('diagnostics');
    const d = S.diagnostics;
    if (!target || !d) return;
    const api = d.api || {};
    const models = d.models || {};
    const session = d.session || {};
    const network = d.network || {};
    const quota = d.quota || {};
    const err = api.lastError ? (api.lastError.scope + ' : ' + api.lastError.message) : '';
    const rows = [
      ['Clé', d.credential?.configured ? 'présente dans SecretStorage (valeur masquée)' : 'absente'],
      ['API', err || (api.lastValidatedAt ? 'dernière validation ' + diagTime(api.lastValidatedAt) : 'non validée')],
      ['Modèles', models.verified ? 'liste fournisseur vérifiée' : 'liste non vérifiée'],
      ['Quota', quota.at ? (quota.remainingPct == null ? 'réponse sans pourcentage exploitable' : Math.round(quota.remainingPct) + ' % — ' + diagTime(quota.at)) : 'non vérifié'],
      ['MCP', d.mcp?.status + (d.mcp?.detail ? ' — ' + d.mcp.detail : '')],
      ['Session', session.active ? ('active' + (session.usagePercent == null ? '' : ' — ' + Math.round(session.usagePercent) + ' %')) : 'aucune session directe'],
      ['Réseau', (network.state || 'unknown') + (network.detail ? ' — ' + network.detail : '')],
    ];
    target.innerHTML = rows.map(row => '<div class="diagnostic-row"><span>' + esc(row[0]) + '</span><span class="diagnostic-value" title="' + esc(row[1]) + '">' + esc(row[1]) + '</span></div>').join('');
  }

  function tokenDetail(job) {
    const accounting = job.tokenAccounting || {};
    const values = [];
    if (typeof accounting.localInputEstimate === 'number') {
      values.push('Entrée : ≈ ' + accounting.localInputEstimate + ' tokens (estimation locale, caractères/4).');
    }
    const provider = accounting.providerTokens;
    if (accounting.providerReported && provider && typeof provider === 'object') {
      const labels = { inputTokens: 'entrée', outputTokens: 'sortie', reasoningTokens: 'raisonnement', totalTokens: 'total' };
      const reported = Object.entries(provider).filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => (labels[key] || key) + ' ' + value).join(', ');
      if (reported) values.push('Fournisseur : ' + reported + '.');
    } else if (accounting.providerReported) {
      values.push('Fournisseur : mesures reçues, format non affichable.');
    } else {
      values.push('Fournisseur : aucune mesure retournée.');
    }
    return values.join('\n');
  }

  function undoDetail(job) {
    const undo = job.undo || {};
    const values = [];
    if (undo.available) values.push('Restauration disponible dans cette session : ' + (undo.captured || []).join(', ') + '.');
    if ((undo.omitted || []).length) values.push('Non restaurable (limite de taille) : ' + undo.omitted.join(', ') + '.');
    if ((job.undoChanged || []).length) values.push('Non restauré, fichier modifié depuis l’application : ' + job.undoChanged.join(', ') + '.');
    if ((job.undoUnavailable || []).length) values.push('Indisponible : ' + job.undoUnavailable.join(', ') + '.');
    return values.join('\n');
  }

  function render() {
    const loaded = S.loaded === true;
    $('nokey').hidden = !loaded || !!S.hasKey;
    const q = S.quota && S.quota.remainingPct;
    const connected = loaded && !!S.hasKey && q != null;
    $('connPill').className = 'status-pill' + (connected ? ' on' : '');
    $('connTxt').textContent = !loaded ? 'Vérification…' : (connected ? 'API vérifiée' : (S.hasKey ? 'Clé enregistrée' : 'Hors ligne'));
    $('pct').textContent = q == null ? '—' : Math.round(q) + ' %';
    $('bar').style.width = (q == null ? 0 : q) + '%';
    $('gaugeBar').className = 'gauge' + (q == null ? '' : q < S.cutoff ? ' crit' : q < S.cutoff * 2 ? ' low' : '');
    const hasCutoff = typeof S.cutoff === 'number';
    $('cutoffTick').hidden = !hasCutoff;
    if (hasCutoff) {
      $('cutoffTick').style.left = S.cutoff + '%';
      $('cutoffNum').textContent = S.cutoff;
      $('cutoff').textContent = S.cutoff + ' %';
    } else {
      $('cutoff').textContent = '—';
    }
    $('qtxt').textContent = !loaded ? 'Vérification en cours…' : (S.quota?.at ? 'Mis à jour à ' + new Date(S.quota.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : 'Actualisation auto');
    document.querySelectorAll('#mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));

    renderTiers();
    renderDiagnostics();
    $('attachedChips').innerHTML = S.attached.map(f => '<span class="chip" data-detach="' + esc(f) + '">' + esc(f) + ' ✕</span>').join('');
    $('activeCount').textContent = loaded ? S.active.length : '—';
    $('active').innerHTML = S.active.length ? S.active.map(j => {
      const title = esc(j.title.replace(/^\\[ATG\\]\\s*/, ''));
      const thought = (j.lastThoughts && j.lastThoughts.length) ? j.lastThoughts[j.lastThoughts.length - 1] : (j.summary || j.route || 'En cours…');
      return '<div class="job-card"><div class="job-top"><span class="tag">ATG</span><span class="job-title">' + title + '</span>' +
        '<span class="model-pill">' + esc(j.model || 'routage') + '</span><button class="x" data-cancel="' + j.jobId + '">✕</button></div>' +
        '<div class="pbar"><div></div></div><div class="job-meta"><span>' + (j.receivedChars || 0) + ' car.</span>' +
        '<span data-start="' + (j.status === 'running' ? j.startedAt : '') + '">' + fmt(j.elapsedSec) + '</span></div>' +
        '<div class="term">&gt; ' + esc(thought) + '</div></div>';
    }).join('') : '<div class="empty-txt">Aucun agent actif</div>';

    $('historyCount').textContent = loaded ? S.history.length : '—';
    $('clearHistory').hidden = S.history.length === 0;
    $('history').innerHTML = S.history.length ? '<div class="hist-list">' + S.history.slice(0, 20).map(j => {
      const title = esc(j.title.replace(/^\\[ATG\\]\\s*/, ''));
      const noWrite = j.status === 'done' && (!j.executionMode || j.executionMode === 'apply') && (!j.filesWritten || !j.filesWritten.length);
      const icoClass = noWrite ? 'warn' : j.status;
      const ico = j.status === 'done' ? (noWrite ? '!' : '✓') : j.status === 'error' ? '✕' : '⏸';
      const refusalDetail = (j.refusals || []).map(r => 'Refus ' + r.model + ' : ' + r.reason).join('\\n');
      const detail = [j.filesWritten?.length ? 'Fichiers : ' + j.filesWritten.join(', ') : '', refusalDetail, j.summary || j.error || ''].filter(Boolean).join('\\n\\n');
      const refusalSuffix = j.refusals?.length ? ' · ' + j.refusals.length + ' refus' : '';
      const auditDetail = [
        j.proposedFiles?.length ? 'Proposition : ' + j.proposedFiles.join(', ') : '',
        j.executionMode ? 'Mode : ' + j.executionMode + (j.routingProfile ? ' | profil ' + j.routingProfile : '') : '',
        tokenDetail(j),
        undoDetail(j),
      ].filter(Boolean).join('\n\n');
      const actions = (j.reviewReady || j.undo?.available) ? '<div class="review-actions">' +
        (j.reviewReady ? '<button type="button" class="btn sm" data-apply-review="' + esc(j.jobId) + '">Voir / appliquer la proposition</button>' : '') +
        (j.undo?.available ? '<button type="button" class="btn ghost sm" data-undo="' + esc(j.jobId) + '">Restaurer</button>' : '') +
        '</div>' : '';
      return '<div class="hist-item" data-hist="' + j.jobId + '"><div class="hist-row">' +
        '<div class="st-ico ' + icoClass + '" title="' + (noWrite ? 'Terminé sans écriture de fichier' : '') + '">' + ico + '</div>' +
        '<div class="hist-main"><div class="hist-top"><span class="tag">ATG</span><span class="hist-title">' + title + '</span></div>' +
        '<div class="hist-sub">' + esc(j.model || 'Auto') + refusalSuffix + (noWrite ? ' · aucun fichier' : '') + ' · ' + esc(j.error || (j.receivedChars + ' car.')) + '</div></div></div>' +
        (expanded.has(j.jobId) && (detail || auditDetail) ? '<div class="hist-detail">' + esc([detail, auditDetail].filter(Boolean).join('\n\n')) + '</div>' : '') + actions + '</div>';
    }).join('') + '</div>' : '<div class="empty-txt">Pas encore d\\'historique</div>';
    if (!settingsLoaded) { syncSettings(); settingsLoaded = true; }
  }

  setInterval(() => document.querySelectorAll('[data-start]').forEach(el => {
    const t = Number(el.dataset.start); if (t) el.textContent = fmt(Math.round((Date.now() - t) / 1000));
  }), 1000);

  const SLASH_COMMANDS = [
    { cmd: '/send', label: 'Envoyer la demande' },
    { cmd: '/plan', executionMode: 'plan', label: 'Plan sans écriture' },
    { cmd: '/dry-run', executionMode: 'dry-run', label: 'Simulation révisable, sans écriture' },
    { cmd: '/eco', routingProfile: 'eco', label: 'Profil éco' },
    { cmd: '/fast', routingProfile: 'fast', label: 'Profil rapide' },
    { cmd: '/quality', routingProfile: 'quality', label: 'Profil qualité' },
    { cmd: '/security', routingProfile: 'security', label: 'Profil sécurité' },
    { cmd: '/refactor', routingProfile: 'refactor', label: 'Profil refactorisation' },
    { cmd: '/medium', choice: 'tier:medium', label: 'Niveau équilibré' },
    { cmd: '/fable', choice: 'fable', label: 'Claude Fable' },
    { cmd: '/gpt', choice: 'gpt-', label: 'Premier GPT autorisé' },
    { cmd: '/claude', choice: 'claude-', label: 'Premier Claude autorisé' },
    { cmd: '/new', action: 'new', label: 'Nouvelle session' },
    { cmd: '/compact', action: 'compact', label: 'Compacter la session' },
    { cmd: '/auto', choice: '', label: 'Auto' },
    { cmd: '/faible', choice: 'tier:light', label: 'Modèle faible' },
    { cmd: '/mid', choice: 'tier:medium', label: 'Modèle équilibré' },
    { cmd: '/élevé', choice: 'tier:heavy', label: 'Modèle fort' },
  ];
  const SLASH_MAP = {
    send: { label: 'Envoyer' },
    plan: { executionMode: 'plan', label: 'Plan sans écriture' },
    'dry-run': { executionMode: 'dry-run', label: 'Simulation révisable' },
    dryrun: { executionMode: 'dry-run', label: 'Simulation révisable' },
    preview: { executionMode: 'dry-run', label: 'Simulation révisable' },
    eco: { routingProfile: 'eco', label: 'Profil éco' },
    fast: { routingProfile: 'fast', label: 'Profil rapide' },
    rapide: { routingProfile: 'fast', label: 'Profil rapide' },
    quality: { routingProfile: 'quality', label: 'Profil qualité' },
    qualite: { routingProfile: 'quality', label: 'Profil qualité' },
    security: { routingProfile: 'security', label: 'Profil sécurité' },
    securite: { routingProfile: 'security', label: 'Profil sécurité' },
    refactor: { routingProfile: 'refactor', label: 'Profil refactorisation' },
    refacto: { routingProfile: 'refactor', label: 'Profil refactorisation' },
    fable: { choice: 'fable', label: 'Claude Fable' },
    gpt: { choice: 'gpt-', label: 'Premier GPT autorisé' },
    claude: { choice: 'claude-', label: 'Premier Claude autorisé' },
    new: { action: 'new', label: 'Nouvelle session' },
    compact: { action: 'compact', label: 'Session compactée' },
    auto: { choice: '', label: 'Auto' },
    faible: { choice: 'tier:light', label: 'Modèle faible' },
    leger: { choice: 'tier:light', label: 'Modèle faible' },
    light: { choice: 'tier:light', label: 'Modèle faible' },
    mid: { choice: 'tier:medium', label: 'Modèle équilibré' },
    moyen: { choice: 'tier:medium', label: 'Modèle équilibré' },
    equilibre: { choice: 'tier:medium', label: 'Modèle équilibré' },
    medium: { choice: 'tier:medium', label: 'Modèle équilibré' },
    eleve: { choice: 'tier:heavy', label: 'Modèle fort' },
    fort: { choice: 'tier:heavy', label: 'Modèle fort' },
    heavy: { choice: 'tier:heavy', label: 'Modèle fort' },
  };
  function parseSlash(raw) {
    const m = /^\\s*\\/([a-zA-ZÀ-ÿ0-9_-]+)(?:\\s+([\\s\\S]*))?$/.exec(raw);
    if (!m) return null;
    const key = m[1].toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
    const hit = SLASH_MAP[key];
    return hit ? { ...hit, rest: (m[2] || '').trim() } : null;
  }
  function updateCmdBar() {
    const val = $('task').value;
    const bar = $('cmdBar');
    if (!val.startsWith('/')) { bar.hidden = true; return; }
    const q = val.slice(1).split(/\\s/)[0].toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
    const matches = SLASH_COMMANDS.filter(c => c.cmd.slice(1).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').startsWith(q));
    if (!matches.length || /\\s/.test(val.trimStart())) { bar.hidden = true; return; }
    bar.innerHTML = matches.map(c => '<button type="button" class="chip" data-cmd="' + c.cmd + '">' + c.cmd + ' · ' + c.label + '</button>').join('');
    bar.hidden = false;
  }
  function send() {
    let task = $('task').value.trim(); if (!task) return;
    let executionMode;
    let routingProfile;
    const parsed = parseSlash(task);
    if (parsed) {
      if (Object.prototype.hasOwnProperty.call(parsed, 'choice')) { selectedChoice = parsed.choice; renderTiers(); }
      executionMode = parsed.executionMode;
      routingProfile = parsed.routingProfile;
      if (parsed.action) vscode.postMessage({ type: 'session', action: parsed.action });
      if (!parsed.rest) { $('task').value = ''; updateCmdBar(); return; }
      task = parsed.rest;
    }
    vscode.postMessage({ type: 'delegate', task, model: selectedChoice || undefined, contextMode: S.contextMode || 'minimal', executionMode, routingProfile });
    $('task').value = '';
    updateCmdBar();
    hidePopover();
  }
  document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $('go').onclick = send;
  $('task').addEventListener('input', updateCmdBar);
  $('task').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { send(); return; }
    const p = parseSlash($('task').value.trim());
    if (e.key === 'Enter' && !e.shiftKey && p && !p.rest) { e.preventDefault(); send(); }
  });
  $('useAllBtn').onclick = () => {
    $('cutoffInput').value = 0;
    vscode.postMessage({ type: 'saveSettings', cutoffPercent: 0 });
  };
  $('attach').onclick = () => vscode.postMessage({ type: 'attach' });
  $('log').onclick = () => vscode.postMessage({ type: 'log' });
  $('gauge').onclick = () => vscode.postMessage({ type: 'refresh' });
  $('setkey').onclick = $('keyBtn').onclick = () => vscode.postMessage({ type: 'key' });
  $('clearKeyBtn').onclick = () => vscode.postMessage({ type: 'clearKey' });
  $('copyMcpBtn').onclick = () => vscode.postMessage({ type: 'copyMcp' });
  $('refreshDiagnosticsBtn').onclick = () => vscode.postMessage({ type: 'refreshDiagnostics' });
  $('clearHistory').onclick = () => vscode.postMessage({ type: 'clearHistory' });
  document.querySelectorAll('#tierRow .chip[data-tier]').forEach(btn => {
    const tier = btn.dataset.tier;
    btn.addEventListener('mouseenter', () => { clearTimeout(popHideTimer); clearTimeout(hoverTimer); hoverTimer = setTimeout(() => showTierPopover(tier, btn), 320); });
    btn.addEventListener('pointerdown', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => showTierPopover(tier, btn), 320); });
    btn.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); popHideTimer = setTimeout(hidePopover, 220); });
  });
  $('tierPopover').addEventListener('mouseenter', () => clearTimeout(popHideTimer));
  $('tierPopover').addEventListener('mouseleave', () => { popHideTimer = setTimeout(hidePopover, 160); });
  $('saveSettingsBtn').onclick = () => {
    const split = v => v.split(',').map(s => s.trim()).filter(Boolean);
    vscode.postMessage({
      type: 'saveSettings',
      cutoffPercent: Number($('cutoffInput').value),
      maxParallel: Number($('maxParallelInput').value),
      autoPowerUp: $('powerUpInput').value,
      autoApply: $('autoApplyInput').checked,
      useClientTools: $('useClientToolsInput').checked,
      reuseChat: $('reuseChatInput').checked,
      contextCompactPercent: Number($('contextCompactInput').value),
      contextMode: $('contextModeInput').value,
      routingProfile: $('routingProfileInput').value,
      showReasoning: $('showReasoningInput').checked,
      tiers: { light: split($('tierLightInput').value), medium: split($('tierMediumInput').value), heavy: split($('tierHeavyInput').value) },
      allowedModels: split($('allowedInput').value),
      blockedModels: split($('blockedInput').value),
    });
  };
  document.querySelectorAll('#mode button').forEach(b => b.onclick = () => vscode.postMessage({ type: 'mode', mode: b.dataset.mode }));
  document.addEventListener('click', e => {
    const applyReview = e.target.closest('[data-apply-review]');
    if (applyReview) { e.stopPropagation(); vscode.postMessage({ type: 'applyReview', id: applyReview.dataset.applyReview }); return; }
    const undo = e.target.closest('[data-undo]');
    if (undo) { e.stopPropagation(); vscode.postMessage({ type: 'undo', id: undo.dataset.undo }); return; }
    const cmdBtn = e.target.closest('[data-cmd]');
    if (cmdBtn) {
      const parsed = parseSlash(cmdBtn.dataset.cmd);
      if (parsed) {
        if (Object.prototype.hasOwnProperty.call(parsed, 'choice')) { selectedChoice = parsed.choice; renderTiers(); }
        if (parsed.action) vscode.postMessage({ type: 'session', action: parsed.action });
        $('task').value = (parsed.executionMode || parsed.routingProfile) ? cmdBtn.dataset.cmd + ' ' : '';
        updateCmdBar(); $('task').focus();
      }
      return;
    }
    const p = e.target.closest('[data-pick]'); if (p && !p.disabled) { selectedChoice = p.dataset.pick; hidePopover(); renderTiers(); return; }
    const ch = e.target.closest('[data-choice]'); if (ch) { selectedChoice = ch.dataset.choice; renderTiers(); return; }
    if (!e.target.closest('#tierPopover') && !e.target.closest('#tierRow')) hidePopover();
    const c = e.target.closest('[data-cancel]'); if (c) { vscode.postMessage({ type: 'cancel', id: c.dataset.cancel }); return; }
    const d = e.target.closest('[data-detach]'); if (d) { vscode.postMessage({ type: 'detach', file: d.dataset.detach }); return; }
    const h = e.target.closest('[data-hist]'); if (h) { const id = h.dataset.hist; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); }
  });
  renderTiers();
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}
