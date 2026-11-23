import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';

import { executeComputerAction } from './computer_use.mjs';
import {
  apiCredentialStatus,
  fetchAgentsAndModels,
  loadState,
  pickModel,
  rankModelsBestToWorst,
  streamGenerationWithRefusalFallback,
} from './fs_core.mjs';
import { logEvent } from './logger.mjs';
import { executeSystemAction } from './system_tools.mjs';
import { executeWebAction } from './web_tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CANVAS_DIR = join(tmpdir(), 'fs-atg-canvas');
export const SCHEDULE_FILE_PATH = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_schedules.json');

function runPowerShellEncoded(script, timeoutMs = 20_000) {
  const fullScript = `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`;
  const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true }
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const errText = String(res.stderr || res.stdout || 'Erreur PowerShell')
      .replace(/#< CLIXML[\s\S]*/g, '')
      .trim();
    throw new Error(errText || `PowerShell exit ${res.status}`);
  }
  return String(res.stdout || '').trim();
}

// ============================================================================
// 1. fs_data (/data) — Code Interpreter, Dataset Profiler & SVG Chart Generator
// ============================================================================

export function parseCsvOrTsv(text, delimiter = ',') {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = parseLine(lines[0]).map((h, i) => h || `col_${i + 1}`);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const vals = parseLine(lines[i]);
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      const raw = vals[c] ?? '';
      const num = Number(raw);
      obj[headers[c]] = raw !== '' && !Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(raw) ? num : raw;
    }
    rows.push(obj);
  }
  return { headers, rows };
}

export function loadDatasetInput({ filePath, data, format } = {}) {
  if (Array.isArray(data)) {
    const headers = data.length && typeof data[0] === 'object' && data[0] !== null
      ? Object.keys(data[0])
      : ['value'];
    const rows = data.map((r) => (typeof r === 'object' && r !== null ? r : { value: r }));
    return { headers, rows, source: 'inline-array' };
  }
  let rawText = '';
  let ext = String(format || '').toLowerCase();
  let source = 'inline-text';
  if (filePath) {
    const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
    if (!existsSync(abs)) throw new Error(`Fichier de données introuvable : ${abs}`);
    rawText = readFileSync(abs, 'utf-8');
    ext = ext || extname(abs).toLowerCase().replace(/^\./, '');
    source = abs;
  } else if (typeof data === 'string') {
    rawText = data;
  } else {
    throw new Error('Fournis "filePath" ou "data" (CSV, JSON, tableau).');
  }

  if (ext === 'json' || rawText.trim().startsWith('[') || rawText.trim().startsWith('{')) {
    const parsed = JSON.parse(rawText);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.data) ? parsed.data : [parsed]);
    const headers = arr.length && typeof arr[0] === 'object' && arr[0] !== null ? Object.keys(arr[0]) : ['value'];
    return { headers, rows: arr, source };
  }
  if (ext === 'jsonl' || ext === 'ndjson') {
    const arr = rawText.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const headers = arr.length && typeof arr[0] === 'object' && arr[0] !== null ? Object.keys(arr[0]) : ['value'];
    return { headers, rows: arr, source };
  }
  const delim = ext === 'tsv' || (rawText.split('\n')[0]?.includes('\t') && !rawText.split('\n')[0]?.includes(',')) ? '\t' : ',';
  const parsed = parseCsvOrTsv(rawText, delim);
  return { ...parsed, source };
}

export function profileDataset({ headers, rows, source }) {
  const columns = {};
  for (const h of headers) {
    const vals = rows.map((r) => r?.[h]).filter((v) => v !== undefined && v !== null && v !== '');
    const nums = vals.map((v) => (typeof v === 'number' ? v : Number(v))).filter((n) => !Number.isNaN(n));
    const isNumeric = vals.length > 0 && nums.length >= vals.length * 0.8;
    if (isNumeric && nums.length > 0) {
      const sorted = [...nums].sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      const mean = sum / nums.length;
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const variance = nums.reduce((acc, n) => acc + (n - mean) ** 2, 0) / nums.length;
      columns[h] = {
        type: 'number',
        count: vals.length,
        missing: rows.length - vals.length,
        min: Number(sorted[0].toFixed(4)),
        max: Number(sorted[sorted.length - 1].toFixed(4)),
        sum: Number(sum.toFixed(4)),
        mean: Number(mean.toFixed(4)),
        median: Number(median.toFixed(4)),
        stdDev: Number(Math.sqrt(variance).toFixed(4)),
      };
    } else {
      const freq = new Map();
      for (const v of vals) {
        const k = String(v);
        freq.set(k, (freq.get(k) || 0) + 1);
      }
      const topValues = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }));
      columns[h] = {
        type: 'string',
        count: vals.length,
        missing: rows.length - vals.length,
        unique: freq.size,
        topValues,
      };
    }
  }
  return {
    ok: true,
    source,
    rowCount: rows.length,
    columnCount: headers.length,
    headers,
    columns,
    sampleRows: rows.slice(0, 5),
  };
}

