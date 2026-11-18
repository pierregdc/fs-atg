import * as vscode from 'vscode';

// Routage 100 % local : aucun token consommé pour décider.

export type Tier = 'light' | 'medium' | 'heavy';
export type RoutingProfile = 'eco' | 'fast' | 'quality' | 'security' | 'refactor';
export type ExecutionMode = 'apply' | 'plan' | 'dry-run';
export interface RouteConfig {
  allowed: string[];
  blocked: string[];
  tiers: Record<Tier, string[]>;
  routingProfile: RoutingProfile;
}
export interface Route {
  model: string;
  prompt: string;
  reason: string;
  routingProfile: RoutingProfile;
  executionMode: ExecutionMode;
}

const DEFAULT_TIERS: Record<Tier, string[]> = {
  light: ['haiku', 'luna', 'mini', 'nano', 'flash'],
  medium: ['sonnet', 'terra', 'gpt-5.6-sol', 'kimi-k2'],
  heavy: ['fable', 'opus', 'astra', 'gpt-6-sol', 'gpt-6.1-sol', 'kimi-k3'],
};

const HEAVY = /(architect|refactor|migration|sécurité|security|concurren|optimi[sz]|algorithm|debug|bug|race condition|performance|plusieurs fichiers)/i;
const LIGHT = /(renomm|rename|commentaire|comment|docstring|readme|typo|formate|format|tradui|translate|lint|import)/i;

const TIER_ALIAS: Record<string, Tier> = {
  faible: 'light', leger: 'light', light: 'light', low: 'light',
  mid: 'medium', moyen: 'medium', equilibre: 'medium', intermediaire: 'medium', medium: 'medium',
  fort: 'heavy', eleve: 'heavy', puissant: 'heavy', heavy: 'heavy', high: 'heavy',
};

const SLASH_MODEL: Record<string, string> = {
  fable: 'fable', opus: 'opus', sonnet: 'sonnet', haiku: 'haiku',
  terra: 'terra', sol: 'sol', luna: 'luna', gpt: 'gpt-', claude: 'claude-',
};

const PROFILE_ALIASES: Record<string, RoutingProfile> = {
  eco: 'eco',
  fast: 'fast', rapide: 'fast',
  quality: 'quality', qualite: 'quality', qualité: 'quality',
  security: 'security', securite: 'security', sécurité: 'security',
  refactor: 'refactor', refacto: 'refactor',
};

export interface TaskControls {
  prompt: string;
  explicit?: string;
  forcedTier?: Tier;
  routingProfile?: RoutingProfile;
  executionMode: ExecutionMode;
}

