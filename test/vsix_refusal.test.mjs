import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

async function loadVsixApi() {
  const dir = await mkdtemp(join(tmpdir(), 'fs-atg-vsix-api-'));
  const outfile = join(dir, 'api.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/api.ts', import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['vscode'],
    outfile,
  });

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { api: require(outfile), dispose: () => rm(dir, { recursive: true, force: true }) };
  } finally {
    Module._load = originalLoad;
  }
}

function sse(events) {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

test('VSIX : un refus est seulement reconnu via un signal fournisseur explicite', async t => {
  const { api, dispose } = await loadVsixApi();
  t.after(dispose);

  assert.equal(api.MISSING_REFUSAL_REASON, 'motif non fourni par le fournisseur');
  assert.equal(
    api.modelRefusalReason({ type: 'response.output_refusal.delta' }),
    api.MISSING_REFUSAL_REASON,
  );
  assert.equal(
    api.modelRefusalReason({ type: 'response.completed', response: { status: 'refused' } }),
    api.MISSING_REFUSAL_REASON,
  );
  assert.equal(
    api.modelRefusalReason({ type: 'error', message: 'policy cache temporarily unavailable' }),
    undefined,
  );
  assert.equal(
    api.modelRefusalReason("I'm sorry, but I can't comply with that request.", true),
    "I'm sorry, but I can't comply with that request.",
  );
});

test('VSIX : response.output_refusal conserve le motif complet et marque un motif absent', async t => {
  const { api, dispose } = await loadVsixApi();
  t.after(dispose);
  const originalFetch = globalThis.fetch;
  const secrets = { get: async () => 'test-key', store: async () => undefined, delete: async () => undefined };

  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_refusal.delta', delta: 'Sorry, ' },
    { type: 'response.output_refusal.delta', delta: "I can't comply with that request." },
    { type: 'response.completed', response: { id: 'rsp-1' } },
  ]), { status: 200 });
  try {
    const client = new api.FranceStudentClient(secrets);
    const result = await client.streamResponse({
      model: 'provider-model', instructions: 'Réponds.', parts: [{ type: 'input_text', text: 'Bonjour' }],
      reasoning: false, signal: new AbortController().signal,
    }, {});
    assert.equal(result.refusalReason, "Sorry, I can't comply with that request.");

    globalThis.fetch = async () => new Response(sse([
      { type: 'response.output_refusal.delta', delta: '' },
      { type: 'response.completed', response: { id: 'rsp-2' } },
    ]), { status: 200 });
    const missing = await client.streamResponse({
      model: 'provider-model', instructions: 'Réponds.', parts: [{ type: 'input_text', text: 'Bonjour' }],
      reasoning: false, signal: new AbortController().signal,
    }, {});
    assert.equal(missing.refusalReason, api.MISSING_REFUSAL_REASON);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('VSIX : le flux chat reconnaît aussi response.output_refusal sans motif', async t => {
  const { api, dispose } = await loadVsixApi();
  t.after(dispose);
  const originalFetch = globalThis.fetch;
  const secrets = { get: async () => 'test-key', store: async () => undefined, delete: async () => undefined };
  globalThis.fetch = async () => new Response(sse([
    { type: 'stream.open', chat_id: 'chat-refusal' },
    { type: 'response.output_refusal.delta', delta: '' },
    { type: 'completed' },
  ]), { status: 200 });
  try {
    const client = new api.FranceStudentClient(secrets);
    const result = await client.streamResponse({
      model: 'gpt-5.6-terra', instructions: 'Réponds.', parts: [{ type: 'input_text', text: 'Bonjour' }],
      reasoning: false, signal: new AbortController().signal,
    }, {});
    assert.equal(result.responseId, 'chat-refusal');
    assert.equal(result.refusalReason, api.MISSING_REFUSAL_REASON);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
