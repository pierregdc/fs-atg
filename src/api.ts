import * as tls from 'node:tls';
import * as vscode from 'vscode';

const tlsAny = tls as unknown as {
  getCACertificates?: (type: 'default' | 'system') => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};
if (typeof tlsAny.getCACertificates === 'function' && typeof tlsAny.setDefaultCACertificates === 'function') {
  try {
    tlsAny.setDefaultCACertificates([...tlsAny.getCACertificates('default'), ...tlsAny.getCACertificates('system')]);
  } catch { /* ignore */ }
}

export const ATG = '[ATG]';
const KEY_ID = 'francestudent.apiKey';

export class FsError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
  }
  static async from(res: Response): Promise<FsError> {
    let detail = '';
    let providerBody: unknown;
    try {
      const body = await res.text();
      detail = body.slice(0, 300);
      try { providerBody = JSON.parse(body); } catch { /* a non-JSON HTTP error is not a refusal signal */ }
    } catch { /* ignore */ }
    // A provider can reject before opening SSE. Only its structured refusal
    // fields qualify; a generic 4xx or prose error must not trigger fallback.
    const refusal = modelRefusalReason(providerBody);
    if (refusal) return new FsError('MODEL_REFUSAL', refusal, res.status);
    const hints: Record<number, string> = {
      401: 'Clé API invalide ou révoquée.',
      403: 'Accès refusé (statut développeur actif requis ?).',
      429: 'Limite de débit atteinte.',
    };
    return new FsError(`HTTP_${res.status}`, `${hints[res.status] ?? 'Erreur API'} [${res.status}] ${detail}`.trim(), res.status);
  }
}

export type InputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_file'; file_id: string };

export interface ClientToolCall {
  callId?: string;
  call_id?: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ClientToolResult {
  callId: string;
  output: string;
  isError?: boolean;
}

export interface StreamHandlers {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCalls?: (calls: ClientToolCall[]) => Promise<ClientToolResult[]>;
}

export interface RunResult {
  text: string;
  usage?: unknown;
  responseId?: string;
  /** Exact provider refusal text when one was emitted, never a guessed status. */
  refusalReason?: string;
}

/** Honest fallback for an explicit provider refusal which omitted its detail. */
export const MISSING_REFUSAL_REASON = 'motif non fourni par le fournisseur';

// These predicates describe provider metadata, not arbitrary prose. A transient
// error can mention a policy without being a model refusal.
const REFUSAL_EVENT_TYPE = /(?:^|[._-])(?:output_)?refusal(?:[._-]|$)/i;
const REFUSAL_STATUS = /^(?:refusal|refused|blocked|content[_-]?filter(?:ed)?|safety|policy(?:[_-]?(?:violation|refusal))?)$/i;
const REFUSAL_CODE = /(?:^|[_-])(?:refusal|content[_-]?filter(?:ed)?|safety|policy(?:[_-]?(?:violation|refusal))?|not[_-]?allowed|blocked)(?:$|[_-])/i;
const OUTPUT_REFUSAL_START = /^(?:(?:i(?:'m|\s+am)|we(?:'re|\s+are))\s+(?:sorry[,\s]+)?(?:but[,\s]+)?\s*(?:i\s+)?(?:cannot|can't|won't)|(?:sorry[,\s]+)?(?:but[,\s]+)?\s*i\s+(?:cannot|can't|won't)|d[ée]sol[ée](?:e)?[,\s]+(?:mais[,\s]+)?(?:je\s+)?ne\s+(?:peux|suis\s+pas\s+en\s+mesure)|je\s+ne\s+peux\s+pas|je\s+ne\s+suis\s+pas\s+en\s+mesure|refus)/i;

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value instanceof Error) return value.message.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  for (const key of ['message', 'detail', 'reason']) {
    const text = textFromUnknown(candidate[key]);
    if (text) return text;
  }
  const nested = candidate.error ?? candidate.response;
  return textFromUnknown(nested);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordHasRefusalCode(record: Record<string, unknown>): boolean {
  return ['code', 'error_code', 'errorCode', 'status', 'finish_reason', 'finishReason']
    .some(key => {
      const value = nonEmptyString(record[key]);
      return !!value && (REFUSAL_STATUS.test(value) || REFUSAL_CODE.test(value));
    });
}