export function generateSvgChart({
  type = 'bar',
  title = 'Graphique France Student',
  labels = [],
  values = [],
  width = 680,
  height = 360,
} = {}) {
  const safeLabels = labels.map((l) => String(l ?? ''));
  const safeValues = values.map((v) => Number(v) || 0);
  if (!safeValues.length) throw new Error('Le graphique requiert au moins une valeur dans "values".');

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const padL = 56;
  const padR = 28;
  const padT = 48;
  const padB = 54;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const maxVal = Math.max(...safeValues, 1);
  const minVal = Math.min(0, ...safeValues);
  const span = Math.max(maxVal - minVal, 1);

  let bodySvg = '';
  if (type === 'line') {
    const pts = safeValues.map((v, i) => {
      const x = padL + (safeValues.length === 1 ? plotW / 2 : (i / (safeValues.length - 1)) * plotW);
      const y = padT + plotH - ((v - minVal) / span) * plotH;
      return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), v, label: safeLabels[i] || `#${i + 1}` };
    });
    const poly = pts.map((p) => `${p.x},${p.y}`).join(' ');
    bodySvg += `<polyline fill="none" stroke="#2563eb" stroke-width="3" points="${poly}" />`;
    for (const p of pts) {
      bodySvg += `<circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#1d4ed8" />`;
      bodySvg += `<text x="${p.x}" y="${p.y - 10}" text-anchor="middle" font-size="11" fill="#e2e8f0">${p.v}</text>`;
      bodySvg += `<text x="${p.x}" y="${height - 18}" text-anchor="middle" font-size="11" fill="#94a3b8">${esc(p.label.slice(0, 12))}</text>`;
    }
  } else {
    const barGap = 10;
    const barW = Math.max(12, (plotW - barGap * (safeValues.length + 1)) / safeValues.length);
    safeValues.forEach((v, i) => {
      const h = Math.max(2, ((v - minVal) / span) * plotH);
      const x = Number((padL + barGap + i * (barW + barGap)).toFixed(1));
      const y = Number((padT + plotH - h).toFixed(1));
      const lbl = safeLabels[i] || `#${i + 1}`;
      bodySvg += `<rect x="${x}" y="${y}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="#2563eb" />`;
      bodySvg += `<text x="${(x + barW / 2).toFixed(1)}" y="${y - 6}" text-anchor="middle" font-size="11" fill="#e2e8f0">${v}</text>`;
      bodySvg += `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 18}" text-anchor="middle" font-size="11" fill="#94a3b8">${esc(lbl.slice(0, 12))}</text>`;
    });
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="background:#0f172a;font-family:system-ui,sans-serif;border-radius:10px">`,
    `  <text x="${width / 2}" y="28" text-anchor="middle" font-size="15" font-weight="600" fill="#f8fafc">${esc(title)}</text>`,
    `  <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#334155" stroke-width="1.5" />`,
    `  <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#334155" stroke-width="1.5" />`,
    `  <text x="${padL - 8}" y="${padT + 10}" text-anchor="end" font-size="10" fill="#64748b">${maxVal}</text>`,
    `  <text x="${padL - 8}" y="${padT + plotH}" text-anchor="end" font-size="10" fill="#64748b">${minVal}</text>`,
    `  ${bodySvg}`,
    `</svg>`,
  ].join('\n');
}

