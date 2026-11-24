import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  analyzeTaskIntent,
  buildReasoningDirective,
  clearCancelRequest,
  DEFAULT_STATE,
  DEFAULT_TOOLS_STREAM_TIMEOUT_MS,
  enrichModelsCatalog,
  extractModelVersion,
  getModelTelemetry,
  isJobCancelRequested,
  MCP_TOOL_CATALOG,
  parseTaskDirectives,
  pickModel,
  rankModelsBestToWorst,
  recordModelTelemetry,
  requestCancelJob,
  scoreModelPower,
  TELEMETRY_MAX_SAMPLES,
  TELEMETRY_WINDOW_MS,
} from '../plugin/fs_core.mjs';
import { clearReadCache, createWorkspaceToolRunner, diffTexts, readCacheSize } from '../plugin/tools_engine.mjs';
import { COMPUTER_ACTIONS, validateComputerAction } from '../plugin/computer_use.mjs';
import { BROWSER_ACTIONS, validateBrowserUrl } from '../plugin/browser_use.mjs';
import { htmlToCleanMarkdown } from '../plugin/web_tools.mjs';
import { executeSystemAction } from '../plugin/system_tools.mjs';
import {
  MCP_HUB_CATALOG,
  MCP_HUB_CATEGORIES,
  executeMcpHubAction,
  executeRobloxBridge,
} from '../plugin/mcp_hub.mjs';
import {
  executeArenaAction,
  executeCanvasAction,
  executeDataAction,
  executeDocAction,
  executeScheduleAction,
  executeVisionAction,
  executeVoiceAction,
} from '../plugin/classic_ai_tools.mjs';

test('télémétrie : agrège tok/s, TTFT, taux de succès et replis, fenêtre 7 jours', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-atg-tele-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'tele.json');
  const now = 1_800_000_000_000;

  recordModelTelemetry('m1', { ok: true, ttftMs: 400, durationMs: 10_000, outputTokens: 500 }, { filePath, now });
  recordModelTelemetry('m1', { ok: true, ttftMs: 600, durationMs: 10_000, outputTokens: 700 }, { filePath, now });
  recordModelTelemetry('m1', { ok: false, status: 429, durationMs: 100 }, { filePath, now });
  // échantillon hors fenêtre : ignoré à l'agrégation
  recordModelTelemetry('old', { ok: true, durationMs: 1000, outputTokens: 10 }, { filePath, now: now - TELEMETRY_WINDOW_MS - 1000 });

  const stats = getModelTelemetry({ filePath, now });
  assert.equal(stats.old, undefined);
  assert.equal(stats.m1.samples, 3);
  assert.equal(stats.m1.successRate, 67);
  assert.equal(stats.m1.fallbackCount, 1);
  assert.equal(stats.m1.ttftMs, 500);
  assert.equal(stats.m1.tokPerSec, 60);

  for (let i = 0; i < TELEMETRY_MAX_SAMPLES + 20; i += 1) {
    recordModelTelemetry('bulk', { ok: true, durationMs: 1000, outputTokens: 10 }, { filePath, now });
  }
  assert.equal(getModelTelemetry({ filePath, now }).bulk.samples, TELEMETRY_MAX_SAMPLES);
});

test('/model force un modèle précis et retire la directive du prompt', () => {
  const d = parseTaskDirectives('/model gpt-6.2-astra corrige ce bug');
  assert.deepEqual(d.requested, { kind: 'model', value: 'gpt-6.2-astra' });
  assert.equal(d.prompt, 'corrige ce bug');

  const state = { ...DEFAULT_STATE, modelPolicies: {}, blockedModels: [], allowedModels: [] };
  const route = pickModel('/model sonnet corrige ce bug', ['claude-opus-5-5', 'claude-sonnet-5-5'], state);
  assert.equal(route.model, 'claude-sonnet-5-5');
  assert.equal(route.prompt, 'corrige ce bug');
});

test('diffTexts : ne garde que le bloc modifié avec contexte', () => {
  const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
  const after = ['a', 'b', 'X', 'Y', 'd', 'e'].join('\n');
  const d = diffTexts(before, after, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.added, 2);
  assert.deepEqual(d.lines, ['  b', '- c', '+ X', '+ Y', '  d']);
});