function refusalDetail(record: Record<string, unknown>): string | undefined {
  // Only inspect fields belonging to an already verified refusal event. This
  // keeps the provider's real wording without inferring one from a failure.
  for (const key of ['refusal_reason', 'refusal', 'output_refusal', 'delta', 'reason', 'message', 'detail']) {
    const text = textFromUnknown(record[key]);
    if (text) return text.slice(0, 600);
  }
  const error = record.error;
  if (error && typeof error === 'object') {
    const text = textFromUnknown(error);
    if (text) return text.slice(0, 600);
  }
  return undefined;
}

/**
 * Recognises only a provider-declared refusal. A deliberate missing-detail
 * value keeps that event visible instead of reporting a false empty success.
 */
function structuredRefusalReason(value: unknown, seen = new WeakSet<object>()): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  if (seen.has(event)) return undefined;
  seen.add(event);

  for (const key of ['refusal', 'refusal_reason', 'output_refusal']) {
    if (event[key] !== undefined && event[key] !== null && event[key] !== false) {
      return refusalDetail(event) ?? MISSING_REFUSAL_REASON;
    }
  }

  const type = nonEmptyString(event.type);
  if (type && REFUSAL_EVENT_TYPE.test(type)) return refusalDetail(event) ?? MISSING_REFUSAL_REASON;
  if (recordHasRefusalCode(event)) return refusalDetail(event) ?? MISSING_REFUSAL_REASON;

  for (const nested of [event.response, event.message, event.error]) {
    const refusal = structuredRefusalReason(nested, seen);
    if (refusal) return refusal;
  }
  return undefined;
}

/**
 * Uses an explicit API refusal field/event first. The text heuristic is kept
 * deliberately strict so a normal error or code discussion is never labelled
 * as a model refusal.
 */