function normalizeCommand(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Strip only known local controls before a request leaves Antigravity.
 * The resulting prompt remains a normal human development request.
 */
export function parseTaskControls(raw: string, explicit?: string): TaskControls {
  let prompt = raw;
  const tag = /^\s*\[([\w.\- ]+)\]\s*/.exec(prompt);
  const tagModel = tag && tag[1].toUpperCase() !== 'ATG' ? tag[1] : undefined;
  if (tagModel) prompt = prompt.slice(tag![0].length);

  let executionMode: ExecutionMode = 'apply';
  let routingProfile: RoutingProfile | undefined;
  let forcedTier: Tier | undefined;
  let requested: string | undefined;
  let forceAuto = false;

  // A task may combine controls, for example `/plan /security audit src`.
  for (let count = 0; count < 6; count += 1) {
    const slash = /^\s*\/([a-zA-ZÀ-ÿ0-9_-]+)(?:\s+|$)/.exec(prompt);
    if (!slash) break;
    const key = normalizeCommand(slash[1]);
    if (key === 'plan') {
      executionMode = 'plan';
    } else if (key === 'dry-run' || key === 'dryrun' || key === 'preview') {
      executionMode = 'dry-run';
    } else if (key === 'send') {
      // `/send` is a local affordance only.
    } else if (PROFILE_ALIASES[key]) {
      routingProfile = PROFILE_ALIASES[key];
    } else if (key === 'auto') {
      forceAuto = true;
      requested = undefined;
      forcedTier = undefined;
    } else if (TIER_ALIAS[key]) {
      forcedTier = TIER_ALIAS[key];
    } else if (SLASH_MODEL[key]) {
      requested = SLASH_MODEL[key];
    } else {
      break;
    }
    prompt = prompt.slice(slash[0].length);
  }

  return {
    prompt,
    // `/auto` deliberately wins over a chip/MCP model selection.  Without
    // this, clicking Auto after selecting a model would still leak the old
    // explicit choice into routing.
    explicit: forceAuto ? undefined : (requested ?? explicit ?? tagModel),
    forcedTier,
    routingProfile,
    executionMode,
  };
}

export function routeConfig(profileOverride?: RoutingProfile): RouteConfig {
  const c = vscode.workspace.getConfiguration('francestudent');
  const configured = c.get<string>('routingProfile', 'eco');
  const configuredProfile = (Object.values(PROFILE_ALIASES).includes(configured as RoutingProfile)
    ? configured
    : 'eco') as RoutingProfile;
  return {
    allowed: c.get<string[]>('allowedModels', []),
    blocked: c.get<string[]>('blockedModels', []),
    tiers: c.get<Record<Tier, string[]>>('tiers', DEFAULT_TIERS),
    routingProfile: profileOverride && Object.values(PROFILE_ALIASES).includes(profileOverride)
      ? profileOverride
      : configuredProfile,
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

  const controls = parseTaskControls(raw, explicit);
  const prompt = controls.prompt;
  const routingProfile = controls.routingProfile ?? cfg.routingProfile;
  const wanted = controls.explicit;
  const norm = wanted ? normalizeCommand(wanted).replace(/^tier:/, '') : '';
  const forcedTier = controls.forcedTier ?? TIER_ALIAS[norm];
  const finalize = (model: string, reason: string): Route => ({
    model,
    prompt,
    reason,
    routingProfile,
    executionMode: controls.executionMode,
  });

  if (wanted && !forcedTier) {
    const hit = pool.find(id => has(id, [wanted]));
    if (hit) return finalize(hit, `forcé : ${wanted}`);
    throw new Error(`Modèle « ${wanted} » indisponible ou interdit par ta liste noire.`);
  }

  const heuristic: Tier = HEAVY.test(prompt) || prompt.length > 4000 ? 'heavy'
    : LIGHT.test(prompt) && prompt.length < 800 ? 'light' : 'medium';
  const profileTier: Record<RoutingProfile, Tier> = {
    eco: 'light',
    fast: 'light',
    quality: 'heavy',
    security: 'heavy',
    refactor: 'heavy',
  };
  const tier: Tier = forcedTier ?? profileTier[routingProfile] ?? heuristic;
  const orderFor = (target: Tier): Tier[] => target === 'heavy' ? ['heavy', 'medium', 'light']
    : target === 'light' ? ['light', 'medium', 'heavy'] : ['medium', 'heavy', 'light'];
  // An explicit profile is intentionally deterministic; the task heuristic
  // remains a tie-breaker only for the balanced default.
  const order = forcedTier ? orderFor(tier)
    : routingProfile === 'fast' ? ['light', 'medium', 'heavy']
      : routingProfile === 'eco' ? ['light', 'medium', 'heavy']
        : routingProfile === 'quality' || routingProfile === 'security' || routingProfile === 'refactor'
          ? ['heavy', 'medium', 'light']
          : orderFor(heuristic);
  for (const t of order) {
    const hit = pool.find(id => classifyTier(id, cfg) === t);
    if (hit) {
      const label = t === 'light' ? 'faible' : t === 'heavy' ? 'fort' : 'équilibré';
      const source = forcedTier ? `catégorie : ${label}` : `profil ${routingProfile} : ${label}${t !== tier ? ' (repli)' : ''}`;
      return finalize(hit, source);
    }
  }
  return finalize(pool[0], `profil ${routingProfile} : premier modèle autorisé`);
}
