import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { FranceStudentClient, DEFAULT_AGENTS } from './api';
import { QuotaGuard } from './quota';
import { Orchestrator } from './orchestrator';
import { classifyTier, routeConfig, Tier } from './router';

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
    const models = await this.orch.models().catch(() => DEFAULT_AGENTS.map(a => a.model));
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
    return {
      type: 'state',
      hasKey: await this.client.hasKey(),
      quota: this.quota.last ?? null,
      cutoff: c.get('cutoffPercent', 15),
      mode: c.get('mode', 'eco'),
      maxParallel: c.get('maxParallel', 3),
      baseUrl: c.get('baseUrl', 'https://api.francestudent.org'),
      autoPowerUp: c.get('autoPowerUp', 'ask'),
      autoApply: c.get('autoApply', false),
      useClientTools: c.get('useClientTools', true),
      showReasoning: c.get('showReasoning', true),
      allowedModels: cfg.allowed,
      blockedModels: cfg.blocked,
      tiers: cfg.tiers,
      tierModels,
      models,
      attached: this.attached,
      active: this.orch.active().map(j => this.orch.publicView(j)),
      history: this.orch.historyList().map(j => this.orch.publicView(j)),
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
        this.orch.submit({ task: m.task, model: m.model || undefined, files: this.attached, source: 'panel' });
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
        if (typeof m.baseUrl === 'string' && m.baseUrl.trim()) await cfg.update('baseUrl', m.baseUrl.trim(), vscode.ConfigurationTarget.Global);
        if (typeof m.cutoffPercent === 'number') await cfg.update('cutoffPercent', Math.max(0, Math.min(90, m.cutoffPercent)), vscode.ConfigurationTarget.Global);
        if (typeof m.maxParallel === 'number') await cfg.update('maxParallel', Math.max(1, Math.min(6, m.maxParallel)), vscode.ConfigurationTarget.Global);
        if (typeof m.autoPowerUp === 'string') await cfg.update('autoPowerUp', m.autoPowerUp, vscode.ConfigurationTarget.Global);
        if (typeof m.autoApply === 'boolean') await cfg.update('autoApply', m.autoApply, vscode.ConfigurationTarget.Global);
        if (typeof m.useClientTools === 'boolean') await cfg.update('useClientTools', m.useClientTools, vscode.ConfigurationTarget.Global);
        if (typeof m.showReasoning === 'boolean') await cfg.update('showReasoning', m.showReasoning, vscode.ConfigurationTarget.Global);
        if (Array.isArray(m.allowedModels)) await cfg.update('allowedModels', m.allowedModels, vscode.ConfigurationTarget.Global);
        if (Array.isArray(m.blockedModels)) await cfg.update('blockedModels', m.blockedModels, vscode.ConfigurationTarget.Global);
        if (m.tiers && typeof m.tiers === 'object') await cfg.update('tiers', m.tiers, vscode.ConfigurationTarget.Global);
        this.push();
        vscode.window.setStatusBarMessage('[ATG] Paramètres enregistrés', 3000);
        break;
      case 'refresh': await this.quota.snapshot(true).catch(e => vscode.window.showWarningMessage(String(e.message))); break;
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
        <span class="status-pill" id="connPill"><span class="dot"></span><span id="connTxt">Hors ligne</span></span>
      </div>
      <div class="qrow"><span>Budget chat restant</span><span class="pct-val" id="pct">—</span></div>
      <div class="gauge-wrap" id="gauge" title="Actualisé automatiquement (clic pour forcer)">
        <div class="gauge" id="gaugeBar"><div id="bar"></div></div>
        <div class="cutoff-tick" id="cutoffTick" style="left:15%"><div class="cutoff-line"></div><div class="cutoff-lbl" id="cutoffNum">15</div></div>
      </div>
      <div class="meta"><span id="qtxt">Actualisation auto</span><span>Coupe-circuit : <b id="cutoff">15 %</b></span></div>
    </div>

    <div class="seg" id="mode">
      <button data-mode="eco">Éco <span class="sub-txt">· 1 agent</span></button>
      <button data-mode="fast">Rapide <span class="sub-txt">· multi</span></button>
    </div>

    <div class="composer">
      <textarea id="task" placeholder="Décris la tâche… (Ctrl+Entrée)"></textarea>
      <div class="tier-row" id="attachedChips"></div>
      <div class="tier-row" id="tierRow">
        <button class="chip on" data-choice="">Auto</button>
        <button class="chip" data-choice="tier:light" data-tier="light">Modèle faible <span class="chip-cnt" id="cnt-light">0</span></button>
        <button class="chip" data-choice="tier:medium" data-tier="medium">Modèle équilibré <span class="chip-cnt" id="cnt-medium">0</span></button>
        <button class="chip" data-choice="tier:heavy" data-tier="heavy">Modèle fort <span class="chip-cnt" id="cnt-heavy">0</span></button>
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

    <div class="sec-head"><div class="sec-title">Agents actifs <span class="cnt" id="activeCount">0</span></div></div>
    <div id="active"></div>

    <div class="sec-head">
      <div class="sec-title">Historique <span class="cnt" id="historyCount">0</span></div>
      <button class="link-btn" id="clearHistory" hidden>Tout effacer</button>
    </div>
    <div id="history"></div>
  </div>

  <div id="tab-settings" class="view" hidden>
    <div class="settings-card">
      <div class="field"><label>Clé API / Jeton de session</label>
        <div class="actions"><button class="btn sm" id="keyBtn">Enregistrer</button><button class="btn danger sm" id="clearKeyBtn">Oublier</button><button class="btn ghost sm" id="copyMcpBtn">Config MCP</button></div>
      </div>
      <div class="field"><label>URL de base API</label><input type="text" id="baseUrlInput" /></div>
      <div class="grid-2">
        <div class="field"><label>Coupe-circuit (%)</label><input type="number" id="cutoffInput" min="0" max="90" /></div>
        <div class="field"><label>Agents parallèles</label><input type="number" id="maxParallelInput" min="1" max="6" /></div>
      </div>
      <div class="field"><label>Power-up HTTP 429</label>
        <select id="powerUpInput"><option value="ask">Demander confirmation</option><option value="auto">Automatique</option><option value="off">Désactivé</option></select>
      </div>
      <div class="field"><div class="toggle-row"><span>Appliquer sans confirmation</span><label class="switch"><input type="checkbox" id="autoApplyInput" /><span class="slider"></span></label></div></div>
      <div class="field"><div class="toggle-row"><span>Outils client natifs</span><label class="switch"><input type="checkbox" id="useClientToolsInput" /><span class="slider"></span></label></div></div>
      <div class="field"><div class="toggle-row"><span>Résumé de raisonnement</span><label class="switch"><input type="checkbox" id="showReasoningInput" /><span class="slider"></span></label></div></div>
    </div>
    <div class="settings-card">
      <div class="field"><label>Modèle faible (légers)</label><input type="text" id="tierLightInput" /></div>
      <div class="field"><label>Modèle équilibré (intermédiaires)</label><input type="text" id="tierMediumInput" /></div>
      <div class="field"><label>Modèle fort (puissants)</label><input type="text" id="tierHeavyInput" /></div>
      <div class="grid-2">
        <div class="field"><label>Autorisés</label><input type="text" id="allowedInput" placeholder="Vide = tous" /></div>
        <div class="field"><label>Interdits</label><input type="text" id="blockedInput" placeholder="Ex: fable" /></div>
      </div>
      <button class="btn sm" id="saveSettingsBtn">Enregistrer les paramètres</button>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let S = {
    active: [], history: [],
    models: ['gpt-5.6-luna', 'gpt-6-luna', 'claude-haiku-5-5', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6.1-terra', 'claude-sonnet-5-5', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'claude-opus-5-5', 'claude-fable-5-2'],
    tierModels: {
      light: [{ id:'gpt-5.6-luna', name:'gpt-5.6-luna', provider:'openai', blocked:false }, { id:'gpt-6-luna', name:'GPT 6 Luna', provider:'openai', blocked:false }, { id:'claude-haiku-5-5', name:'Claude Haiku 5.5', provider:'anthropic', blocked:false }],
      medium: [{ id:'gpt-5.6-terra', name:'gpt-5.6-terra', provider:'openai', blocked:false }, { id:'gpt-5.6-sol', name:'gpt-5.6-sol', provider:'openai', blocked:false }, { id:'gpt-6.1-terra', name:'GPT-6.1 Terra', provider:'openai', blocked:false }, { id:'claude-sonnet-5-5', name:'Claude Sonnet 5.5', provider:'anthropic', blocked:false }],
      heavy: [{ id:'gpt-6-sol', name:'GPT 6 Sol', provider:'openai', blocked:false }, { id:'gpt-6.1-sol', name:'GPT 6.1 Sol', provider:'openai', blocked:false }, { id:'gpt-6-astra', name:'GPT-6 Astra', provider:'openai', blocked:false }, { id:'claude-opus-5-5', name:'Claude Opus 5.5', provider:'anthropic', blocked:false }, { id:'claude-fable-5-2', name:'Claude Fable 5.2', provider:'anthropic', blocked:false }]
    },
    tiers: { light:['haiku','luna','mini','nano','flash'], medium:['sonnet','terra','gpt-5.6-sol','kimi-k2'], heavy:['fable','opus','astra','gpt-6-sol','gpt-6.1-sol','kimi-k3'] },
    attached: [], cutoff: 15, mode: 'eco'
  };
  let selectedChoice = '';
  let settingsLoaded = false;
  let hoverTimer = null;
  let popHideTimer = null;
  const expanded = new Set();

  window.addEventListener('message', e => { if (e.data.type === 'state') { S = e.data; render(); } });
  function fmt(sec) { return sec >= 60 ? Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s' : sec + ' s'; }
  function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $('tab-dash').hidden = tab !== 'dash';
    $('tab-settings').hidden = tab !== 'settings';
  }
  function syncSettings() {
    $('baseUrlInput').value = S.baseUrl || 'https://api.francestudent.org';
    $('cutoffInput').value = S.cutoff ?? 15;
    $('maxParallelInput').value = S.maxParallel ?? 3;
    $('powerUpInput').value = S.autoPowerUp || 'ask';
    $('autoApplyInput').checked = !!S.autoApply;
    $('useClientToolsInput').checked = S.useClientTools !== false;
    $('showReasoningInput').checked = S.showReasoning !== false;
    $('tierLightInput').value = (S.tiers?.light || []).join(', ');
    $('tierMediumInput').value = (S.tiers?.medium || []).join(', ');
    $('tierHeavyInput').value = (S.tiers?.heavy || []).join(', ');
    $('allowedInput').value = (S.allowedModels || []).join(', ');
    $('blockedInput').value = (S.blockedModels || []).join(', ');
  }
  function renderTiers() {
    const tm = S.tierModels || { light: [], medium: [], heavy: [] };
    $('cnt-light').textContent = tm.light?.length ?? 0;
    $('cnt-medium').textContent = tm.medium?.length ?? 0;
    $('cnt-heavy').textContent = tm.heavy?.length ?? 0;
    document.querySelectorAll('#tierRow .chip').forEach(btn => {
      const ch = btn.dataset.choice;
      const tier = btn.dataset.tier;
      const match = tier && (tm[tier] || []).some(m => m.id === selectedChoice);
      btn.classList.toggle('on', selectedChoice === ch || Boolean(match));
    });
  }
  function showTierPopover(tier, anchor) {
    const list = (S.tierModels && S.tierModels[tier]) || [];
    const titles = { light: 'Modèles faibles', medium: 'Modèles équilibrés', heavy: 'Modèles forts' };
    $('popTitle').textContent = titles[tier] || 'Modèles';
    $('popList').innerHTML = list.length ? list.map(m =>
      '<button class="pop-item ' + (m.blocked ? 'blocked' : '') + '" data-pick="' + esc(m.id) + '" ' + (m.blocked ? 'disabled' : '') + '>' +
      '<span>' + esc(m.name) + '</span><span class="pop-prov">' + esc(m.provider) + '</span></button>'
    ).join('') : '<div class="empty-txt">Aucun modèle</div>';
    const r = anchor.getBoundingClientRect();
    const pop = $('tierPopover');
    pop.hidden = false;
    pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 6) + 'px';
    pop.style.left = Math.min(window.innerWidth - pop.offsetWidth - 8, Math.max(8, r.left)) + 'px';
  }
  function hidePopover() { clearTimeout(hoverTimer); $('tierPopover').hidden = true; }

  function render() {
    $('nokey').hidden = !!S.hasKey;
    const q = S.quota && S.quota.remainingPct;
    const connected = !!S.hasKey && q != null;
    $('connPill').className = 'status-pill' + (connected ? ' on' : '');
    $('connTxt').textContent = connected ? 'Connecté' : (S.hasKey ? 'Clé enregistrée' : 'Hors ligne');
    $('pct').textContent = q == null ? '—' : Math.round(q) + ' %';
    $('bar').style.width = (q == null ? 0 : q) + '%';
    $('gaugeBar').className = 'gauge' + (q == null ? '' : q < S.cutoff ? ' crit' : q < S.cutoff * 2 ? ' low' : '');
    $('cutoffTick').style.left = S.cutoff + '%';
    $('cutoffNum').textContent = S.cutoff;
    $('cutoff').textContent = S.cutoff + ' %';
    $('qtxt').textContent = S.quota?.at ? 'Mis à jour à ' + new Date(S.quota.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : 'Actualisation auto';
    document.querySelectorAll('#mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));

    renderTiers();
    $('attachedChips').innerHTML = S.attached.map(f => '<span class="chip" data-detach="' + esc(f) + '">' + esc(f) + ' ✕</span>').join('');
    $('activeCount').textContent = S.active.length;
    $('active').innerHTML = S.active.length ? S.active.map(j => {
      const title = esc(j.title.replace(/^\\[ATG\\]\\s*/, ''));
      const thought = (j.lastThoughts && j.lastThoughts.length) ? j.lastThoughts[j.lastThoughts.length - 1] : (j.summary || j.route || 'En cours…');
      return '<div class="job-card"><div class="job-top"><span class="tag">ATG</span><span class="job-title">' + title + '</span>' +
        '<span class="model-pill">' + esc(j.model || 'routage') + '</span><button class="x" data-cancel="' + j.jobId + '">✕</button></div>' +
        '<div class="pbar"><div></div></div><div class="job-meta"><span>' + (j.receivedChars || 0) + ' car.</span>' +
        '<span data-start="' + (j.status === 'running' ? j.startedAt : '') + '">' + fmt(j.elapsedSec) + '</span></div>' +
        '<div class="term">&gt; ' + esc(thought) + '</div></div>';
    }).join('') : '<div class="empty-txt">Aucun agent actif</div>';

    $('historyCount').textContent = S.history.length;
    $('clearHistory').hidden = S.history.length === 0;
    $('history').innerHTML = S.history.length ? '<div class="hist-list">' + S.history.slice(0, 20).map(j => {
      const title = esc(j.title.replace(/^\\[ATG\\]\\s*/, ''));
      const noWrite = j.status === 'done' && (!j.filesWritten || !j.filesWritten.length);
      const icoClass = noWrite ? 'warn' : j.status;
      const ico = j.status === 'done' ? (noWrite ? '!' : '✓') : j.status === 'error' ? '✕' : '⏸';
      const detail = [j.filesWritten?.length ? 'Fichiers : ' + j.filesWritten.join(', ') : '', j.summary || j.error || ''].filter(Boolean).join('\\n\\n');
      return '<div class="hist-item" data-hist="' + j.jobId + '"><div class="hist-row">' +
        '<div class="st-ico ' + icoClass + '" title="' + (noWrite ? 'Terminé sans écriture de fichier' : '') + '">' + ico + '</div>' +
        '<div class="hist-main"><div class="hist-top"><span class="tag">ATG</span><span class="hist-title">' + title + '</span></div>' +
        '<div class="hist-sub">' + esc(j.model || 'Auto') + (noWrite ? ' · aucun fichier' : '') + ' · ' + esc(j.error || (j.receivedChars + ' car.')) + '</div></div></div>' +
        (expanded.has(j.jobId) && detail ? '<div class="hist-detail">' + esc(detail) + '</div>' : '') + '</div>';
    }).join('') + '</div>' : '<div class="empty-txt">Pas encore d\\'historique</div>';
    if (!settingsLoaded) { syncSettings(); settingsLoaded = true; }
  }

  setInterval(() => document.querySelectorAll('[data-start]').forEach(el => {
    const t = Number(el.dataset.start); if (t) el.textContent = fmt(Math.round((Date.now() - t) / 1000));
  }), 1000);

  function send() {
    const task = $('task').value.trim(); if (!task) return;
    vscode.postMessage({ type: 'delegate', task, model: selectedChoice || undefined });
    $('task').value = '';
    hidePopover();
  }
  document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $('go').onclick = send;
  $('task').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
  $('attach').onclick = () => vscode.postMessage({ type: 'attach' });
  $('log').onclick = () => vscode.postMessage({ type: 'log' });
  $('gauge').onclick = () => vscode.postMessage({ type: 'refresh' });
  $('setkey').onclick = $('keyBtn').onclick = () => vscode.postMessage({ type: 'key' });
  $('clearKeyBtn').onclick = () => vscode.postMessage({ type: 'clearKey' });
  $('copyMcpBtn').onclick = () => vscode.postMessage({ type: 'copyMcp' });
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
      baseUrl: $('baseUrlInput').value.trim(),
      cutoffPercent: Number($('cutoffInput').value),
      maxParallel: Number($('maxParallelInput').value),
      autoPowerUp: $('powerUpInput').value,
      autoApply: $('autoApplyInput').checked,
      useClientTools: $('useClientToolsInput').checked,
      showReasoning: $('showReasoningInput').checked,
      tiers: { light: split($('tierLightInput').value), medium: split($('tierMediumInput').value), heavy: split($('tierHeavyInput').value) },
      allowedModels: split($('allowedInput').value),
      blockedModels: split($('blockedInput').value),
    });
  };
  document.querySelectorAll('#mode button').forEach(b => b.onclick = () => vscode.postMessage({ type: 'mode', mode: b.dataset.mode }));
  document.addEventListener('click', e => {
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
