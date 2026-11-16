import * as vscode from 'vscode';
import { ATG, FranceStudentClient, FsError } from './api';

export interface QuotaSnapshot {
  remainingPct: number | null;
  sources: number;
  at: number;
  resetAt?: string | null;
  totalTokens?: number | null;
}

export class QuotaGuard {
  private cache?: QuotaSnapshot;
  private lastPowerUp = 0;
  private readonly emitter = new vscode.EventEmitter<QuotaSnapshot>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly client: FranceStudentClient) {}

  get last() { return this.cache; }
  invalidate() { this.cache = undefined; }

  async snapshot(force = false): Promise<QuotaSnapshot> {
    if (!force && this.cache && Date.now() - this.cache.at < 30_000) return this.cache;
    const [usage, tokens] = await Promise.all([
      this.client.usage(),
      this.client.tokenUsage().catch(() => undefined),
    ]);
    const u = usage as { chatBudget?: { remainingPercent?: number; usedPercent?: number; resetAt?: string } } | undefined;
    const t = tokens as { totalTokenCount?: number } | undefined;
    const chatPct = typeof u?.chatBudget?.remainingPercent === 'number'
      ? u.chatBudget.remainingPercent
      : (typeof u?.chatBudget?.usedPercent === 'number' ? 100 - u.chatBudget.usedPercent : null);
    const pcts = chatPct !== null ? [chatPct] : [...remainingPercents(usage), ...remainingPercents(tokens)];
    this.cache = {
      remainingPct: pcts.length ? Math.max(0, Math.min(100, Math.min(...pcts))) : null, // le plus contraignant
      sources: pcts.length,
      at: Date.now(),
      resetAt: u?.chatBudget?.resetAt ?? null,
      totalTokens: t?.totalTokenCount ?? null,
    };
    this.emitter.fire(this.cache);
    return this.cache;
  }

  async ensureCanDelegate(): Promise<void> {
    const cutoff = vscode.workspace.getConfiguration('francestudent').get<number>('cutoffPercent', 15);
    const s = await this.snapshot();
    if (s.remainingPct !== null && s.remainingPct < cutoff) {
      throw new FsError('CUTOFF', `Coupe-circuit : il reste ${s.remainingPct.toFixed(0)} % (seuil ${cutoff} %). Délégation bloquée.`);
    }
  }

  /** Appelé uniquement après un HTTP 429. Au maximum un power-up toutes les 10 min. */
  async tryPowerUp(reason: string): Promise<boolean> {
    const mode = vscode.workspace.getConfiguration('francestudent').get<string>('autoPowerUp', 'ask');
    if (mode === 'off' || Date.now() - this.lastPowerUp < 10 * 60_000) return false;
    if (mode === 'ask') {
      const c = await vscode.window.showWarningMessage(
        `${ATG} Limite de débit atteinte pendant « ${reason} ». Activer un power-up ?`, { modal: true }, 'Activer');
      if (c !== 'Activer') return false;
    }
    try {
      await this.client.activatePowerUp();
      this.lastPowerUp = Date.now();
      this.invalidate();
      vscode.window.setStatusBarMessage(`${ATG} Power-up activé`, 5000);
      return true;
    } catch (e) {
      vscode.window.showWarningMessage(`${ATG} Power-up impossible : ${(e as Error).message}`);
      return false;
    }
  }
}

/**
 * Heuristique TEMPORAIRE : ta copie de la doc ne détaille pas UserUsageDto.
 * On cherche des paires (utilisé|restant, limite) partout dans le JSON.
 * → À remplacer par les vrais champs dès que tu as le schéma.
 */
export function remainingPercents(obj: unknown, out: number[] = [], depth = 0): number[] {
  if (!obj || typeof obj !== 'object' || depth > 5) return out;
  const o = obj as Record<string, unknown>;
  if (typeof o.remainingPercent === 'number') out.push(o.remainingPercent);
  else if (typeof o.usedPercent === 'number') out.push(100 - o.usedPercent);
  const pick = (re: RegExp) => {
    for (const [k, v] of Object.entries(o)) if (re.test(k) && typeof v === 'number') return v;
    return undefined;
  };
  const limit = pick(/^(limit|max|quota|budget|total)$/i);
  const used = pick(/^(used|usage|consumed|spent|current)$/i);
  const remaining = pick(/^(remaining|left|available)$/i);
  if (limit && limit > 0) {
    if (remaining !== undefined) out.push((100 * remaining) / limit);
    else if (used !== undefined) out.push(100 * (1 - used / limit));
  }
  for (const v of Object.values(o)) if (v && typeof v === 'object') remainingPercents(v, out, depth + 1);
  return out;
}