export async function executeDataAction(params = {}) {
  const action = String(params?.action || 'profile').trim().toLowerCase();

  if (action === 'profile') {
    const ds = loadDatasetInput(params);
    return profileDataset(ds);
  }

  if (action === 'query') {
    const ds = loadDatasetInput(params);
    let rows = [...ds.rows];
    if (params.filterColumn) {
      const col = String(params.filterColumn);
      const op = String(params.filterOp || 'eq').toLowerCase();
      const target = params.filterValue;
      rows = rows.filter((r) => {
        const val = r?.[col];
        if (op === 'eq' || op === '=') return String(val) === String(target);
        if (op === 'neq' || op === '!=') return String(val) !== String(target);
        if (op === 'contains') return String(val ?? '').toLowerCase().includes(String(target ?? '').toLowerCase());
        if (op === 'gt' || op === '>') return Number(val) > Number(target);
        if (op === 'gte' || op === '>=') return Number(val) >= Number(target);
        if (op === 'lt' || op === '<') return Number(val) < Number(target);
        if (op === 'lte' || op === '<=') return Number(val) <= Number(target);
        return true;
      });
    }
    if (params.groupBy) {
      const gCol = String(params.groupBy);
      const aggCol = String(params.aggColumn || gCol);
      const aggOp = String(params.aggOp || 'count').toLowerCase();
      const groups = new Map();
      for (const r of rows) {
        const key = String(r?.[gCol] ?? '(vide)');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const aggregated = [];
      for (const [key, list] of groups.entries()) {
        const nums = list.map((x) => Number(x?.[aggCol])).filter((n) => !Number.isNaN(n));
        let value = list.length;
        if (aggOp === 'sum') value = Number(nums.reduce((a, b) => a + b, 0).toFixed(4));
        else if (aggOp === 'avg' || aggOp === 'mean') value = nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4)) : 0;
        else if (aggOp === 'max') value = nums.length ? Math.max(...nums) : 0;
        else if (aggOp === 'min') value = nums.length ? Math.min(...nums) : 0;
        aggregated.push({ [gCol]: key, [aggOp]: value, count: list.length });
      }
      rows = aggregated;
    }
    if (params.sortBy) {
      const sCol = String(params.sortBy);
      const desc = String(params.sortOrder || 'desc').toLowerCase() === 'desc';
      rows.sort((a, b) => {
        const va = a?.[sCol];
        const vb = b?.[sCol];
        if (typeof va === 'number' && typeof vb === 'number') return desc ? vb - va : va - vb;
        return desc ? String(vb ?? '').localeCompare(String(va ?? '')) : String(va ?? '').localeCompare(String(vb ?? ''));
      });
    }
    const limit = Math.max(1, Math.min(200, Number(params.limit) || 25));
    return {
      ok: true,
      action: 'query',
      matchedRows: rows.length,
      rows: rows.slice(0, limit),
    };
  }

  if (action === 'chart') {
    let labels = Array.isArray(params.labels) ? params.labels : [];
    let values = Array.isArray(params.values) ? params.values : [];
    if ((!labels.length || !values.length) && (params.filePath || params.data)) {
      const ds = loadDatasetInput(params);
      const lCol = params.labelColumn || ds.headers[0];
      const vCol = params.valueColumn || ds.headers[1] || ds.headers[0];
      labels = ds.rows.slice(0, 30).map((r) => String(r?.[lCol] ?? ''));
      values = ds.rows.slice(0, 30).map((r) => Number(r?.[vCol]) || 0);
    }
    const svg = generateSvgChart({
      type: params.chartType || params.type || 'bar',
      title: params.title || 'Graphique France Student',
      labels,
      values,
    });
    mkdirSync(CANVAS_DIR, { recursive: true });
    const outPath = params.outputPath
      ? (isAbsolute(params.outputPath) ? params.outputPath : resolve(params.outputPath))
      : join(CANVAS_DIR, `chart-${Date.now()}.svg`);
    writeFileSync(outPath, svg, 'utf-8');
    return { ok: true, action: 'chart', path: outPath, points: values.length, svg };
  }

  if (action === 'run_js' || action === 'run_python') {
    const code = String(params.code || '').trim();
    if (!code) throw new Error('Paramètre "code" requis pour exécuter le Code Interpreter.');
    const timeoutMs = Math.max(1000, Math.min(30_000, Number(params.timeoutMs) || 12_000));
    const isPy = action === 'run_python';
    const cmd = isPy ? 'python' : process.execPath;
    const args = isPy ? ['-c', code] : ['--input-type=module', '-e', code];
    const startedAt = Date.now();
    const res = spawnSync(cmd, args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
      cwd: params.workspaceRoot && existsSync(params.workspaceRoot) ? params.workspaceRoot : tmpdir(),
    });
    return {
      ok: res.status === 0 && !res.error,
      action,
      exitCode: res.status ?? -1,
      durationMs: Date.now() - startedAt,
      stdout: String(res.stdout || '').trim().slice(0, 16_000),
      stderr: String(res.stderr || res.error?.message || '').trim().slice(0, 8_000),
    };
  }

  throw new Error(`Action fs_data inconnue : "${action}". Utilise profile, query, chart, run_js ou run_python.`);
}

// ============================================================================
// 2. fs_research (/research) — Deep Research Multi-Sources
// ============================================================================

export async function executeResearchAction(params = {}) {
  const query = String(params?.query || '').trim();
  const subQueries = Array.isArray(params?.queries) && params.queries.length
    ? params.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4)
    : (query ? [query] : []);
  if (!subQueries.length) throw new Error('Paramètre "query" (ou "queries") requis pour fs_research.');

  const maxSources = Math.max(1, Math.min(6, Number(params.maxSources) || 3));
  const searchBundles = await Promise.all(
    subQueries.map((q) => executeWebAction({ action: 'search', query: q, maxResults: maxSources + 2 }).catch((e) => ({ results: [], error: e.message })))
  );

  const seenUrls = new Set();
  const candidates = [];
  for (const b of searchBundles) {
    for (const r of b.results || []) {
      if (!r.url || seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      candidates.push(r);
      if (candidates.length >= maxSources) break;
    }
    if (candidates.length >= maxSources) break;
  }

  const fetchedSources = await Promise.all(
    candidates.map(async (item, idx) => {
      try {
        const page = await executeWebAction({
          action: 'fetch',
          url: item.url,
          maxChars: Math.max(1500, Math.min(8000, Number(params.maxCharsPerSource) || 3500)),
        });
        return {
          citationId: idx + 1,
          title: page.title || item.title,
          url: item.url,
          snippet: item.snippet || '',
          excerptMarkdown: page.markdown || item.snippet || '',
        };
      } catch (err) {
        return {
          citationId: idx + 1,
          title: item.title,
          url: item.url,
          snippet: item.snippet || '',
          excerptMarkdown: item.snippet || `Erreur lecture: ${err.message}`,
        };
      }
    })
  );

  const digestLines = fetchedSources.map((s) => (
    `### [${s.citationId}] ${s.title}\nSource : ${s.url}\n\n${s.excerptMarkdown}`
  ));
  const compiledEvidence = digestLines.join('\n\n---\n\n');

  let synthesis = null;
  let synthesisModel = null;
  if (params.synthesize !== false && fetchedSources.length > 0) {
    try {
      const state = loadState();
      const cred = await apiCredentialStatus(state);
      if (cred.configured) {
        const bundle = await fetchAgentsAndModels(state);
        const route = pickModel(query, bundle.ids, { ...state, routingProfile: 'eco' });
        if (!route.needsApproval) {
          const gen = await streamGenerationWithRefusalFallback({
            state,
            model: route.model,
            availableModels: bundle.ids,
            agentMap: bundle.agentMap,
            instructions: 'Tu es un analyste Deep Research. Synthétise les sources fournies en français avec des citations numérotées [1], [2]... Sois précis, factuel et concis.',
            prompt: `Sujet de recherche : ${query || subQueries.join(' / ')}\n\nSources collectées :\n\n${compiledEvidence}`,
          });
          synthesis = String(gen.text || '').trim();
          synthesisModel = gen.model || route.model;
        }
      }
    } catch { /* fallback to structured evidence */ }
  }

  return {
    ok: true,
    queries: subQueries,
    sourcesCount: fetchedSources.length,
    synthesisModel,
    synthesis: synthesis || `Synthèse multi-sources (${fetchedSources.length} sources collectées) :\n\n${compiledEvidence.slice(0, 6000)}`,
    citations: fetchedSources.map((s) => ({ id: s.citationId, title: s.title, url: s.url })),
    sources: fetchedSources,
  };
}

