import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ATG, CatalogResource, FranceStudentClient, FsError, InputPart, modelRefusalReason, RunResult } from './api';
import { QuotaGuard } from './quota';
import { LiveLog } from './liveLog';
import { classifyTier, ExecutionMode, pickModel, routeConfig, RoutingProfile } from './router';
import { applyFiles, ChangeJournal, FileBlock, parseFileBlocks, resolveSafe, runClientToolBatch, stripFileBlocks, workspaceRoot, workspaceSymbolIndex } from './applier';

export type JobStatus = 'queued' | 'running' | 'review' | 'done' | 'error' | 'cancelled';
export type ContextMode = 'minimal' | 'targeted' | 'smart';
const FINAL: JobStatus[] = ['review', 'done', 'error', 'cancelled'];

export interface ModelRefusal {
  model: string;
  reason: string;
  at: number;
}

export interface Job {
  id: string;
  title: string;
  task: string;
  files: string[];
  explicitModel?: string;
  parentId?: string;
  priority: number;
  source: 'panel' | 'mcp' | 'command';
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  model?: string;
  routeReason?: string;
  receivedChars: number;
  thoughts: string[];
  summary: string;
  written: string[];
  error?: string;
  usage?: unknown;
  contextMode?: ContextMode;
  inputEstimateTokens?: number;
  /** `usage` is provider-reported only when the API returned it. */
  providerUsageAvailable?: boolean;
  executionMode: ExecutionMode;
  routingProfile?: RoutingProfile;
  proposedFiles?: string[];
  reviewReady?: boolean;
  undoneAt?: number;
  undoChanged?: string[];
  undoUnavailable?: string[];
  refusals: ModelRefusal[];
}

export interface SubmitInput {
  task: string; files?: string[]; model?: string; priority?: number;
  parentJobId?: string; contextMode?: ContextMode; executionMode?: ExecutionMode;
  routingProfile?: RoutingProfile; source: Job['source'];
}

const TOOL_INSTRUCTIONS = `Voici une demande de développement pour un projet local.
- Travaille directement dans le workspace avec les outils disponibles. N'affiche jamais le contenu complet des fichiers dans ta réponse.
- N'explore pas tout le projet : commence par la liste de fichiers ciblés, puis lis uniquement les plages de lignes indispensables avec read_file ou search_files.
- Les fichiers peuvent changer entre deux demandes : vérifie les fichiers pertinents avant de les modifier.
- Utilise edit_file pour une modification localisée et write_file pour une création ou un remplacement complet.
- Termine par un résumé bref (5 lignes maximum) et la liste des fichiers touchés. Aucun chemin hors du workspace.`;

const FALLBACK_INSTRUCTIONS = `Voici une demande de développement pour un projet local.
- Commence par un résumé court (5 lignes maximum) de ce que tu as fait.
- Pour chaque fichier créé ou modifié, donne son contenu COMPLET dans ce format exact :
<<<FILE chemin/relatif/au/workspace
contenu
>>>END
- Aucun autre bloc de code. Aucun chemin hors du workspace.`;

const PLAN_INSTRUCTIONS = `Analyse une demande de développement pour un projet local.
- Ne crée, ne modifie et ne supprime aucun fichier.
- Lis seulement les portions nécessaires avec les outils de lecture disponibles.
- Réponds avec un plan concret, les fichiers concernés, les risques et les tests à lancer.
- Ne dis pas que tu es un agent et ne prétends pas avoir appliqué des changements.`;

const DRY_RUN_INSTRUCTIONS = `Prépare une modification de code pour un projet local, sans écrire aucun fichier.
- Lis seulement les portions nécessaires avec les outils de lecture disponibles.
- Pour chaque fichier qui devrait changer, propose son contenu complet uniquement dans ce format :
<<<FILE chemin/relatif/au/workspace
contenu
>>>END
- Termine par un résumé bref. Ne dis pas que tu as appliqué les changements.`;

function profileInstructions(profile: RoutingProfile): string {
  switch (profile) {
    case 'security':
      return 'Priorite : identifie les risques de securite, limite les privileges et indique les tests de non-regression utiles.';
    case 'refactor':
      return 'Priorite : preserve le comportement observable, reduis la duplication et propose une migration progressive si le risque est eleve.';
    case 'quality':
      return 'Priorite : privilegie une solution robuste, lisible et couverte par des tests pertinents.';
    case 'fast':
      return 'Priorite : effectue le plus petit changement sur qui repond a la demande.';
    default:
      return 'Priorite : evite le contexte et les changements inutiles.';
  }
}

function requestModeNote(mode: ExecutionMode): string {
  if (mode === 'plan') return 'Produis un plan seulement : aucun fichier ne doit etre modifie.';
  if (mode === 'dry-run') return 'Prepare une proposition revisable seulement : aucun fichier ne doit etre modifie.';
  return '';
}