test('cache de lecture : list_directory mis en cache 60 s, invalidé par toute écriture', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fs-atg-cache-'));
  t.after(() => { clearReadCache(); return rm(root, { recursive: true, force: true }); });
  clearReadCache();
  await writeFile(join(root, 'a.txt'), 'a');
  const runner = createWorkspaceToolRunner({ workspaceRoot: root, permissionMode: 'acceptEdits', jobId: 'cache-test' });
  const call = (name, args) => runner.execute({ callId: name, name, arguments: args });

  const first = await call('list_directory', { path: '.' });
  assert.match(first.output, /a\.txt/);
  assert.equal(readCacheSize(), 1);

  // Modification hors runner : le cache sert encore l'ancienne liste
  await writeFile(join(root, 'b.txt'), 'b');
  const cached = await call('list_directory', { path: '.' });
  assert.equal(cached.output, first.output);

  // Une écriture via le runner invalide tout le cache
  const written = await call('write_file', { path: 'c.txt', content: 'c' });
  assert.ok(!written.isError, written.output);
  assert.equal(readCacheSize(), 0);
  const fresh = await call('list_directory', { path: '.' });
  assert.match(fresh.output, /b\.txt/);
  assert.match(fresh.output, /c\.txt/);
});

test('v2.2.1 : timeout outils locaux fixé à 240 s', () => {
  assert.equal(DEFAULT_TOOLS_STREAM_TIMEOUT_MS, 240_000);
});

test('v2.5.0 : catalogue MCP expose 24 outils dont la Suite IA Classique (fs_data, fs_research, fs_canvas, fs_vision, fs_arena, fs_doc, fs_voice, fs_schedule)', () => {
  const names = MCP_TOOL_CATALOG.map((t) => t.name);
  assert.equal(names.length, 24);
  for (const expected of [
    'fs_computer', 'fs_browser', 'fs_web', 'fs_system', 'fs_mcp_hub',
    'fs_data', 'fs_research', 'fs_canvas', 'fs_vision', 'fs_arena', 'fs_doc', 'fs_voice', 'fs_schedule',
  ]) {
    assert.ok(names.includes(expected), `Outil manquant : ${expected}`);
  }
});

test('v2.3.0 : validateComputerAction applique les permissions et bloque les raccourcis système dangereux', () => {
  assert.ok(COMPUTER_ACTIONS.includes('screenshot'));
  assert.equal(validateComputerAction({ action: 'screenshot' }, { permissionMode: 'plan' }), 'screenshot');
  assert.throws(
    () => validateComputerAction({ action: 'click', x: 10, y: 20 }, { permissionMode: 'plan' }),
    /Lecture seule/i
  );
  assert.throws(
    () => validateComputerAction({ action: 'click', x: 10, y: 20 }, { permissionMode: 'full', computerUseEnabled: false }),
    /désactivé/i
  );
  assert.throws(
    () => validateComputerAction({ action: 'hotkey', keys: 'Ctrl + Alt + Del' }, { permissionMode: 'full' }),
    /protégé refusé/i
  );
});