// ============================================================================
// 3. fs_canvas (/canvas) — Interactive Artifacts & Live Preview Server
// ============================================================================

let canvasServer = null;
let canvasPort = null;

function wrapArtifactHtml({ title = 'Artifact France Student', type = 'html', content = '' }) {
  const kind = String(type || 'html').toLowerCase();
  if (kind === 'html' && /<!doctype html>|<html[\s>]/i.test(content)) {
    return content;
  }
  if (kind === 'svg') {
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif}</style></head><body>${content}</body></html>`;
  }
  if (kind === 'mermaid') {
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title><script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';mermaid.initialize({startOnLoad:true,theme:'dark'});</script><style>body{margin:0;padding:24px;background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif}</style></head><body><pre class="mermaid">${content}</pre></body></html>`;
  }
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;padding:20px;background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif}</style></head><body>${content}</body></html>`;
}

async function ensureCanvasServer() {
  if (canvasServer && canvasPort) return canvasPort;
  mkdirSync(CANVAS_DIR, { recursive: true });
  return await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
      const target = join(CANVAS_DIR, basename(urlPath || 'index.html'));
      if (!existsSync(target)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Artifact introuvable.');
        return;
      }
      const ext = extname(target).toLowerCase();
      const mime = ext === '.svg' ? 'image/svg+xml' : (ext === '.json' ? 'application/json' : 'text/html; charset=utf-8');
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(readFileSync(target));
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      canvasServer = srv;
      canvasPort = srv.address().port;
      srv.unref();
      resolve(canvasPort);
    });
  });
}

export async function executeCanvasAction(params = {}) {
  const action = String(params?.action || 'list').trim().toLowerCase();
  mkdirSync(CANVAS_DIR, { recursive: true });

  if (action === 'create' || action === 'update') {
    const id = String(params.id || params.name || `artifact-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-');
    const type = String(params.type || 'html').toLowerCase();
    const title = String(params.title || id);
    const content = String(params.content || '');
    if (!content.trim()) throw new Error('Paramètre "content" requis pour créer un artifact Canvas.');

    const html = wrapArtifactHtml({ title, type, content });
    const fileName = id.endsWith('.html') ? id : `${id}.html`;
    const filePath = join(CANVAS_DIR, fileName);
    writeFileSync(filePath, html, 'utf-8');
    const port = await ensureCanvasServer();
    const previewUrl = `http://127.0.0.1:${port}/${encodeURIComponent(fileName)}`;
    logEvent('info', 'canvas', 'canvas.save', `Artifact Canvas créé : ${fileName}`, { previewUrl });
    return {
      ok: true,
      action,
      id: fileName,
      title,
      type,
      path: filePath,
      previewUrl,
      bytes: Buffer.byteLength(html, 'utf-8'),
    };
  }

  if (action === 'list') {
    const files = existsSync(CANVAS_DIR)
      ? readdirSync(CANVAS_DIR).filter((f) => f.endsWith('.html') || f.endsWith('.svg'))
      : [];
    const port = files.length ? await ensureCanvasServer() : canvasPort;
    const artifacts = files.map((f) => {
      const full = join(CANVAS_DIR, f);
      const st = statSync(full);
      return {
        id: f,
        path: full,
        bytes: st.size,
        updatedAt: st.mtimeMs,
        previewUrl: port ? `http://127.0.0.1:${port}/${encodeURIComponent(f)}` : null,
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
    return { ok: true, action: 'list', count: artifacts.length, artifacts };
  }

  if (action === 'get') {
    const id = basename(String(params.id || ''));
    const full = join(CANVAS_DIR, id.endsWith('.html') || id.endsWith('.svg') ? id : `${id}.html`);
    if (!existsSync(full)) throw new Error(`Artifact introuvable : ${id}`);
    const port = await ensureCanvasServer();
    return {
      ok: true,
      id: basename(full),
      path: full,
      previewUrl: `http://127.0.0.1:${port}/${encodeURIComponent(basename(full))}`,
      content: readFileSync(full, 'utf-8'),
    };
  }

  if (action === 'clear') {
    const files = existsSync(CANVAS_DIR) ? readdirSync(CANVAS_DIR) : [];
    for (const f of files) {
      try { unlinkSync(join(CANVAS_DIR, f)); } catch {}
    }
    return { ok: true, action: 'clear', removed: files.length };
  }

  throw new Error(`Action fs_canvas inconnue : "${action}". Utilise create, update, list, get ou clear.`);
}

// ============================================================================
// 4. fs_vision (/vision) — Screen Vision & Native Windows WinRT OCR
// ============================================================================

export function runWindowsOcrOnFile(imagePath) {
  const abs = isAbsolute(imagePath) ? imagePath : resolve(imagePath);
  if (!existsSync(abs)) throw new Error(`Image introuvable pour OCR : ${abs}`);
  if (process.platform !== 'win32') {
    return { ok: true, engine: 'fallback-non-win32', path: abs, text: '', lines: [] };
  }
  const escaped = abs.replace(/'/g, "''");
  const ps = [
    `$path = '${escaped}'`,
    `Add-Type -AssemblyName System.Runtime.WindowsRuntime`,
    `$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]`,
    `$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]`,
    `$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]`,
    `$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]`,
    `function Await($WinRtTask, $ResultType) { $asTask = $asTaskGeneric.MakeGenericMethod($ResultType); $netTask = $asTask.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }`,
    `$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])`,
    `$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])`,
    `$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])`,
    `$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])`,
    `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()`,
    `if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }`,
    `if ($null -eq $engine) { @{ ok = $true; engine = 'none'; text = ''; lines = @() } | ConvertTo-Json -Compress; exit 0 }`,
    `$res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])`,
    `$lines = @($res.Lines | ForEach-Object { $_.Text })`,
    `$stream.Dispose()`,
    `@{ ok = $true; engine = 'windows-media-ocr'; text = [string]$res.Text; lines = $lines } | ConvertTo-Json -Compress -Depth 4`,
  ].join('; ');
  try {
    const raw = runPowerShellEncoded(ps, 25_000);
    return { path: abs, ...JSON.parse(raw) };
  } catch (err) {
    return {
      ok: true,
      engine: 'metadata-fallback',
      path: abs,
      text: '',
      lines: [],
      note: `OCR WinRT non disponible sur cette image : ${err.message}`,
    };
  }
}

export async function executeVisionAction(params = {}) {
  const action = String(params?.action || 'ocr_screen').trim().toLowerCase();

  if (action === 'ocr_screen') {
    const shot = await executeComputerAction(
      { action: 'screenshot', region: params.region },
      { permissionMode: 'full', computerUseEnabled: true }
    );
    const ocr = runWindowsOcrOnFile(shot.path);
    return {
      ok: true,
      action: 'ocr_screen',
      screenshotPath: shot.path,
      width: shot.width,
      height: shot.height,
      protectedSurface: Boolean(shot.protectedSurface),
      engine: ocr.engine,
      text: ocr.text || '',
      lines: ocr.lines || [],
    };
  }

  if (action === 'ocr_image') {
    const target = String(params.path || params.imagePath || '').trim();
    if (!target) throw new Error('Paramètre "path" requis pour ocr_image.');
    return { action: 'ocr_image', ...runWindowsOcrOnFile(target) };
  }

  if (action === 'inspect_image') {
    const target = String(params.path || params.imagePath || '').trim();
    if (!target) throw new Error('Paramètre "path" requis pour inspect_image.');
    const abs = isAbsolute(target) ? target : resolve(target);
    if (!existsSync(abs)) throw new Error(`Image introuvable : ${abs}`);
    const buf = readFileSync(abs);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    let width = null;
    let height = null;
    let format = extname(abs).replace(/^\./, '').toLowerCase() || 'unknown';
    // Lecture dimensions PNG directe (IHDR offset 16..24)
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      format = 'png';
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    }
    return {
      ok: true,
      action: 'inspect_image',
      path: abs,
      format,
      width,
      height,
      bytes: buf.length,
      sha256,
    };
  }

  throw new Error(`Action fs_vision inconnue : "${action}". Utilise ocr_screen, ocr_image ou inspect_image.`);
}

// ============================================================================
// 5. fs_arena (/arena) — Multi-Model Consensus / Arena
// ============================================================================

export async function executeArenaAction(params = {}) {
  const prompt = String(params?.prompt || params?.task || '').trim();
  if (!prompt) throw new Error('Paramètre "prompt" requis pour fs_arena.');

  const state = loadState();
  const requestedModels = Array.isArray(params?.models)
    ? params.models.map((m) => String(m).trim()).filter(Boolean).slice(0, 3)
    : [];

  const cred = await apiCredentialStatus(state);
  if (!cred.configured || params.dryRun === true) {
    const ranked = rankModelsBestToWorst(
      requestedModels.length ? requestedModels : ['claude-sonnet-5-5', 'gpt-6.2-astra', 'gemini-3.5-pro'],
      state
    ).slice(0, 3);
    return {
      ok: true,
      mode: 'dry-run',
      selectedModels: ranked,
      message: cred.configured
        ? 'Sélection Arena (dry-run).'
        : 'Non authentifié : connecte-toi à France Student pour exécuter le comparatif multi-modèles en direct.',
    };
  }

  const bundle = await fetchAgentsAndModels(state);
  const candidates = requestedModels.length
    ? requestedModels.filter((m) => bundle.ids.includes(m))
    : rankModelsBestToWorst(bundle.ids, state).slice(0, Math.max(2, Math.min(3, Number(params.count) || 2)));

  if (!candidates.length) {
    throw new Error('Aucun modèle France Student autorisé disponible pour Arena.');
  }

  const runs = await Promise.all(
    candidates.map(async (modelId) => {
      const t0 = Date.now();
      try {
        const res = await streamGenerationWithRefusalFallback({
          state,
          model: modelId,
          availableModels: [modelId],
          agentMap: bundle.agentMap,
          instructions: 'Réponds de façon concise, structurée et directement exploitable.',
          prompt,
        });
        return {
          model: res.model || modelId,
          ok: true,
          durationMs: Date.now() - t0,
          response: String(res.text || '').trim(),
        };
      } catch (err) {
        return {
          model: modelId,
          ok: false,
          durationMs: Date.now() - t0,
          error: String(err?.message || err),
        };
      }
    })
  );

  const successful = runs.filter((r) => r.ok && r.response);
  return {
    ok: successful.length > 0,
    modelsCompared: candidates,
    successCount: successful.length,
    runs,
    consensusPreview: successful
      .map((r, i) => `### Modèle ${i + 1} : ${r.model} (${(r.durationMs / 1000).toFixed(1)}s)\n${r.response}`)
      .join('\n\n---\n\n'),
  };
}

// ============================================================================
// 6. fs_doc (/doc) — Universal Document Reader (.pdf, .docx, .xlsx, .pptx, .zip, .md)
// ============================================================================

export function parseZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLen).toString('utf-8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buffer.length) break;
    const rawData = buffer.slice(dataStart, dataEnd);
    entries.push({ name, method, compSize, uncompSize, rawData });
    offset = dataEnd;
  }
  return entries;
}

