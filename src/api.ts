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
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
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

export interface RunResult { text: string; usage?: unknown; responseId?: string; }

export interface ModelMeta { id: string; name: string; provider: string; }

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

  private get base(): string {
    return vscode.workspace.getConfiguration('francestudent')
      .get<string>('baseUrl', 'https://api.francestudent.org').replace(/\/+$/, '');
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

  async listModels(): Promise<string[]> {
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
        if (ids.length) return ids;
      }
    } catch { /* fallback to /v1/models or defaults */ }
    try {
      const r = await this.json<{ data?: { id: string; name?: string; owned_by?: string }[] }>('GET', '/v1/models');
      const list = (r?.data ?? []).map(m => {
        this.modelMetaMap.set(m.id, { id: m.id, name: m.name || m.id, provider: m.owned_by || 'api' });
        return m.id;
      });
      if (list.length) return list;
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

  async streamResponse(
    o: { model: string; instructions: string; parts: InputPart[]; reasoning: boolean; clientTools?: string[]; signal: AbortSignal },
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
        case 'response.completed':
          usage = d.response?.usage;
          responseId = d.response?.id;
          break;
        case 'response.failed':
        case 'error':
          throw new FsError('STREAM', d.response?.error?.message ?? d.message ?? 'Échec de génération.');
      }
    }
    return { text, usage, responseId };
  }

  private async streamChatWithFallback(
    agentId: number,
    o: { instructions: string; parts: InputPart[]; clientTools?: string[]; signal: AbortSignal },
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
    o: { instructions: string; parts: InputPart[]; clientTools?: string[]; signal: AbortSignal },
    h: StreamHandlers,
  ): Promise<RunResult> {
    const textParts = o.parts.filter((p): p is { type: 'input_text'; text: string } => p.type === 'input_text').map(p => p.text);
    const fileIds = o.parts.filter((p): p is { type: 'input_file'; file_id: string } => p.type === 'input_file').map(p => p.file_id);
    // Do not inject legacy <<<FILE>>> or "external agent" instructions into /chats/stream (blocked since 9371eaa5);
    // /chats/stream uses native clientTools instead.
    const initialContent = textParts.join('\n\n');

    let totalText = '';
    let usage: unknown;
    let chatId: string | undefined;
    const onAbort = () => {
      if (chatId) void this.json('POST', `/chats/${chatId}/stream/cancel`).catch(() => undefined);
    };
    o.signal.addEventListener('abort', onAbort, { once: true });

    const consumeTurn = async (res: Response): Promise<ClientToolCall[]> => {
      if (!res.ok || !res.body) throw await FsError.from(res);
      let turnText = '';
      let pendingCalls: ClientToolCall[] = [];
      for await (const ev of readSse(res.body)) {
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
          case 'completed': {
            if (!turnText && d.message?.content) {
              totalText += (totalText ? '\n' : '') + d.message.content;
            }
            if (Array.isArray(d.message?.toolCalls) && d.message.toolCalls.length) {
              pendingCalls = d.message.toolCalls;
            }
            const tu = d.message?.tokenUsage;
            if (tu) {
              usage = {
                input_tokens: tu.promptTokenCount ?? 0,
                output_tokens: tu.candidatesTokenCount ?? 0,
                total_tokens: tu.totalTokenCount ?? 0,
                reasoning_tokens: tu.reasoningTokenCount ?? 0,
              };
            }
            break;
          }
          case 'response.failed':
          case 'error':
            throw new FsError('STREAM', d.response?.error?.message ?? d.message ?? 'Échec de génération.');
          case 'cancelled':
            throw new FsError('CANCELLED', 'Génération annulée.');
        }
      }
      return pendingCalls;
    };

    try {
      const headers = await this.headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
      const firstRes = await fetch(this.base + '/chats/stream', {
        method: 'POST',
        signal: o.signal,
        headers,
        body: JSON.stringify({
          agentId,
          initialContent,
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
    } finally {
      o.signal.removeEventListener('abort', onAbort);
    }
    return { text: totalText, usage, responseId: chatId };
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