export function modelRefusalReason(value: unknown, fromOutput = false): string | undefined {
  const structured = structuredRefusalReason(value);
  if (structured) return structured;
  // Error events must contain an explicit provider field/type above. Textual
  // fallback is limited to generated output, where a refusal is unambiguous.
  if (!fromOutput) return undefined;
  const text = textFromUnknown(value);
  if (!text || text.length > 1_500 || /```/.test(text) || !OUTPUT_REFUSAL_START.test(text)) return undefined;
  return text.slice(0, 600);
}

function mergeRefusalReason(previous: string | undefined, next: string | undefined): string | undefined {
  if (!next) return previous;
  // A later delta can contain the real explanation after an empty first frame.
  if (!previous || previous === MISSING_REFUSAL_REASON) return next;
  return previous;
}

function streamedRefusalReason(sawRefusalEvent: boolean, text: string): string | undefined {
  const actual = text.trim();
  return actual ? actual.slice(0, 600) : (sawRefusalEvent ? MISSING_REFUSAL_REASON : undefined);
}

export interface ModelMeta { id: string; name: string; provider: string; }
export type CatalogResource = 'models' | 'streams' | 'skills' | 'projects' | 'mcpServers' | 'files';

export interface CatalogEntry {
  resource: CatalogResource;
  available: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Discovery data can be large.  Bound it before it is returned through MCP so
 * that inspecting a catalog never recreates the "paste the whole project"
 * token problem this extension is meant to avoid.
 */
export function compactCatalog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (depth >= 4) return '[tronqué]';
  if (Array.isArray(value)) return value.slice(0, 60).map(item => compactCatalog(item, depth + 1));
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).slice(0, 40).map(([key, item]) => [key, compactCatalog(item, depth + 1)]));
}

export const DEFAULT_AGENTS = [
  { id: 66, name: 'gpt-5.6-terra', model: 'gpt-5.6-terra', modelProvider: 'openai' },
  { id: 65, name: 'gpt-5.6-luna', model: 'gpt-5.6-luna', modelProvider: 'openai' },
  { id: 64, name: 'gpt-5.6-sol', model: 'gpt-5.6-sol', modelProvider: 'openai' },
  { id: -1001, name: 'GPT 6 Sol', model: 'gpt-6-sol', modelProvider: 'openai' },
  { id: -1002, name: 'GPT 6 Luna', model: 'gpt-6-luna', modelProvider: 'openai' },
  { id: -1003, name: 'GPT 6.1 Sol', model: 'gpt-6.1-sol', modelProvider: 'openai' },
  { id: -1004, name: 'GPT-6 Astra', model: 'gpt-6-astra', modelProvider: 'openai' },
  { id: -1005, name: 'GPT-6.1 Terra', model: 'gpt-6.1-terra', modelProvider: 'openai' },
  { id: -2001, name: 'Claude Opus 5.5', model: 'claude-opus-5-5', modelProvider: 'anthropic' },
  { id: -2002, name: 'Claude Haiku 5.5', model: 'claude-haiku-5-5', modelProvider: 'anthropic' },
  { id: -2003, name: 'Claude Sonnet 5.5', model: 'claude-sonnet-5-5', modelProvider: 'anthropic' },
  { id: -2005, name: 'Claude Fable 5.2', model: 'claude-fable-5-2', modelProvider: 'anthropic' },
];

export class FranceStudentClient {
  private agentIds = new Map<string, number>();
  private modelMetaMap = new Map<string, ModelMeta>();
  private verifiedModelList = false;

  constructor(private readonly secrets: vscode.SecretStorage) {
    for (const a of DEFAULT_AGENTS) {
      this.agentIds.set(a.model, a.id);
      this.modelMetaMap.set(a.model, { id: a.model, name: a.name, provider: a.modelProvider });
    }
  }

  getModelMeta(id: string): ModelMeta {
    return this.modelMetaMap.get(id) ?? {
      id,
      name: id,
      provider: id.startsWith('claude') ? 'anthropic' : 'openai',
    };
  }

  /** Whether the last model list came from the provider, not local defaults. */
  modelsVerified() { return this.verifiedModelList; }

  private get base(): string {
    return 'https://api.francestudent.ai';
  }

  // La clé est stockée dans le trousseau de l'OS (SecretStorage), jamais dans settings.json.
  async setKey(k: string) { await this.secrets.store(KEY_ID, k.trim()); }
  async clearKey() { await this.secrets.delete(KEY_ID); }
  async hasKey() { return !!(await this.secrets.get(KEY_ID)); }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const key = await this.secrets.get(KEY_ID);
    if (!key) throw new FsError('NO_KEY', 'Aucune clé API. Lance « France Student : Enregistrer la clé API ».');
    return { Authorization: `Bearer ${key}`, ...extra };
  }

  async json<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      signal,
      headers: await this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await FsError.from(res);
    const txt = await res.text();
    return (txt ? JSON.parse(txt) : undefined) as T;
  }

  usage() { return this.json('GET', '/user/usage'); }
  tokenUsage() { return this.json('GET', '/user/tokenusage'); }
  activatePowerUp() { return this.json('POST', '/user/rate-limit-credits/activate'); }
  chatContext(chatId: string) { return this.json<{ usagePercent?: number }>('GET', `/chats/${chatId}/context`); }
  compactChatContext(chatId: string) { return this.json('POST', `/chats/${chatId}/context`); }

  /**
   * Read-only API discovery. These endpoints are intentionally separated from
   * mutations: showing an account's Skills, Projects or remote MCP servers
   * must never create, alter or enable one.
   */
  async catalog(resource: CatalogResource): Promise<CatalogEntry> {
    const path: Record<CatalogResource, string> = {
      models: '/models',
      streams: '/metrics/chat-streams',
      skills: '/skills',
      projects: '/projects',
      mcpServers: '/mcp/servers',
      files: '/filesv2',
    };
    try {
      return { resource, available: true, data: await this.json('GET', path[resource]) };
    } catch (e) {
      // Some France Student accounts expose the OpenAI-compatible model list
      // but not the convenience /models endpoint.
      if (resource === 'models') {
        try {
          return { resource, available: true, data: await this.json('GET', '/v1/models') };
        } catch { /* report the primary endpoint failure below */ }
      }
      const fs = e as FsError;
      return {
        resource,
        available: false,
        error: fs.status === 404 ? 'Fonction non disponible pour ce compte ou cette version de l’API.' : fs.message,
      };
    }
  }

  async catalogAll(): Promise<CatalogEntry[]> {
    return await Promise.all((['models', 'streams', 'skills', 'projects', 'mcpServers', 'files'] as CatalogResource[]).map(resource => this.catalog(resource)));
  }

  async listModels(): Promise<string[]> {
    this.verifiedModelList = false;
    try {
      const agents = await this.json<Array<{ id: number; name?: string; model?: string; modelProvider?: string; isActive?: boolean }>>('GET', '/chats/agents');
      if (Array.isArray(agents) && agents.length) {
        this.agentIds.clear();
        this.modelMetaMap.clear();
        const ids: string[] = [];
        for (const a of agents) {
          if (a?.isActive === false) continue;
          const id = String(a.model || a.name || a.id);
          if (!this.agentIds.has(id)) {
            this.agentIds.set(id, a.id);
            this.modelMetaMap.set(id, {
              id,
              name: String(a.name || id),
              provider: String(a.modelProvider || (id.startsWith('claude') ? 'anthropic' : 'openai')),
            });
            ids.push(id);
          }
        }
        if (ids.length) {
          this.verifiedModelList = true;
          return ids;
        }
      }
    } catch { /* fallback to /v1/models or defaults */ }
    try {
      const r = await this.json<{ data?: { id: string; name?: string; owned_by?: string }[] }>('GET', '/v1/models');
      const list = (r?.data ?? []).map(m => {
        this.modelMetaMap.set(m.id, { id: m.id, name: m.name || m.id, provider: m.owned_by || 'api' });
        return m.id;
      });
      if (list.length) {
        this.verifiedModelList = true;
        return list;
      }
    } catch { /* fallback to pre-registered models */ }
    return DEFAULT_AGENTS.map(a => a.model);
  }

  async uploadFile(name: string, bytes: Uint8Array, mime = 'text/plain'): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: mime }), name); // À VÉRIFIER : autres champs requis ?
    const res = await fetch(this.base + '/filesv2', { method: 'POST', headers: await this.headers(), body: form });
    if (!res.ok) throw await FsError.from(res);
    const j = (await res.json()) as { id?: string };
    if (!j.id) throw new FsError('UPLOAD', 'Réponse /filesv2 sans id.');
    return j.id;
  }

  /** Reattach once after a transport-level SSE interruption without resending the user request. */
  private async resumeChatStream(chatId: string, lastEventId: string, signal: AbortSignal): Promise<Response> {
    const res = await fetch(this.base + `/chats/${encodeURIComponent(chatId)}/stream`, {
      method: 'GET',
      signal,
      headers: await this.headers({ Accept: 'text/event-stream', 'Last-Event-ID': lastEventId }),
    });
    if (!res.ok || !res.body) throw await FsError.from(res);
    return res;
  }

  async streamResponse(
    o: {
      model: string; instructions: string; parts: InputPart[]; reasoning: boolean;
      clientTools?: string[]; chatId?: string; signal: AbortSignal;
    },
    h: StreamHandlers,
  ): Promise<RunResult> {
    const agentId = this.agentIds.get(o.model);
    if (agentId !== undefined) {
      return await this.streamChatWithFallback(agentId, o, h);
    }

    const body: Record<string, unknown> = {
      model: o.model,
      instructions: o.instructions,
      stream: true,
      input: [{ role: 'user', content: o.parts }],
    };
    if (o.reasoning) body.reasoning = { summary: 'auto' };

    const res = await fetch(this.base + '/v1/responses', {
      method: 'POST',
      signal: o.signal,
      headers: await this.headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });
    if (res.status === 401 && this.agentIds.size > 0) {
      const fallbackId = this.agentIds.values().next().value!;
      return await this.streamChatWithFallback(fallbackId, o, h);
    }
    if (!res.ok || !res.body) throw await FsError.from(res);

    let text = '';
    let usage: unknown;
    let responseId: string | undefined;
    let refusalText = '';
    let structuredRefusal: string | undefined;
    let sawRefusalEvent = false;
    for await (const ev of readSse(res.body)) {
      const d = ev as any;
      switch (d?.type) {
        case 'response.output_text.delta':
          text += d.delta ?? '';
          h.onText?.(d.delta ?? '');
          break;
        case 'response.reasoning_summary_text.delta':
          h.onReasoning?.(d.delta ?? '');
          break;
        case 'response.refusal.delta':
        case 'response.refusal_text.delta':
        case 'response.output_refusal.delta':
        case 'response.output_refusal':
          sawRefusalEvent = true;
          if (d.delta === undefined) structuredRefusal = mergeRefusalReason(structuredRefusal, modelRefusalReason(d));
          refusalText += String(d.delta ?? '');
          break;
        case 'response.completed':
          usage = d.response?.usage;
          responseId = d.response?.id;
          structuredRefusal = mergeRefusalReason(structuredRefusal, modelRefusalReason(d));
          break;
        case 'response.failed':
        case 'error':
          {
            const refusal = modelRefusalReason(d);
            if (refusal) throw new FsError('MODEL_REFUSAL', refusal);
            throw new FsError('STREAM', d.response?.error?.message ?? d.message ?? 'Échec de génération.');
          }
      }
    }
    const refusalReason = mergeRefusalReason(
      mergeRefusalReason(structuredRefusal, streamedRefusalReason(sawRefusalEvent, refusalText) ?? modelRefusalReason(refusalText, true)),
      modelRefusalReason(text, true),
    );
    return { text, usage, responseId, ...(refusalReason ? { refusalReason } : {}) };
  }

  private async streamChatWithFallback(
    agentId: number,
    o: { instructions: string; parts: InputPart[]; clientTools?: string[]; chatId?: string; signal: AbortSignal },
    h: StreamHandlers,
  ): Promise<RunResult> {
    try {
      return await this.streamChat(agentId, o, h);
    } catch (e) {
      if (o.clientTools?.length && e instanceof FsError && (e.status === 403 || e.status === 400)) {
        return await this.streamChat(agentId, { ...o, clientTools: undefined }, h);
      }
      throw e;
    }
  }

  private async streamChat(
    agentId: number,
    o: { instructions: string; parts: InputPart[]; clientTools?: string[]; chatId?: string; signal: AbortSignal },
    h: StreamHandlers,
  ): Promise<RunResult> {
    const textParts = o.parts.filter((p): p is { type: 'input_text'; text: string } => p.type === 'input_text').map(p => p.text);
    const fileIds = o.parts.filter((p): p is { type: 'input_file'; file_id: string } => p.type === 'input_file').map(p => p.file_id);
    // Do not inject legacy <<<FILE>>> or "external agent" instructions into /chats/stream (blocked since 9371eaa5);
    // /chats/stream uses native clientTools instead.
    const initialContent = textParts.join('\n\n');

    let totalText = '';
    let usage: unknown;
    let chatId = o.chatId;
    let refusalText = '';
    let structuredRefusal: string | undefined;
    let sawRefusalEvent = false;
    const onAbort = () => {
      if (chatId) void this.json('POST', `/chats/${chatId}/stream/cancel`).catch(() => undefined);
    };
    o.signal.addEventListener('abort', onAbort, { once: true });

    const consumeTurn = async (res: Response, allowResume = true): Promise<ClientToolCall[]> => {
      if (!res.ok || !res.body) throw await FsError.from(res);
      let turnText = '';
      let pendingCalls: ClientToolCall[] = [];
      let lastEventId: string | undefined;
      let completed = false;
      try {
        for await (const frame of readSseFrames(res.body)) {
        if (frame.id) lastEventId = frame.id;
        const ev = frame.event;
        const d = ev as any;
        switch (d?.type) {
          case 'stream.open':
            chatId = d.chat_id;
            break;
          case 'response.output_text.delta':
            turnText += d.delta ?? '';
            totalText += d.delta ?? '';
            h.onText?.(d.delta ?? '');
            break;
          case 'response.reasoning_summary_text.delta':
            h.onReasoning?.(d.delta ?? '');
            break;
          case 'response.refusal.delta':
          case 'response.refusal_text.delta':
          case 'response.output_refusal.delta':
          case 'response.output_refusal':
          case 'refusal.delta':
            sawRefusalEvent = true;
            if (d.delta === undefined) structuredRefusal = mergeRefusalReason(structuredRefusal, modelRefusalReason(d));
            refusalText += String(d.delta ?? '');
            break;
          case 'completed':
          case 'response.completed':
          case 'stream.completed': {
            completed = true;
            structuredRefusal = mergeRefusalReason(structuredRefusal, modelRefusalReason(d));
            if (!turnText && d.message?.content) {
              totalText += (totalText ? '\n' : '') + d.message.content;
            }
            if (Array.isArray(d.message?.toolCalls) && d.message.toolCalls.length) {
              pendingCalls = d.message.toolCalls;
            }
            const tu = d.message?.tokenUsage;
            if (tu) {
              // Do not manufacture zeroes for fields the provider omitted:
              // callers distinguish a local estimate from provider telemetry.
              const providerUsage: Record<string, number> = {};
              if (typeof tu.promptTokenCount === 'number') providerUsage.input_tokens = tu.promptTokenCount;
              if (typeof tu.candidatesTokenCount === 'number') providerUsage.output_tokens = tu.candidatesTokenCount;
              if (typeof tu.totalTokenCount === 'number') providerUsage.total_tokens = tu.totalTokenCount;
              if (typeof tu.reasoningTokenCount === 'number') providerUsage.reasoning_tokens = tu.reasoningTokenCount;
              if (Object.keys(providerUsage).length) usage = providerUsage;
            }
            break;
          }
          case 'response.failed':
          case 'error':
            {
              const refusal = modelRefusalReason(d);
              if (refusal) throw new FsError('MODEL_REFUSAL', refusal);
              throw new FsError('STREAM', d.response?.error?.message ?? d.message ?? 'Échec de génération.');
            }
          case 'cancelled':
            throw new FsError('CANCELLED', 'Génération annulée.');
        }
        }
      } catch (e) {
        // Provider-declared errors are final. Only an interrupted transport
        // with an SSE id is reattached, never re-sent as a fresh prompt.
        if (e instanceof FsError || o.signal.aborted) throw e;
        if (allowResume && chatId && lastEventId) {
          return await consumeTurn(await this.resumeChatStream(chatId, lastEventId, o.signal), false);
        }
        throw e;
      }
      if (!completed) {
        if (allowResume && chatId && lastEventId && !o.signal.aborted) {
          return await consumeTurn(await this.resumeChatStream(chatId, lastEventId, o.signal), false);
        }
        throw new FsError('STREAM_INTERRUPTED', 'Flux SSE interrompu avant la fin.');
      }
      return pendingCalls;
    };

    try {
      const headers = await this.headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
      const continuing = !!chatId;
      const firstRes = await fetch(this.base + (continuing ? `/chats/${chatId}` : '/chats/stream'), {
        method: 'POST',
        signal: o.signal,
        headers,
        body: JSON.stringify(continuing ? {
          content: initialContent,
          agentId,
          ...(fileIds.length ? { files: fileIds } : {}),
          ...(o.clientTools?.length ? { clientTools: o.clientTools } : {}),
        } : {
          agentId,
          // Les instructions sont envoyÃ©es une fois au premier tour puis restent dans le chat.
          initialContent: `${o.instructions}\n\nTÃ¢che initiale :\n${initialContent}`,
          ...(fileIds.length ? { files: fileIds } : {}),
          ...(o.clientTools?.length ? { clientTools: o.clientTools } : {}),
        }),
      });
      let pendingCalls = await consumeTurn(firstRes);

      let turns = 0;
      while (pendingCalls.length && h.onToolCalls && chatId && turns < 15) {
        turns++;
        const toolResults = await h.onToolCalls(pendingCalls.slice(0, 32));
        const nextRes = await fetch(this.base + `/chats/${chatId}`, {
          method: 'POST',
          signal: o.signal,
          headers,
          body: JSON.stringify({ toolResults }),
        });
        pendingCalls = await consumeTurn(nextRes);
      }
      if (pendingCalls.length) {
        throw new FsError('TOOL_LOOP', 'Trop d\'appels outils successifs ou gestionnaire d\'outils indisponible.');
      }
    } finally {
      o.signal.removeEventListener('abort', onAbort);
    }
    const refusalReason = mergeRefusalReason(
      mergeRefusalReason(structuredRefusal, streamedRefusalReason(sawRefusalEvent, refusalText) ?? modelRefusalReason(refusalText, true)),
      modelRefusalReason(totalText, true),
    );
    return { text: totalText, usage, responseId: chatId, ...(refusalReason ? { refusalReason } : {}) };
  }
}

interface SseFrame { id?: string; event: unknown; }

async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        const id = chunk.split('\n').find(line => line.startsWith('id:'))?.slice(3).trim();
        if (!data || data === '[DONE]') continue;
        try { yield { id, event: JSON.parse(data) }; } catch { /* malformed SSE JSON */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        try { yield JSON.parse(data); } catch { /* ligne non JSON ignorée */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