function decodeZipEntryText(entry) {
  try {
    if (entry.method === 0) return entry.rawData.toString('utf-8');
    if (entry.method === 8) return inflateRawSync(entry.rawData).toString('utf-8');
  } catch {}
  return '';
}

function stripXmlTags(xml) {
  return String(xml || '')
    .replace(/<\/w:p>|<\/a:p>|<\/p>|<\/row>/gi, '\n')
    .replace(/<w:tab\/>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractPdfTextFromBuffer(buffer) {
  const raw = buffer.toString('latin1');
  const chunks = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRegex.exec(raw)) !== null) {
    const bodyLatin1 = match[1];
    let decoded = bodyLatin1;
    try {
      decoded = inflateSync(Buffer.from(bodyLatin1, 'latin1')).toString('latin1');
    } catch {
      try {
        decoded = inflateRawSync(Buffer.from(bodyLatin1, 'latin1')).toString('latin1');
      } catch {}
    }
    const tjMatches = decoded.match(/\((?:\\.|[^\\()])*\)\s*Tj/g) || [];
    for (const m of tjMatches) {
      const inner = m.replace(/\)\s*Tj$/, '').replace(/^\(/, '');
      chunks.push(inner.replace(/\\([()\\])/g, '$1'));
    }
    const tjArrMatches = decoded.match(/\[(?:[^\]]*)\]\s*TJ/g) || [];
    for (const arr of tjArrMatches) {
      const parts = arr.match(/\((?:\\.|[^\\()])*\)/g) || [];
      chunks.push(parts.map((p) => p.slice(1, -1).replace(/\\([()\\])/g, '$1')).join(''));
    }
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

export function extractDocumentContent(filePath) {
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (!existsSync(abs)) throw new Error(`Document introuvable : ${abs}`);
  const ext = extname(abs).toLowerCase();
  const buf = readFileSync(abs);

  if (['.md', '.txt', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml'].includes(ext)) {
    return { path: abs, format: ext.slice(1), text: buf.toString('utf-8') };
  }

  if (ext === '.pdf') {
    const text = extractPdfTextFromBuffer(buf);
    return { path: abs, format: 'pdf', text };
  }

  if (['.docx', '.pptx', '.xlsx', '.odt', '.zip'].includes(ext)) {
    const entries = parseZipEntries(buf);
    if (ext === '.zip') {
      return {
        path: abs,
        format: 'zip',
        entries: entries.map((e) => ({ name: e.name, size: e.uncompSize })),
        text: entries.map((e) => `${e.name} (${e.uncompSize} o)`).join('\n'),
      };
    }
    const targetXmls = entries.filter((e) => (
      e.name === 'word/document.xml' ||
      e.name === 'content.xml' ||
      e.name.startsWith('ppt/slides/slide') ||
      e.name === 'xl/sharedStrings.xml' ||
      e.name.startsWith('xl/worksheets/sheet')
    ));
    const texts = targetXmls.map((e) => stripXmlTags(decodeZipEntryText(e))).filter(Boolean);
    return { path: abs, format: ext.slice(1), text: texts.join('\n\n') };
  }

  return { path: abs, format: ext.slice(1) || 'text', text: buf.toString('utf-8') };
}

export async function executeDocAction(params = {}) {
  const action = String(params?.action || 'extract').trim().toLowerCase();
  const filePath = String(params?.path || params?.filePath || '').trim();
  if (!filePath) throw new Error('Paramètre "path" requis pour fs_doc.');

  const doc = extractDocumentContent(filePath);
  const paragraphs = doc.text
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ])/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (action === 'extract') {
    const maxChars = Math.max(500, Math.min(30_000, Number(params.maxChars) || 10_000));
    return {
      ok: true,
      action: 'extract',
      path: doc.path,
      format: doc.format,
      totalChars: doc.text.length,
      chunksCount: paragraphs.length,
      entries: doc.entries,
      text: doc.text.slice(0, maxChars),
      truncated: doc.text.length > maxChars,
    };
  }

  if (action === 'search') {
    const q = String(params.query || '').trim().toLowerCase();
    if (!q) throw new Error('Paramètre "query" requis pour chercher dans un document.');
    const terms = q.split(/\s+/).filter(Boolean);
    const scored = paragraphs.map((text, index) => {
      const lower = text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (lower.includes(t)) score += 2;
      }
      if (lower.includes(q)) score += 3;
      return { chunkIndex: index + 1, score, text };
    }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);

    const topK = Math.max(1, Math.min(15, Number(params.topK) || 5));
    return {
      ok: true,
      action: 'search',
      path: doc.path,
      format: doc.format,
      query: q,
      matchesCount: scored.length,
      excerpts: scored.slice(0, topK),
    };
  }

  throw new Error(`Action fs_doc inconnue : "${action}". Utilise extract ou search.`);
}

