import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  getModelTelemetry,
  parseTaskDirectives,
  pickModel,
  DEFAULT_STATE,
  recordModelTelemetry,
  TELEMETRY_MAX_SAMPLES,
  TELEMETRY_WINDOW_MS,
} from '../plugin/fs_core.mjs';
import { clearReadCache, createWorkspaceToolRunner, diffTexts, readCacheSize } from '../plugin/tools_engine.mjs';

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