test('v2.3.0 : validateBrowserUrl et htmlToCleanMarkdown nettoient et sécurisent le contenu web', () => {
  assert.ok(BROWSER_ACTIONS.includes('snapshot'));
  assert.equal(validateBrowserUrl('example.com/docs'), 'https://example.com/docs');
  assert.throws(() => validateBrowserUrl('file:///C:/app/.env'), /sensible refusée/i);
  assert.throws(() => validateBrowserUrl('javascript:alert(1)'), /Protocole non autorisé/i);

  const md = htmlToCleanMarkdown(
    '<html><head><title>Doc &amp; API</title><script>evil()</script></head><body><h1>Bienvenue</h1><p>Texte <code>fs_browser</code></p><a href="/guide">Guide</a></body></html>',
    'https://ia.francestudent.org'
  );
  assert.equal(md.title, 'Doc & API');
  assert.match(md.markdown, /# Bienvenue/);
  assert.match(md.markdown, /`fs_browser`/);
  assert.doesNotMatch(md.markdown, /evil/);
  assert.equal(md.links[0].url, 'https://ia.francestudent.org/guide');
});

test('v2.3.0 : executeSystemAction overview retourne les métriques CPU/RAM/OS', async () => {
  const res = await executeSystemAction({ action: 'overview' });
  assert.equal(res.ok, true);
  assert.ok(res.cpuCores >= 1);
  assert.ok(res.memory.totalMb > 0);
});

test('v2.4.0 / v2.6.0 : Hub MCP contient 68+ connecteurs (6 catégories, stdio/HTTP/SSE, IDE auto-detect, Blender & Roblox)', async (t) => {
  assert.ok(MCP_HUB_CATALOG.length >= 60, `Attendu >= 60 connecteurs, reçu ${MCP_HUB_CATALOG.length}`);
  assert.equal(Object.keys(MCP_HUB_CATEGORIES).length, 6);
  const ids = MCP_HUB_CATALOG.map((c) => c.id);
  for (const mustHave of [
    'blender', 'roblox', 'unity', 'unreal', 'godot', 'figma', 'aseprite', 'minecraft', 'obs-studio', 'canva',
    'firecrawl', 'exa', 'tavily', 'perplexity', 'playwright', 'context7',
    'sequential-thinking', 'memory', 'qdrant', 'neo4j', 'duckdb',
    'postgres', 'sqlite', 'docker', 'github', 'stripe', 'home-assistant', 'n8n', 'obsidian', 'discord',
  ]) {
    assert.ok(ids.includes(mustHave), `Connecteur manquant : ${mustHave}`);
  }

  const dir = await mkdtemp(join(tmpdir(), 'fs-atg-hub-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configFilePath = join(dir, 'mcp_hub.json');

  const games = await executeMcpHubAction({ action: 'list', category: '3d-games', configFilePath });
  assert.equal(games.ok, true);
  assert.ok(games.count >= 12);

  const en1 = await executeMcpHubAction({ action: 'enable', connectorId: 'unity', configFilePath });
  assert.equal(en1.enabled, true);
  assert.equal(en1.enabledCount, 9);

  // Configuration d'un serveur MCP Streamable HTTP personnalisé
  const httpCfg = await executeMcpHubAction({
    action: 'configure',
    connectorId: 'custom-remote',
    name: 'Remote HTTP MCP',
    transport: 'http',
    url: 'https://mcp.example.com/v1',
    configFilePath,
  });
  assert.equal(httpCfg.ok, true);
  assert.equal(httpCfg.transport, 'http');

  const exported = await executeMcpHubAction({ action: 'export_config', configFilePath });
  assert.equal(exported.count, 10);
  assert.ok(exported.mcpServers.blender);
  assert.ok(exported.mcpServers.roblox);
  assert.ok(exported.mcpServers.unity);
  assert.equal(exported.mcpServers['custom-remote'].url, 'https://mcp.example.com/v1');

  const dis1 = await executeMcpHubAction({ action: 'disable', connectorId: 'unity', configFilePath });
  assert.equal(dis1.enabled, false);
  assert.equal(dis1.enabledCount, 9);

  const localScan = await executeMcpHubAction({ action: 'detect_local', workspaceRoot: dir, configFilePath });
  assert.equal(localScan.ok, true);
  assert.ok(localScan.sourcesScanned >= 7);

  const rojo = await executeRobloxBridge({ action: 'scaffold_rojo', workspaceRoot: dir }, { configFilePath });
  assert.equal(rojo.ok, true);
  assert.equal(rojo.filesCreated.length, 2);
});

test('v2.5.0 : Suite IA Classique (fs_data, fs_canvas, fs_vision, fs_arena, fs_doc, fs_voice, fs_schedule)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-atg-classic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. fs_data : profile, query, chart, run_js
  const csv = 'team,score\nAlpha,10\nBeta,30\nAlpha,20';
  const prof = await executeDataAction({ action: 'profile', data: csv });
  assert.equal(prof.rowCount, 3);
  assert.equal(prof.columns.score.type, 'number');
  assert.equal(prof.columns.score.mean, 20);

  const grouped = await executeDataAction({
    action: 'query',
    data: csv,
    groupBy: 'team',
    aggColumn: 'score',
    aggOp: 'sum',
    sortBy: 'sum',
    sortOrder: 'desc',
  });
  assert.equal(grouped.rows[0].team, 'Alpha');
  assert.equal(grouped.rows[0].sum, 30);

  const chart = await executeDataAction({
    action: 'chart',
    title: 'Scores',
    labels: ['Alpha', 'Beta'],
    values: [30, 30],
    outputPath: join(dir, 'scores.svg'),
  });
  assert.equal(chart.ok, true);
  assert.match(chart.svg, /<svg/);

  const jsRun = await executeDataAction({
    action: 'run_js',
    code: 'console.log(JSON.stringify({ sum: 21 + 21 }));',
  });
  assert.equal(jsRun.ok, true);
  assert.match(jsRun.stdout, /"sum":42/);

  // 2. fs_canvas : create, list, get
  const art = await executeCanvasAction({
    action: 'create',
    id: 'test-art',
    title: 'Test Canvas',
    type: 'mermaid',
    content: 'flowchart LR\nA --> B',
  });
  assert.equal(art.ok, true);
  assert.match(art.previewUrl, /^http:\/\/127\.0\.0\.1:\d+\//);
  const gotArt = await executeCanvasAction({ action: 'get', id: 'test-art' });
  assert.match(gotArt.content, /mermaid/);

  // 3. fs_vision : inspect_image sur un mini PNG 1x1
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const pngPath = join(dir, 'pixel.png');
  await writeFile(pngPath, png1x1);
  const imgInfo = await executeVisionAction({ action: 'inspect_image', path: pngPath });
  assert.equal(imgInfo.format, 'png');
  assert.equal(imgInfo.width, 1);
  assert.equal(imgInfo.height, 1);

  // 4. fs_arena : dry-run council selection
  const arena = await executeArenaAction({ prompt: 'Compare two architectures', dryRun: true });
  assert.equal(arena.ok, true);
  assert.ok(arena.selectedModels.length >= 2);

  // 5. fs_doc : extract & search
  const docPath = join(dir, 'cahier.md');
  await writeFile(
    docPath,
    '# Architecture\n\nLe moteur physique tourne à 120 Hz.\n\n# Réseau\n\nLa synchronisation Roblox utilise Rojo et Luau.'
  );
  const docSearch = await executeDocAction({ action: 'search', path: docPath, query: 'Rojo Luau', topK: 2 });
  assert.equal(docSearch.ok, true);
  assert.ok(docSearch.matchesCount >= 1);
  assert.match(docSearch.excerpts[0].text, /Rojo/);

  // 6. fs_voice : dry-run speak
  const voice = await executeVoiceAction({ action: 'speak', text: 'Test vocal', dryRun: true });
  assert.equal(voice.ok, true);
  assert.equal(voice.spoken, 'Test vocal');

  // 7. fs_schedule : add, list, run_now, remove
  const schedFile = join(dir, 'schedules.json');
  const added = await executeScheduleAction({
    action: 'add',
    name: 'Veille Cahier',
    kind: 'file',
    target: docPath,
    intervalSec: 30,
    startTimer: false,
    configFilePath: schedFile,
  });
  assert.equal(added.ok, true);
  assert.equal(added.total, 1);

  const ran = await executeScheduleAction({
    action: 'run_now',
    id: added.schedule.id,
    configFilePath: schedFile,
  });
  assert.equal(ran.result.ok, true);

  const removed = await executeScheduleAction({
    action: 'remove',
    id: added.schedule.id,
    configFilePath: schedFile,
  });
  assert.equal(removed.remaining, 0);
});

test('v2.6.0 : tri automatique universel des modèles (actuels & futurs) du plus fort au plus faible', () => {
  assert.equal(extractModelVersion('gpt-6.2-astra'), 6.2);
  assert.equal(extractModelVersion('claude-opus-5-5'), 5.5);
  assert.equal(extractModelVersion('claude-opus-7'), 7);
  assert.equal(extractModelVersion('ministral-14b-latest'), 0);

  const st = { ...DEFAULT_STATE, modelPolicies: {}, blockedModels: [], allowedModels: [], knownModels: {} };
  const unseenFuture = [
    'ministral-14b-latest',
    'gemini-4-flash',
    'claude-sonnet-6',
    'claude-haiku-6',
    'gpt-7.1-astra',
    'claude-opus-7',
    'gpt-6.1-sol',
    'gpt-6.2-sol',
  ];
  const catalog = enrichModelsCatalog(unseenFuture, new Map(), st, [], { persist: false });
  const orderedIds = catalog.map((m) => m.id);

  // Toujours strictement du plus puissant au plus léger (même quand un modèle léger est "Nouveau")
  assert.equal(orderedIds[0], 'claude-opus-7');
  assert.equal(orderedIds[1], 'gpt-7.1-astra');
  assert.ok(orderedIds.indexOf('gpt-6.2-sol') < orderedIds.indexOf('gpt-6.1-sol'));
  assert.ok(orderedIds.indexOf('gpt-6.1-sol') < orderedIds.indexOf('claude-sonnet-6'));
  assert.ok(orderedIds.indexOf('claude-sonnet-6') < orderedIds.indexOf('claude-haiku-6'));
  assert.ok(orderedIds.indexOf('claude-haiku-6') < orderedIds.indexOf('gemini-4-flash'));
  assert.equal(orderedIds[orderedIds.length - 1], 'ministral-14b-latest');
  assert.equal(catalog.find((m) => m.id === 'ministral-14b-latest').tier, 'light');
  assert.equal(catalog.find((m) => m.id === 'ministral-14b-latest').isNew, true);
  assert.equal(catalog[0].powerRank, 1);
  assert.ok(scoreModelPower('claude-opus-7') > scoreModelPower('gpt-7.1-astra'));
  assert.deepEqual(rankModelsBestToWorst(['gemini-4-flash', 'claude-opus-7', 'claude-sonnet-6'], st), [
    'claude-opus-7',
    'claude-sonnet-6',
    'gemini-4-flash',
  ]);
});

test('v2.6.0 : routage intelligent & déclencheurs natifs Web Search / Canvas / Images IA', () => {
  const models = ['claude-opus-5-5', 'gpt-6.2-astra', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-6-luna'];
  const st = { ...DEFAULT_STATE, routingProfile: 'quality', smartRouting: true, modelPolicies: {}, blockedModels: [], allowedModels: [] };

  // 1. Recherche web pure -> modèle léger suffit + enableWebSearch: true !
  const webRoute = pickModel('cherche sur internet les actualités IA 2026', models, st);
  assert.equal(webRoute.model, 'claude-haiku-5-5');
  assert.equal(webRoute.intent, 'web_research');
  assert.equal(webRoute.enableWebSearch, true);
  assert.equal(webRoute.enableCanvas, false);

  // 2. Canvas / artefact interactif -> modèle équilibré + enableCanvas: true !
  const canvasRoute = pickModel('crée un canvas interactif pour un tableau de bord ventes', models, st);
  assert.equal(canvasRoute.model, 'claude-sonnet-5-5');
  assert.equal(canvasRoute.intent, 'canvas_artifact');
  assert.equal(canvasRoute.enableCanvas, true);

  // 3. Refactoring architecture lourde avec écriture disque (clientTools) -> modèle fort + Canvas off !
  const heavyDiskRoute = pickModel('refactorise l architecture sécurité multi-fichiers du backend', models, st, undefined, {
    workspaceRoot: 'C:/tmp/proj',
    useClientTools: true,
  });
  assert.equal(heavyDiskRoute.model, 'claude-opus-5-5');
  assert.equal(heavyDiskRoute.enableCanvas, false);

  // 3b. Code simple dans le panneau (sans écriture disque) -> Canvas ON par défaut pour copier le code facilement !
  const simpleCodeRoute = pickModel('écris une fonction fibonacci en JS', models, st);
  assert.equal(simpleCodeRoute.enableCanvas, true);

  // 4. Génération d'image -> modèle léger + enableImageGen: true !
  const imgRoute = pickModel('génère une image photoréaliste d un astronome', models, st);
  assert.equal(imgRoute.model, 'claude-haiku-5-5');
  assert.equal(imgRoute.enableImageGen, true);

  // 5. Directives slash explicites (/search, /canvas, /noweb, /nocanvas, /max)
  const d1 = parseTaskDirectives('/search /canvas crée une infographie comparative');
  assert.equal(d1.webSearchMode, 'on');
  assert.equal(d1.canvasMode, 'on');
  const maxWeb = pickModel('/max /search actualités Rust 2026', models, st);
  assert.equal(maxWeb.model, 'claude-opus-5-5');
  assert.equal(maxWeb.enableWebSearch, true);

  // 6. analyzeTaskIntent respecte les surcharges off/on
  const forcedOff = analyzeTaskIntent('cherche sur internet les news 2026', { webSearchMode: 'off', canvasMode: 'on' });
  assert.equal(forcedOff.enableWebSearch, false);
  assert.equal(forcedOff.enableCanvas, false); // pure web lookup keeps Canvas off unless explicitCanvas
  const forcedCanvas = analyzeTaskIntent('cherche sur internet les news 2026', { webSearchMode: 'off', canvasMode: 'on', explicitCanvas: true });
  assert.equal(forcedCanvas.enableCanvas, true);

  // 7. Prompts simplifiés & annulation cross-process des agents actifs
  assert.equal(buildReasoningDirective('deep'), '');
  assert.ok(buildReasoningDirective('max').length < 100);
  const testJobId = `cancel-test-${Date.now()}`;
  assert.equal(isJobCancelRequested(testJobId), false);
  requestCancelJob(testJobId);
  assert.equal(isJobCancelRequested(testJobId), true);
  clearCancelRequest(testJobId);
  assert.equal(isJobCancelRequested(testJobId), false);
});