// ============================================================================
// 7. fs_voice (/voice) — Windows TTS Speech & WAV Audio Synthesizer
// ============================================================================

export async function executeVoiceAction(params = {}) {
  const action = String(params?.action || 'speak').trim().toLowerCase();

  if (action === 'voices') {
    if (process.platform !== 'win32') {
      return { ok: true, voices: [{ name: 'System Default', culture: 'fr-FR' }] };
    }
    const raw = runPowerShellEncoded(
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $v = @($s.GetInstalledVoices() | ForEach-Object { @{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender } }); @{ ok = $true; voices = $v } | ConvertTo-Json -Compress -Depth 4`
    );
    return JSON.parse(raw);
  }

  if (action === 'speak' || action === 'to_wav') {
    const text = String(params.text || '').trim().slice(0, 2500);
    if (!text) throw new Error('Paramètre "text" requis pour fs_voice.');
    const rate = Math.max(-5, Math.min(5, Number(params.rate) || 0));
    const escapedText = text.replace(/'/g, "''");

    if (action === 'to_wav') {
      mkdirSync(CANVAS_DIR, { recursive: true });
      const outPath = params.outputPath
        ? (isAbsolute(params.outputPath) ? params.outputPath : resolve(params.outputPath))
        : join(CANVAS_DIR, `voice-${Date.now()}.wav`);
      if (process.platform === 'win32') {
        const escapedOut = outPath.replace(/'/g, "''");
        runPowerShellEncoded(
          `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${rate}; $s.SetOutputToWaveFile('${escapedOut}'); $s.Speak('${escapedText}'); $s.Dispose()`
        );
      } else {
        writeFileSync(outPath, Buffer.from('RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00D\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00', 'binary'));
      }
      return { ok: true, action: 'to_wav', path: outPath, chars: text.length };
    }

    if (process.platform === 'win32' && params.dryRun !== true) {
      const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${rate}; $s.Speak('${escapedText}'); $s.Dispose()`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
    }
    return { ok: true, action: 'speak', spoken: text, rate };
  }

  throw new Error(`Action fs_voice inconnue : "${action}". Utilise speak, to_wav ou voices.`);
}

