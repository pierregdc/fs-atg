import * as vscode from 'vscode';

// Routage 100 % local : aucun token consommé pour décider.

export type Tier = 'light' | 'medium' | 'heavy';
export interface RouteConfig { allowed: string[]; blocked: string[]; tiers: Record<Tier, string[]>; }
export interface Route { model: string; prompt: string; reason: string; }

const DEFAULT_TIERS: Record<Tier, string[]> = {
  light: ['haiku', 'luna', 'mini', 'nano', 'flash'],
  medium: ['sonnet', 'terra', 'gpt-5.6-sol', 'kimi-k2'],
  heavy: ['fable', 'opus', 'astra', 'gpt-6-sol', 'gpt-6.1-sol', 'kimi-k3'],
};

const HEAVY = /(architect|refactor|migration|sécurité|security|concurren|optimi[sz]|algorithm|debug|bug|race condition|performance|plusieurs fichiers)/i;
const LIGHT = /(renomm|rename|commentaire|comment|docstring|readme|typo|formate|format|tradui|translate|lint|import)/i;

const TIER_ALIAS: Record<string, Tier> = {
  faible: 'light', leger: 'light', light: 'light',
  mid: 'medium', moyen: 'medium', equilibre: 'medium', intermediaire: 'medium', medium: 'medium',
  fort: 'heavy', eleve: 'heavy', puissant: 'heavy', heavy: 'heavy',
};

export function routeConfig(): RouteConfig {
  const c = vscode.workspace.getConfiguration('francestudent');
  return {
    allowed: c.get<string[]>('allowedModels', []),
    blocked: c.get<string[]>('blockedModels', []),
    tiers: c.get<Record<Tier, string[]>>('tiers', DEFAULT_TIERS),
  };
}

export function classifyTier(id: string, cfg: RouteConfig): Tier {
  const s = id.toLowerCase();
  const has = (pats: string[]) => (pats ?? []).some(p => s.includes(p.toLowerCase()));
  if (has(cfg.tiers.heavy)) return 'heavy';
  if (has(cfg.tiers.light)) return 'light';
  if (has(cfg.tiers.medium)) return 'medium';
  return 'medium';
}

export function pickModel(raw: string, available: string[], cfg: RouteConfig, explicit?: string): Route {
  const has = (id: string, pats: string[]) => pats.some(p => id.toLowerCase().includes(p.toLowerCase()));
  const pool = available.filter(id => (!cfg.allowed.length || has(id, cfg.allowed)) && !has(id, cfg.blocked));
  if (!pool.length) throw new Error('Aucun modèle autorisé disponible (vérifie listes blanche/noire).');

  // Forçage : /auto, /faible, /mid, /élevé, [faible] / [equilibre] / [fort] / [haiku] ... ou choix explicite dans le panneau.
  let prompt = raw;
  const tag = /^\s*\[([\w.\- ]+)\]\s*/.exec(raw);
  const tagModel = tag && tag[1].toUpperCase() !== 'ATG' ? tag[1] : undefined;
  if (tagModel) prompt = raw.slice(tag![0].length);

  const slash = /^\s*\/([a-zA-ZÀ-ÿ0-9_-]+)(?:\s+|$)/.exec(prompt);
  const slashNorm = slash ? slash[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';
  const SLASH_CMDS: Record<string, Tier | 'auto'> = { ...TIER_ALIAS, auto: 'auto' };
  const slashTarget = SLASH_CMDS[slashNorm];
  if (slashTarget) prompt = prompt.slice(slash![0].length);

  const wanted = slashTarget === 'auto' ? undefined : (slashTarget || explicit || tagModel);
  const norm = wanted ? wanted.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^tier:/, '') : '';
  const forcedTier = TIER_ALIAS[norm];

  if (wanted && !forcedTier) {
    const hit = pool.find(id => has(id, [wanted]));
    if (hit) return { model: hit, prompt, reason: `forcé : ${wanted}` };
    throw new Error(`Modèle « ${wanted} » indisponible ou interdit par ta liste noire.`);
  }

  const tier: Tier = forcedTier ?? (HEAVY.test(prompt) || prompt.length > 4000 ? 'heavy'
    : LIGHT.test(prompt) && prompt.length < 800 ? 'light' : 'medium');
  const order: Tier[] = tier === 'heavy' ? ['heavy', 'medium', 'light']
    : tier === 'light' ? ['light', 'medium', 'heavy'] : ['medium', 'heavy', 'light'];
  for (const t of order) {
    const hit = pool.find(id => classifyTier(id, cfg) === t);
    if (hit) {
      const label = t === 'light' ? 'faible' : t === 'heavy' ? 'fort' : 'équilibré';
      return { model: hit, prompt, reason: forcedTier ? `catégorie : ${label}` : `auto : ${label}${t !== tier ? ' (repli)' : ''}` };
    }
  }
  return { model: pool[0], prompt, reason: 'auto : premier modèle autorisé' };
}