/** Extract numeric fields only when the provider actually supplied them. */
function providerTokenFields(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const source = usage as Record<string, unknown>;
  const aliases: Array<[string, string[]]> = [
    ['inputTokens', ['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokenCount']],
    ['outputTokens', ['output_tokens', 'completion_tokens', 'outputTokens', 'candidatesTokenCount']],
    ['reasoningTokens', ['reasoning_tokens', 'reasoningTokens', 'reasoningTokenCount']],
    ['totalTokens', ['total_tokens', 'totalTokens', 'totalTokenCount']],
  ];
  const out: Record<string, number> = {};
  for (const [name, keys] of aliases) {
    const value = keys.map(key => source[key]).find(candidate => typeof candidate === 'number' && Number.isFinite(candidate));
    if (typeof value === 'number') out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

const MAX_FALLBACK_CONTEXTS = 3;
const MAX_FALLBACK_CONTEXT_CHARS = 128 * 1024;
const MAX_FALLBACK_FILE_CHARS = 48 * 1024;
const MAX_COMPACT_DIFF_CHARS = 18 * 1024;

interface FallbackContextCache {
  files: Map<string, string>;
  chars: number;
}

interface PendingFallbackContext {
  cacheKey?: string;
  files: Map<string, string | undefined>;
  chars: number;
}

/**
 * A deliberately small one-hunk unified diff. If a change is broad, callers
 * use the full selected file instead of pretending a large diff saves tokens.
 */
function compactFileDiff(rel: string, previous: string, next: string): string | undefined {
  if (previous === next) return '';
  const before = previous.split(/\r?\n/);
  const after = next.split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const oldChunk = before.slice(prefix, before.length - suffix);
  const newChunk = after.slice(prefix, after.length - suffix);
  const lines = [
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${prefix + 1},${oldChunk.length} +${prefix + 1},${newChunk.length} @@`,
    ...oldChunk.map(line => `-${line}`),
    ...newChunk.map(line => `+${line}`),
  ];
  const diff = lines.join('\n');
  return diff.length <= MAX_COMPACT_DIFF_CHARS ? diff : undefined;
}

export class Orchestrator implements vscode.Disposable {
  private readonly jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private readonly running = new Map<string, AbortController>();
  private history: Job[];
  private heartbeat?: NodeJS.Timeout;
  private modelCache?: { ids: string[]; at: number };
  private readonly changeJournal = new ChangeJournal();
  private readonly pendingReviews = new Map<string, FileBlock[]>();
  // Used only by the no-client-tool fallback and only after a direct chat
  // exists. It is deliberately bounded and never persisted to disk.
  private readonly fallbackContexts = new Map<string, FallbackContextCache>();
  private readonly pendingFallbackContexts = new Map<string, PendingFallbackContext>();
  private lastApiError?: { scope: string; message: string; at: number };
  private mcpState: { status: 'not-started' | 'ready' | 'error'; detail?: string; at: number } = {
    status: 'not-started', at: Date.now(),
  };
  private readonly emitter = new vscode.EventEmitter<Job>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly client: FranceStudentClient,
    private readonly quota: QuotaGuard,
    private readonly log: LiveLog,
    private readonly ctx: vscode.ExtensionContext,
  ) {
    this.history = ctx.globalState.get<Job[]>('fsatg.history', []);
  }

  private cfg() { return vscode.workspace.getConfiguration('francestudent'); }
  private get limit() { return this.cfg().get('mode', 'eco') === 'eco' ? 1 : this.cfg().get<number>('maxParallel', 3); }

  /** Un chat direct par workspace : le fournisseur garde le contexte, pas Antigravity. */
  private sessionKey(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.toString(); }
  private sessions() { return this.ctx.workspaceState.get<Record<string, string>>('fsatg.directChats', {}); }

  private async prepareDirectChat(): Promise<{ key?: string; chatId?: string }> {
    if (!this.cfg().get<boolean>('reuseChat', true)) return {};
    const key = this.sessionKey();
    if (!key) return {};
    const chatId = this.sessions()[key];
    if (!chatId) return { key };

    try {
      const context = await this.client.chatContext(chatId);
      const threshold = this.cfg().get<number>('contextCompactPercent', 80);
      if (typeof context.usagePercent === 'number' && context.usagePercent >= threshold) {
        await this.client.compactChatContext(chatId);
        this.log.write(`${ATG} contexte du chat compacté automatiquement (${context.usagePercent.toFixed(0)} %).`);
      }
      return { key, chatId };
    } catch (e) {
      if (e instanceof FsError && e.status === 404) {
        const next = this.sessions();
        delete next[key];
        await this.ctx.workspaceState.update('fsatg.directChats', next);
      } else {
        // Un contrôle de contexte indisponible ne doit pas bloquer une délégation valide.
        this.log.write(`${ATG} contexte du chat non vérifié : ${(e as Error).message}`);
        return { key, chatId };
      }
      return { key };
    }
  }

  private async rememberDirectChat(key: string | undefined, chatId: string | undefined) {
    if (!key || !chatId) return;
    await this.ctx.workspaceState.update('fsatg.directChats', { ...this.sessions(), [key]: chatId });
  }

  async session(action: 'status' | 'compact' | 'new' = 'status') {
    const key = this.sessionKey();
    const chatId = key ? this.sessions()[key] : undefined;
    if (action === 'new') {
      if (key && chatId) {
        const next = this.sessions();
        delete next[key];
        await this.ctx.workspaceState.update('fsatg.directChats', next);
      }
      return { chatId: undefined, usagePercent: undefined };
    }
    if (!chatId) return { chatId: undefined, usagePercent: undefined };
    if (action === 'compact') await this.client.compactChatContext(chatId);
    const context = await this.client.chatContext(chatId).catch((): { usagePercent?: number } => ({}));
    return { chatId, usagePercent: context.usagePercent };
  }

  async models(): Promise<string[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.ids;
    try {
      const ids = await this.client.listModels();
      this.modelCache = { ids, at: Date.now() };
      this.clearApiError('models');
      return ids;
    } catch (error) {
      this.noteApiError('models', error);
      throw error;
    }
  }

  /** Read-only official API catalogue, exposed through MCP for inspection. */
  async catalog(resource: CatalogResource | 'all' = 'all') {
    try {
      const result = resource === 'all' ? await this.client.catalogAll() : await this.client.catalog(resource);
      this.clearApiError('catalog');
      return result;
    } catch (error) {
      this.noteApiError('catalog', error);
      throw error;
    }
  }

  setMcpStatus(status: 'not-started' | 'ready' | 'error', detail?: string) {
    this.mcpState = { status, detail, at: Date.now() };
    for (const job of this.active()) this.emitter.fire(job);
  }

  async diagnostics(sessionOverride?: { chatId?: string; usagePercent?: number }) {
    const session = sessionOverride ?? await this.session('status').catch(() => ({ chatId: undefined, usagePercent: undefined }));
    const quota = this.quota.last ?? null;
    const lastObservedAt = this.lastApiError?.at ?? quota?.at ?? null;
    return {
      credential: { configured: await this.client.hasKey(), storage: 'VS Code SecretStorage' },
      api: {
        lastValidatedAt: quota?.at ?? null,
        lastError: this.lastApiError ?? null,
      },
      models: {
        verified: this.client.modelsVerified(),
        cachedCount: this.modelCache?.ids.length ?? null,
        cachedAt: this.modelCache?.at ?? null,
      },
      quota,
      mcp: this.mcpState,
      session: { active: Boolean(session.chatId), usagePercent: session.usagePercent ?? null },
      workspace: { open: Boolean(vscode.workspace.workspaceFolders?.length) },
      // This reports the last observed result; it does not pretend to be a
      // continuously monitored network probe.
      network: this.lastApiError
        ? { state: 'error', observedAt: lastObservedAt, detail: this.lastApiError.message }
        : quota
          ? { state: 'last-check-ok', observedAt: lastObservedAt, detail: 'Derniere verification de quota reussie.' }
          : { state: 'unknown', observedAt: null, detail: 'Aucune verification reseau recente.' },
    };
  }

  async refreshDiagnostics() {
    try {
      await this.quota.snapshot(true);
      await this.models();
      this.clearApiError('diagnostics');
    } catch (error) {
      this.noteApiError('diagnostics', error);
    }
    return this.diagnostics();
  }

  private noteApiError(scope: string, error: unknown) {
    this.lastApiError = { scope, message: error instanceof Error ? error.message : String(error), at: Date.now() };
  }

  private clearApiError(scope: string) {
    if (this.lastApiError?.scope === scope || scope === 'diagnostics') this.lastApiError = undefined;
  }

  private persistHistory() {
    void this.ctx.globalState.update('fsatg.history', this.history);
  }

  private fallbackContext(key: string): FallbackContextCache {
    const existing = this.fallbackContexts.get(key);
    if (existing) {
      // Map insertion order doubles as a tiny LRU for complete chat caches.
      this.fallbackContexts.delete(key);
      this.fallbackContexts.set(key, existing);
      return existing;
    }
    while (this.fallbackContexts.size >= MAX_FALLBACK_CONTEXTS) {
      const oldest = this.fallbackContexts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.fallbackContexts.delete(oldest);
    }
    const created: FallbackContextCache = { files: new Map(), chars: 0 };
    this.fallbackContexts.set(key, created);
    return created;
  }

  private stageFallbackFile(jobId: string, cacheKey: string | undefined, rel: string, content: string | undefined) {
    if (!cacheKey) return;
    const cachePath = rel.replace(/\\/g, '/');
    const pending = this.pendingFallbackContexts.get(jobId) ?? { cacheKey, files: new Map(), chars: 0 };
    const previous = pending.files.get(cachePath);
    if (typeof previous === 'string') pending.chars -= previous.length;
    if (typeof content === 'string') {
      // Keep pending memory bounded too. A dropped entry is sent normally but
      // simply has no diff baseline on the following request.
      if (content.length > MAX_FALLBACK_FILE_CHARS || pending.chars + content.length > MAX_FALLBACK_CONTEXT_CHARS) {
        pending.files.set(cachePath, undefined);
      } else {
        pending.files.set(cachePath, content);
        pending.chars += content.length;
      }
    } else {
      pending.files.set(cachePath, undefined);
    }
    this.pendingFallbackContexts.set(jobId, pending);
  }

  private rememberFallbackFile(cache: FallbackContextCache, rel: string, content: string | undefined) {
    const cachePath = rel.replace(/\\/g, '/');
    const previous = cache.files.get(cachePath);
    if (previous !== undefined) cache.chars -= previous.length;
    if (content === undefined || content.length > MAX_FALLBACK_FILE_CHARS) {
      cache.files.delete(cachePath);
      return;
    }
    while (cache.chars + content.length > MAX_FALLBACK_CONTEXT_CHARS && cache.files.size) {
      const oldest = cache.files.keys().next().value as string | undefined;
      if (!oldest) break;
      const value = cache.files.get(oldest);
      cache.files.delete(oldest);
      cache.chars -= value?.length ?? 0;
    }
    if (cache.chars + content.length > MAX_FALLBACK_CONTEXT_CHARS) return;
    cache.files.set(cachePath, content);
    cache.chars += content.length;
  }

  /** Commit only after the provider request succeeded, never optimistically. */
  private async commitFallbackContext(jobId: string, chatId: string | undefined, providerBlocks: FileBlock[] = []) {
    const pending = this.pendingFallbackContexts.get(jobId);
    this.pendingFallbackContexts.delete(jobId);
    if (!pending || !chatId) return;
    const cache = this.fallbackContext(chatId);
    const providerFiles = new Map(providerBlocks.map(block => [block.path.replace(/\\/g, '/'), block.content]));
    for (const [rel, staged] of pending.files) {
      // A persistent chat knows its own response even if the user declines
      // the local diff. Base the next diff on that provider-visible version,
      // not on an assumption that local application succeeded.
      const content = providerFiles.has(rel) ? providerFiles.get(rel) : staged;
      this.rememberFallbackFile(cache, rel, content);
    }
  }

  private discardFallbackContext(jobId: string) {
    this.pendingFallbackContexts.delete(jobId);
  }

  active(): Job[] { return [...this.jobs.values()].filter(j => !FINAL.includes(j.status)); }
  historyList(): Job[] { return this.history; }
  clearHistory() {
    this.history = [];
    this.pendingReviews.clear();
    this.persistHistory();
    for (const j of this.active()) this.emitter.fire(j);
  }
  find(id: string): Job | undefined { return this.jobs.get(id) ?? this.history.find(j => j.id === id); }

  submit(i: SubmitInput): Job {
    const firstLine = i.task.split('\n')[0].replace(/^\s*\[[^\]]+\]\s*/, '');
    const job: Job = {
      id: randomUUID().slice(0, 8),
      title: `${ATG} ${firstLine.slice(0, 70)}${firstLine.length > 70 ? '…' : ''}`,
      task: i.task,
      files: i.files ?? [],
      explicitModel: i.model,
      parentId: i.parentJobId,
      contextMode: i.contextMode,
      executionMode: i.executionMode ?? 'apply',
      routingProfile: i.routingProfile,
      priority: i.priority ?? 5,
      source: i.source,
      status: 'queued',
      createdAt: Date.now(),
      receivedChars: 0,
      thoughts: [],
      summary: '',
      written: [],
      refusals: [],
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    this.log.write(`${job.title} — en file (priorité ${job.priority}, source ${job.source})`);
    this.emitter.fire(job);
    this.pump();
    return job;
  }

  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.status === 'queued') {
      this.queue = this.queue.filter(j => j.id !== id);
      this.finish(job, 'cancelled');
    } else {
      this.running.get(id)?.abort();
    }
  }

  /** Applies a dry-run proposal only after the user explicitly accepts it. */
  async applyReview(id: string): Promise<{ written: string[]; message?: string }> {
    const job = this.find(id);
    const blocks = this.pendingReviews.get(id);
    if (!job || job.status !== 'review' || !blocks?.length) {
      throw new Error('Aucune proposition révisable disponible pour ce job.');
    }
    const written = await applyFiles(blocks, job.id, job.title, this.changeJournal);
    // The diff confirmation may be declined. Keep the proposal available so
    // the user can inspect or apply it later.
    if (!written.length) return { written, message: 'Application annulee : la proposition reste disponible.' };
    job.written = [...new Set([...job.written, ...written])];
    job.status = 'done';
    job.endedAt = Date.now();
    job.reviewReady = false;
    this.pendingReviews.delete(id);
    this.persistHistory();
    this.emitter.fire(job);
    return { written, message: written.length ? 'Proposition appliquée.' : 'Aucun fichier appliqué.' };
  }

  /** Restores only bounded in-memory snapshots created during this IDE session. */
  async undo(id: string) {
    const job = this.find(id);
    const result = await this.changeJournal.restore(id);
    if (job) {
      if (result.restored.length) {
        job.undoneAt = Date.now();
        job.written = job.written.filter(path => !result.restored.includes(path));
      }
      job.undoChanged = result.changed;
      job.undoUnavailable = result.unavailable;
      this.persistHistory();
      this.emitter.fire(job);
    }
    return result;
  }

  /** Long-polling pour MCP : rend la main dès que le job se termine, sinon après `ms`. */
  waitFor(id: string, ms: number): Promise<Job | undefined> {
    const job = this.find(id);
    if (!job || FINAL.includes(job.status) || ms <= 0) return Promise.resolve(job);
    return new Promise(resolve => {
      const sub = this.onDidChange(j => {
        if (j.id === id && FINAL.includes(j.status)) { clearTimeout(t); sub.dispose(); resolve(j); }
      });
      const t = setTimeout(() => { sub.dispose(); resolve(this.find(id)); }, ms);
    });
  }

  pump() {
    while (this.running.size < this.limit && this.queue.length) {
      const job = this.queue.shift()!;
      void this.run(job);
    }
    this.syncHeartbeat();
  }

  /** One conservative alternate model from the exact same configured tier. */
  private sameTierFallback(primary: string, available: string[]) {
    const cfg = routeConfig();
    const tier = classifyTier(primary, cfg);
    const allowed = cfg.allowed.map(value => value.toLowerCase());
    const blocked = cfg.blocked.map(value => value.toLowerCase());
    const permitted = (id: string) => {
      const lower = id.toLowerCase();
      return (!allowed.length || allowed.some(value => lower.includes(value))) && !blocked.some(value => lower.includes(value));
    };
    return available.find(id => id !== primary && permitted(id) && classifyTier(id, cfg) === tier);
  }

  private noteRefusal(job: Job, model: string, reason: string, willRetry: boolean) {
    const entry: ModelRefusal = { model, reason, at: Date.now() };
    job.refusals.push(entry);
    job.summary = reason;
    job.thoughts.push(`Refus de ${model} : ${reason}${willRetry ? ' — repli même gamme.' : ''}`);
    job.thoughts = job.thoughts.slice(-30);
    this.log.write(`${job.title} — refus ${model} : ${reason}${willRetry ? ' ; repli même gamme.' : ''}`);
    this.emitter.fire(job);
  }

  private async run(job: Job) {
    const ac = new AbortController();
    this.running.set(job.id, ac);
    job.status = 'running';
    job.startedAt = Date.now();
    this.emitter.fire(job);

    let thoughtBuf = '';
    const flushThought = () => {
      const t = thoughtBuf.trim();
      if (t) { job.thoughts.push(t); job.thoughts = job.thoughts.slice(-30); this.log.write(`${ATG} #${job.id} 💭 ${t}`); }
      thoughtBuf = '';
    };

    try {
      await this.quota.ensureCanDelegate();
      const availableModels = await this.models();
      // A profile supplied by the UI/MCP is the routing default. A leading
      // slash profile in the task still wins inside pickModel.
      const route = pickModel(job.task, availableModels, routeConfig(job.routingProfile), job.explicitModel);
      job.model = route.model;
      job.routeReason = route.reason;
      job.executionMode = route.executionMode !== 'apply' ? route.executionMode : job.executionMode;
      job.routingProfile = route.routingProfile;
      this.log.write(`${job.title} — démarré sur ${route.model} (${route.reason})`);
      this.emitter.fire(job);

      const toolWritten = new Set<string>();
      const hasWs = !!vscode.workspace.workspaceFolders?.length;
      const useTools = hasWs && this.cfg().get<boolean>('useClientTools', true);
      const allowWrites = job.executionMode === 'apply';
      const baseInstructions = job.executionMode === 'plan' ? PLAN_INSTRUCTIONS
        : job.executionMode === 'dry-run' ? DRY_RUN_INSTRUCTIONS
          : (useTools ? TOOL_INSTRUCTIONS : FALLBACK_INSTRUCTIONS);
      const instructions = `${baseInstructions}\n${profileInstructions(job.routingProfile ?? 'eco')}`;
      // Review-only work deliberately starts outside the persistent chat: its
      // safety instruction must not be diluted by a previous implementation
      // turn. It also never writes through the local tool bridge.
      const direct = job.executionMode === 'apply' ? await this.prepareDirectChat() : {};
      const parts = await this.buildParts(job, route.prompt, useTools, direct.chatId, direct.key);
      job.inputEstimateTokens = parts.reduce((total, part) => total + (part.type === 'input_text' ? Math.ceil(part.text.length / 4) : 8), 0);
      let lastEmit = 0;
      const call = (model: string, chatId: string | undefined, markWrite: () => void): Promise<RunResult> => {
        let attemptText = '';
        return this.client.streamResponse({
        model,
        instructions,
        parts,
        reasoning: this.cfg().get<boolean>('showReasoning', true),
        clientTools: useTools ? (allowWrites
          ? ['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file']
          : ['list_directory', 'read_file', 'search_files']) : undefined,
        chatId,
        signal: ac.signal,
      }, {
        onText: d => {
          job.receivedChars += d.length;
          attemptText += d;
          job.summary = attemptText.slice(-300);
          if (Date.now() - lastEmit > 500) { lastEmit = Date.now(); this.emitter.fire(job); }
        },
        onReasoning: d => {
          thoughtBuf += d;
          if (thoughtBuf.includes('\n') || thoughtBuf.length > 240) { flushThought(); this.emitter.fire(job); }
        },
        onToolCalls: async calls => {
          this.log.write(`${job.title} — outils client : ${calls.map(c => c.name).join(', ')}`);
          job.thoughts.push(`Outils : ${calls.map(c => c.name).join(', ')}`);
          this.emitter.fire(job);
          const before = toolWritten.size;
          const results = await runClientToolBatch(calls, job.title, toolWritten, {
            journal: this.changeJournal,
            jobId: job.id,
            allowWrites,
          });
          if (toolWritten.size > before) {
            markWrite();
            // Keep the live/error view truthful if a later provider event
            // refuses the request after an approved client-side write.
            job.written = [...toolWritten];
            this.emitter.fire(job);
          }
          return results;
        },
      });
      };
      const callWithPowerUp = async (model: string, chatId: string | undefined, markWrite: () => void): Promise<RunResult> => {
        try {
          return await call(model, chatId, markWrite);
        } catch (e) {
          // This is intentionally separate from refusal fallback: a 429 may
          // retry the same model only after the user's configured power-up.
          if (e instanceof FsError && e.status === 429 && await this.quota.tryPowerUp(job.title)) {
            return await call(model, chatId, markWrite);
          }
          throw e;
        }
      };

      const alternate = this.sameTierFallback(route.model, availableModels);
      const attemptModels = [route.model, ...(alternate ? [alternate] : [])];
      let result: RunResult | undefined;

      for (let attempt = 0; attempt < attemptModels.length; attempt++) {
        const model = attemptModels[attempt];
        const isFallback = attempt > 0;
        if (isFallback) {
          job.model = model;
          job.routeReason = `${route.reason} · repli même gamme après refus`;
          job.summary = '';
          this.log.write(`${job.title} — nouvel essai sur ${model}, même gamme.`);
          this.emitter.fire(job);
        }

        let wroteInAttempt = false;
        let attemptResult: RunResult;
        try {
          attemptResult = await callWithPowerUp(model, isFallback ? undefined : direct.chatId, () => { wroteInAttempt = true; });
        } catch (e) {
          const reason = e instanceof FsError && e.code === 'MODEL_REFUSAL' ? e.message : undefined;
          if (!reason) throw e;
          const willRetry = !wroteInAttempt && attempt + 1 < attemptModels.length;
          this.noteRefusal(job, model, reason, willRetry);
          if (wroteInAttempt) {
            throw new FsError('MODEL_REFUSAL', `Refus de ${model} après une écriture locale : ${reason}`);
          }
          continue;
        }

        const reason = attemptResult.refusalReason ?? modelRefusalReason(attemptResult.text, true);
        if (reason) {
          const willRetry = !wroteInAttempt && attempt + 1 < attemptModels.length;
          this.noteRefusal(job, model, reason, willRetry);
          if (wroteInAttempt) {
            throw new FsError('MODEL_REFUSAL', `Refus de ${model} après une écriture locale : ${reason}`);
          }
          continue;
        }
        result = attemptResult;
        break;
      }

      if (!result) {
        const last = job.refusals.at(-1);
        if (last) throw new FsError('MODEL_REFUSAL', `Aucun autre modèle disponible dans la même gamme. Dernier motif (${last.model}) : ${last.reason}`);
        throw new FsError('MODEL_REFUSAL', 'Le fournisseur a refusé la demande sans fournir de motif exploitable.');
      }
      flushThought();
      this.clearApiError('delegation');

      if (job.executionMode === 'apply') await this.rememberDirectChat(direct.key, result.responseId);

      job.summary = stripFileBlocks(result.text).slice(0, 2000);
      job.usage = result.usage;
      job.providerUsageAvailable = result.usage !== undefined && result.usage !== null;
      const blocks = parseFileBlocks(result.text);
      if (job.executionMode === 'dry-run') {
        job.proposedFiles = blocks.map(block => block.path);
        job.reviewReady = blocks.length > 0;
        if (blocks.length) this.pendingReviews.set(job.id, blocks);
        // No machine-readable block means there is nothing that can be
        // reviewed/applied safely, so expose a completed simulation instead.
        if (!blocks.length) job.summary = `${job.summary}\n\nAucune proposition de fichier applicable.`.trim();
        this.log.write(`${job.title} — simulation terminée, ${blocks.length} fichier(s) proposé(s), aucune écriture.`);
        this.finish(job, blocks.length ? 'review' : 'done');
        return;
      }
      if (job.executionMode === 'plan') {
        this.log.write(`${job.title} — plan terminé, aucune écriture.`);
        this.finish(job, 'done');
        return;
      }
      const blockWritten = await applyFiles(blocks, job.id, job.title, this.changeJournal);
      job.written = [...new Set([...toolWritten, ...blockWritten])];
      await this.commitFallbackContext(job.id, result.responseId ?? direct.chatId, blocks);
      this.log.write(`${job.title} — terminé, ${job.written.length} fichier(s) écrit(s)`);
      this.quota.invalidate();
      void this.quota.snapshot(true).catch(() => undefined);
      this.finish(job, 'done');
    } catch (e) {
      this.discardFallbackContext(job.id);
      flushThought();
      if (ac.signal.aborted) {
        this.finish(job, 'cancelled');
      } else {
        job.error = (e as Error).message;
        this.noteApiError('delegation', e);
        this.log.write(`${job.title} — ERREUR : ${job.error}`);
        this.finish(job, 'error');
      }
    }
  }

  /**
   * The default is intentionally minimal.  Existing persistent chats already
   * contain their own history; resending a parent summary would cost tokens
   * without adding information.
   */
  private async buildParts(
    job: Job,
    prompt: string,
    useClientTools: boolean,
    persistentChatId?: string,
    sessionKey?: string,
  ): Promise<InputPart[]> {
    const parent = job.parentId ? this.find(job.parentId) : undefined;
    let text = prompt;
    if (parent && !persistentChatId) {
      text = `Contexte (tâche précédente « ${parent.title.replace(/^\[ATG\]\s*/, '')} ») :\n${parent.summary}\n` +
        `Fichiers touchés : ${parent.written.join(', ') || 'aucun'}\n\nNouvelle demande : ${prompt}`;
    }
    const configured = this.cfg().get<ContextMode>('contextMode', 'minimal');
    const mode: ContextMode = job.contextMode ?? (['minimal', 'targeted', 'smart'].includes(configured) ? configured : 'minimal');
    job.contextMode = mode;

    const modeNote = requestModeNote(job.executionMode);
    if (modeNote) text = `${modeNote}\n\n${text}`;

    // Smart mode sends a compact, locally derived index rather than a dump of
    // the workspace. It contains only paths, exported symbol names and local
    // import paths; a read failure simply leaves the index out.
    if (mode === 'smart') {
      const entries = await workspaceSymbolIndex(48, 60).catch(error => {
        this.log.write(`${job.title} - index local indisponible : ${(error as Error).message}`);
        return [] as string[];
      });
      if (entries.length) {
        const index = entries.join('\n').slice(0, 6_000);
        text += `\n\nIndex local de symboles/imports (non exhaustif, sans contenu de fichier) :\n${index}`;
      }
    }

    // In minimal mode nothing but the request is sent. Targeted sends only
    // user-selected paths, smart adds a capped path-only map (never contents).
    if (useClientTools) {
      if (mode !== 'minimal' && job.files.length) {
        text += `\n\nFichiers ciblés : ${job.files.slice(0, 30).join(', ')}. Lis-les par plages avec read_file seulement si nécessaire.`;
      }
      if (mode === 'smart' && !text.includes('Index local de symboles/imports')) {
        const uris = await vscode.workspace.findFiles('**/*', '{**/.git/**,**/node_modules/**,**/dist/**,**/.env*}', 120);
        const paths = uris.map(uri => vscode.workspace.asRelativePath(uri, false)).filter(Boolean);
        if (paths.length) text += `\n\nPlan local (chemins seulement, non exhaustif) :\n${paths.join('\n')}`;
      }
      return [{ type: 'input_text', text }];
    }

    if (!job.files.length) return [{ type: 'input_text', text }];

    // When native client tools are disabled, a direct provider chat may have
    // already received selected file contents. Keep a small in-memory basis
    // so later turns can send a compact diff (never on a fresh chat).
    if (job.executionMode === 'apply' && sessionKey) {
      return this.buildFallbackFileParts(job, text, persistentChatId, sessionKey);
    }

    const parts: InputPart[] = [{ type: 'input_text', text }];

    const root = workspaceRoot();
    const inlineMax = this.cfg().get<number>('inlineFileKB', 48) * 1024;
    let remaining = 48 * 1024;
    for (const rel of job.files.slice(0, 12)) {
      const bytes = await vscode.workspace.fs.readFile(resolveSafe(root, rel));
      if (bytes.byteLength <= inlineMax && remaining > 0) {
        const content = Buffer.from(bytes).toString('utf8').slice(0, remaining);
        remaining -= content.length;
        parts.push({ type: 'input_text', text: `<<<FILE ${rel}\n${content}${content.length < bytes.byteLength ? '\n[tronqué]' : ''}\n>>>END` });
      } else {
        const id = await this.client.uploadFile(path.basename(rel), bytes);
        parts.push({ type: 'input_text', text: `Fichier joint : ${rel}` }, { type: 'input_file', file_id: id });
        this.log.write(`${job.title} — ${rel} envoyé via /filesv2 (${Math.round(bytes.byteLength / 1024)} Ko)`);
      }
    }
    return parts;
  }

  /**
   * Fallback-only file transport for a reusable provider chat. A diff is used
   * only when a known persistent chat supplied the exact previous text; a
   * first/fresh chat always receives the full selected file instead.
   */
  private async buildFallbackFileParts(
    job: Job,
    text: string,
    persistentChatId: string | undefined,
    sessionKey: string,
  ): Promise<InputPart[]> {
    const intro: InputPart & { type: 'input_text' } = { type: 'input_text', text };
    const parts: InputPart[] = [intro];
    const root = workspaceRoot();
    const inlineMax = this.cfg().get<number>('inlineFileKB', 48) * 1024;
    const known = persistentChatId ? this.fallbackContexts.get(persistentChatId)?.files : undefined;
    const cacheKey = persistentChatId ?? `pending:${sessionKey}`;
    let remaining = 48 * 1024;
    const unchanged: string[] = [];

    for (const rel of job.files.slice(0, 12)) {
      const bytes = await vscode.workspace.fs.readFile(resolveSafe(root, rel));
      if (bytes.byteLength <= inlineMax && remaining > 0) {
        const fullContent = Buffer.from(bytes).toString('utf8');
        const previous = known?.get(rel.replace(/\\/g, '/'));
        if (previous === fullContent) {
          unchanged.push(rel);
          this.stageFallbackFile(job.id, cacheKey, rel, fullContent);
          continue;
        }

        // A diff cannot be trusted for a fresh/nonpersistent conversation.
        const diff = persistentChatId && previous !== undefined
          ? compactFileDiff(rel, previous, fullContent)
          : undefined;
        const diffPart = diff === undefined || diff === '' ? undefined
          : `Diff unifie local pour un fichier deja transmis :\n${diff}`;
        if (diffPart && diffPart.length < fullContent.length * 0.75 && diffPart.length <= remaining) {
          parts.push({ type: 'input_text', text: diffPart });
          remaining -= diffPart.length;
          this.stageFallbackFile(job.id, cacheKey, rel, fullContent);
          continue;
        }

        const content = fullContent.slice(0, remaining);
        remaining -= content.length;
        const complete = content.length === fullContent.length;
        parts.push({ type: 'input_text', text: `<<<FILE ${rel}\n${content}${complete ? '' : '\n[truncated]'}\n>>>END` });
        this.stageFallbackFile(job.id, cacheKey, rel, complete ? fullContent : undefined);
      } else {
        const id = await this.client.uploadFile(path.basename(rel), bytes);
        parts.push({ type: 'input_text', text: `Fichier joint : ${rel}` }, { type: 'input_file', file_id: id });
        this.stageFallbackFile(job.id, cacheKey, rel, undefined);
        this.log.write(`${job.title} - ${rel} envoye via /filesv2 (${Math.round(bytes.byteLength / 1024)} Ko)`);
      }
    }
    if (unchanged.length) {
      intro.text += `\n\nFichiers deja transmis dans cette conversation et inchanges : ${unchanged.join(', ')}.`;
    }
    return parts;
  }

  private finish(job: Job, status: JobStatus) {
    job.status = status;
    job.endedAt = Date.now();
    this.running.delete(job.id);
    this.jobs.delete(job.id);
    this.history = [{ ...job, thoughts: job.thoughts.slice(-5) }, ...this.history].slice(0, 50);
    this.persistHistory();
    this.emitter.fire(job);
    this.pump();
  }

  // ─── Anti-silence : un signe de vie toutes les N minutes tant que ça tourne ───
  private syncHeartbeat() {
    const busy = this.running.size > 0 || this.queue.length > 0;
    if (busy && !this.heartbeat) {
      const min = this.cfg().get<number>('heartbeatMinutes', 5);
      this.heartbeat = setInterval(() => this.beat(), min * 60_000);
    } else if (!busy && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private beat() {
    for (const j of this.active()) {
      const mins = j.startedAt ? Math.round((Date.now() - j.startedAt) / 60_000) : 0;
      this.log.write(`${j.title} — ⏳ ${j.status}, ${mins} min, ${j.receivedChars} caractères reçus`);
    }
    vscode.window.setStatusBarMessage(`${ATG} ${this.running.size} agent(s) actif(s), ${this.queue.length} en file`, 15_000);
  }

  publicView(j: Job) {
    const end = j.endedAt ?? Date.now();
    return {
      jobId: j.id, title: j.title, status: j.status, model: j.model, route: j.routeReason,
      elapsedSec: j.startedAt ? Math.round((end - j.startedAt) / 1000) : 0,
      receivedChars: j.receivedChars, summary: j.summary, filesWritten: j.written,
      lastThoughts: j.thoughts.slice(-3), error: j.error, startedAt: j.startedAt,
      endedAt: j.endedAt, usage: j.usage, contextMode: j.contextMode,
      executionMode: j.executionMode, routingProfile: j.routingProfile,
      proposedFiles: j.proposedFiles ?? [], reviewReady: j.reviewReady === true,
      undo: this.changeJournal.status(j.id), undoneAt: j.undoneAt,
      undoChanged: j.undoChanged ?? [], undoUnavailable: j.undoUnavailable ?? [],
      // `inputEstimateTokens` is deliberately not mixed with server numbers:
      // it is a local character-based estimate of the user parts only.
      tokenAccounting: {
        localInputEstimate: j.inputEstimateTokens ?? null,
        localMethod: 'estimation locale : caracteres envoyes / 4; n inclut pas les outils ni le contexte interne fournisseur',
        providerReported: j.providerUsageAvailable === true,
        providerTokens: providerTokenFields(j.usage) ?? null,
      },
      inputEstimateTokens: j.inputEstimateTokens,
      providerUsageAvailable: j.providerUsageAvailable === true,
      refusals: j.refusals ?? [],
    };
  }

  dispose() {
    for (const ac of this.running.values()) ac.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
}