// ============================================================================
// 8. fs_schedule (/watch) — Scheduled Tasks & Intelligent Watchers
// ============================================================================

const activeTimers = new Map();

export function loadSchedules(filePath = SCHEDULE_FILE_PATH) {
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export function saveSchedules(list, filePath = SCHEDULE_FILE_PATH) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8');
}

export async function runSingleScheduleTask(task) {
  const kind = String(task.kind || 'file').toLowerCase();
  const target = String(task.target || '').trim();
  const startedAt = Date.now();

  if (kind === 'file') {
    const abs = isAbsolute(target) ? target : resolve(target);
    if (!existsSync(abs)) {
      return { ok: false, kind, target: abs, checkedAt: startedAt, summary: 'Fichier introuvable' };
    }
    const st = statSync(abs);
    const hash = createHash('sha1').update(readFileSync(abs)).digest('hex').slice(0, 12);
    return {
      ok: true,
      kind,
      target: abs,
      checkedAt: startedAt,
      size: st.size,
      mtimeMs: st.mtimeMs,
      signature: hash,
      summary: `${basename(abs)} (${st.size} o · sha1:${hash})`,
    };
  }

  if (kind === 'http') {
    const res = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(8000) });
    return {
      ok: res.ok,
      kind,
      target,
      checkedAt: startedAt,
      status: res.status,
      signature: String(res.status),
      summary: `HTTP ${res.status} (${Date.now() - startedAt} ms)`,
    };
  }

  if (kind === 'command') {
    const parts = target.split(/\s+/).filter(Boolean);
    const res = spawnSync(parts[0], parts.slice(1), { encoding: 'utf-8', timeout: 10_000, windowsHide: true });
    const out = String(res.stdout || res.stderr || '').trim().slice(0, 400);
    return {
      ok: res.status === 0,
      kind,
      target,
      checkedAt: startedAt,
      exitCode: res.status ?? -1,
      signature: `${res.status}:${createHash('sha1').update(out).digest('hex').slice(0, 8)}`,
      summary: out || `Exit ${res.status}`,
    };
  }

  throw new Error(`Type de watcher inconnu : "${kind}". Utilise file, http ou command.`);
}

