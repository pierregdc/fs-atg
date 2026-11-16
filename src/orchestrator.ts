import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ATG, FranceStudentClient, FsError, InputPart } from './api';
import { QuotaGuard } from './quota';
import { LiveLog } from './liveLog';
import { pickModel, routeConfig } from './router';
import { applyFiles, parseFileBlocks, resolveSafe, runClientToolBatch, stripFileBlocks, workspaceRoot } from './applier';

export type JobStatus = 'queued' | 'running' | 'review' | 'done' | 'error' | 'cancelled';
const FINAL: JobStatus[] = ['done', 'error', 'cancelled'];

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
}

export interface SubmitInput {
  task: string; files?: string[]; model?: string; priority?: number;
  parentJobId?: string; source: Job['source'];
}

const INSTRUCTIONS = `Tu es un agent de code délégué par l'IDE Antigravity ${ATG}.
- Commence par un résumé court (5 lignes max) de ce que tu as fait.
- Pour chaque fichier créé ou modifié, donne son contenu COMPLET dans ce format exact :
<<<FILE chemin/relatif/au/workspace
contenu
>>>END
- Aucun autre bloc de code. Aucun chemin hors du workspace.`;

export class Orchestrator implements vscode.Disposable {
  private readonly jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private readonly running = new Map<string, AbortController>();
  private history: Job[];
  private heartbeat?: NodeJS.Timeout;
  private modelCache?: { ids: string[]; at: number };
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

  async models(): Promise<string[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.ids;
    const ids = await this.client.listModels();
    this.modelCache = { ids, at: Date.now() };
    return ids;
  }

  active(): Job[] { return [...this.jobs.values()].filter(j => !FINAL.includes(j.status)); }
  historyList(): Job[] { return this.history; }
  clearHistory() {
    this.history = [];
    void this.ctx.globalState.update('fsatg.history', this.history);
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
      priority: i.priority ?? 5,
      source: i.source,
      status: 'queued',
      createdAt: Date.now(),
      receivedChars: 0,
      thoughts: [],
      summary: '',
      written: [],
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
      const route = pickModel(job.task, await this.models(), routeConfig(), job.explicitModel);
      job.model = route.model;
      job.routeReason = route.reason;
      this.log.write(`${job.title} — démarré sur ${route.model} (${route.reason})`);
      this.emitter.fire(job);

      const parts = await this.buildParts(job, route.prompt);
      const toolWritten = new Set<string>();
      const hasWs = !!vscode.workspace.workspaceFolders?.length;
      const useTools = hasWs && this.cfg().get<boolean>('useClientTools', true);
      let liveText = '';
      let lastEmit = 0;
      const call = () => this.client.streamResponse({
        model: route.model,
        instructions: INSTRUCTIONS,
        parts,
        reasoning: this.cfg().get<boolean>('showReasoning', true),
        clientTools: useTools ? ['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file'] : undefined,
        signal: ac.signal,
      }, {
        onText: d => {
          job.receivedChars += d.length;
          liveText += d;
          job.summary = liveText.slice(-300);
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
          return runClientToolBatch(calls, job.title, toolWritten);
        },
      });

      let result;
      try {
        result = await call();
      } catch (e) {
        // Power-up uniquement en cas de 429, jamais pour contourner le coupe-circuit.
        if (e instanceof FsError && e.status === 429 && await this.quota.tryPowerUp(job.title)) result = await call();
        else throw e;
      }
      flushThought();

      job.summary = stripFileBlocks(result.text).slice(0, 2000);
      job.usage = result.usage;
      job.status = 'review';
      this.emitter.fire(job);
      const blockWritten = await applyFiles(parseFileBlocks(result.text), job.id, job.title);
      job.written = [...new Set([...toolWritten, ...blockWritten])];
      this.log.write(`${job.title} — terminé, ${job.written.length} fichier(s) écrit(s)`);
      this.quota.invalidate();
      void this.quota.snapshot(true).catch(() => undefined);
      this.finish(job, 'done');
    } catch (e) {
      flushThought();
      if (ac.signal.aborted) {
        this.finish(job, 'cancelled');
      } else {
        job.error = (e as Error).message;
        this.log.write(`${job.title} — ERREUR : ${job.error}`);
        this.finish(job, 'error');
      }
    }
  }

  /** Les suites ne reprennent que le résumé du parent : c'est la compaction. */
  private async buildParts(job: Job, prompt: string): Promise<InputPart[]> {
    const parent = job.parentId ? this.find(job.parentId) : undefined;
    let text = prompt;
    if (parent) {
      text = `Contexte (tâche précédente « ${parent.title.replace(/^\[ATG\]\s*/, '')} ») :\n${parent.summary}\n` +
        `Fichiers touchés : ${parent.written.join(', ') || 'aucun'}\n\nNouvelle demande : ${prompt}`;
    }
    const parts: InputPart[] = [{ type: 'input_text', text }];
    if (!job.files.length) return parts;

    const root = workspaceRoot();
    const inlineMax = this.cfg().get<number>('inlineFileKB', 48) * 1024;
    for (const rel of job.files) {
      const bytes = await vscode.workspace.fs.readFile(resolveSafe(root, rel));
      if (bytes.byteLength <= inlineMax) {
        parts.push({ type: 'input_text', text: `<<<FILE ${rel}\n${Buffer.from(bytes).toString('utf8')}\n>>>END` });
      } else {
        const id = await this.client.uploadFile(path.basename(rel), bytes);
        parts.push({ type: 'input_text', text: `Fichier joint : ${rel}` }, { type: 'input_file', file_id: id });
        this.log.write(`${job.title} — ${rel} envoyé via /filesv2 (${Math.round(bytes.byteLength / 1024)} Ko)`);
      }
    }
    return parts;
  }

  private finish(job: Job, status: JobStatus) {
    job.status = status;
    job.endedAt = Date.now();
    this.running.delete(job.id);
    this.jobs.delete(job.id);
    this.history = [{ ...job, thoughts: job.thoughts.slice(-5) }, ...this.history].slice(0, 50);
    void this.ctx.globalState.update('fsatg.history', this.history);
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
      endedAt: j.endedAt, usage: j.usage,
    };
  }

  dispose() {
    for (const ac of this.running.values()) ac.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
}