export async function executeScheduleAction(params = {}, { filePath = SCHEDULE_FILE_PATH } = {}) {
  const effectivePath = params?.configFilePath || filePath;
  const action = String(params?.action || 'list').trim().toLowerCase();
  const list = loadSchedules(effectivePath);

  if (action === 'list') {
    return { ok: true, action: 'list', count: list.length, schedules: list };
  }

  if (action === 'add') {
    const name = String(params.name || params.target || 'Watcher').trim();
    const kind = String(params.kind || 'file').toLowerCase();
    const target = String(params.target || '').trim();
    if (!target) throw new Error('Paramètre "target" requis (chemin de fichier, URL HTTP ou commande).');
    const intervalSec = Math.max(5, Math.min(86_400, Number(params.intervalSec) || 60));
    const initialCheck = await runSingleScheduleTask({ kind, target }).catch((e) => ({
      ok: false,
      checkedAt: Date.now(),
      signature: 'err',
      summary: e.message,
    }));
    const item = {
      id: params.id || `watch-${randomUUID().slice(0, 8)}`,
      name,
      kind,
      target,
      intervalSec,
      notifyOnChange: params.notifyOnChange !== false,
      createdAt: Date.now(),
      lastRunAt: initialCheck.checkedAt,
      lastOk: initialCheck.ok,
      lastSignature: initialCheck.signature || null,
      lastSummary: initialCheck.summary || '',
    };
    const next = [item, ...list.filter((x) => x.id !== item.id)].slice(0, 30);
    saveSchedules(next, effectivePath);

    if (params.startTimer !== false && effectivePath === SCHEDULE_FILE_PATH) {
      if (activeTimers.has(item.id)) clearInterval(activeTimers.get(item.id));
      const timer = setInterval(async () => {
        try {
          const curList = loadSchedules(effectivePath);
          const idx = curList.findIndex((x) => x.id === item.id);
          if (idx < 0) {
            clearInterval(timer);
            activeTimers.delete(item.id);
            return;
          }
          const check = await runSingleScheduleTask(curList[idx]);
          const prevSig = curList[idx].lastSignature;
          curList[idx].lastRunAt = check.checkedAt;
          curList[idx].lastOk = check.ok;
          curList[idx].lastSignature = check.signature || null;
          curList[idx].lastSummary = check.summary;
          saveSchedules(curList, effectivePath);
          if (curList[idx].notifyOnChange && prevSig && check.signature && prevSig !== check.signature) {
            await executeSystemAction({
              action: 'notify',
              title: `Watcher : ${curList[idx].name}`,
              message: check.summary,
            }).catch(() => {});
          }
        } catch {}
      }, intervalSec * 1000);
      timer.unref();
      activeTimers.set(item.id, timer);
    }

    return { ok: true, action: 'add', schedule: item, total: next.length };
  }

  if (action === 'run_now') {
    const id = String(params.id || '').trim();
    const item = list.find((x) => x.id === id) || (params.target ? { kind: params.kind || 'file', target: params.target } : null);
    if (!item) throw new Error(`Tâche planifiée introuvable : "${id}".`);
    const check = await runSingleScheduleTask(item);
    if (item.id) {
      item.lastRunAt = check.checkedAt;
      item.lastOk = check.ok;
      item.lastSignature = check.signature || null;
      item.lastSummary = check.summary;
      saveSchedules(list, effectivePath);
    }
    return { ok: true, action: 'run_now', result: check };
  }

  if (action === 'remove') {
    const id = String(params.id || '').trim();
    if (activeTimers.has(id)) {
      clearInterval(activeTimers.get(id));
      activeTimers.delete(id);
    }
    const next = list.filter((x) => x.id !== id);
    saveSchedules(next, effectivePath);
    return { ok: true, action: 'remove', id, remaining: next.length };
  }

  if (action === 'clear') {
    for (const t of activeTimers.values()) clearInterval(t);
    activeTimers.clear();
    saveSchedules([], effectivePath);
    return { ok: true, action: 'clear', remaining: 0 };
  }

  throw new Error(`Action fs_schedule inconnue : "${action}". Utilise list, add, run_now, remove ou clear.`);
}
