import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  acquireGlobalSlot,
  ANTIGRAVITY_QUOTA_VISIBILITY,
  compactCatalog,
  clientToolsForExecutionMode,
  defaultModelsBundle,
  fetchChatStreamMetrics,
  fetchModelCatalog,
  fetchRemoteCatalog,
  globalSlotStatus,
  liveJobsFromSnapshot,
  MISSING_REFUSAL_REASON,
  MCP_TOOL_CATALOG,
  OFFICIAL_API_BASE_URL,
  normalizeProviderTokenUsage,
  normalizeRoutingProfile,
  parseTaskDirectives,
  pickModel,
  refusalReasonFromEvent,
  refusalReasonFromText,
  resolveSafe,
  sameTierFallbackModels,
  streamGeneration,
  streamGenerationWithRefusalFallback,
  tokenMeasurementForPrompt,
  formatWorkspaceSymbolIndex,
  workspaceSymbolIndex,
} from '../plugin/fs_core.mjs';

const state = {
  apiKey: 'test-key',
  showReasoning: false,
  useClientTools: true,
  allowedModels: [],
  blockedModels: [],
  tiers: {
    light: ['luna'],
    medium: ['sonnet'],
    heavy: ['opus'],
  },
};

test('le connecteur publie sa surface sans prétendre lire le quota Antigravity', () => {
  assert.equal(OFFICIAL_API_BASE_URL, 'https://api.francestudent.ai');
  assert.equal(ANTIGRAVITY_QUOTA_VISIBILITY.available, false);
  assert.match(ANTIGRAVITY_QUOTA_VISIBILITY.source, /\/usage/);
  assert.equal(MCP_TOOL_CATALOG.filter((tool) => tool.name === 'fs_status').length, 1);
  assert.equal(MCP_TOOL_CATALOG.length, 10);
});

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function sseWithIds(entries) {
  return entries.map(({ id, event }) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function interruptedSse(text) {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(text));
        return;
      }
      controller.error(new TypeError('connexion interrompue'));
    },
  });
}

test('le routeur retire la commande de niveau sans l’envoyer au modèle', () => {
  const route = pickModel('/faible corrige le libellé', ['claude-sonnet', 'gpt-luna'], state);
  assert.equal(route.model, 'gpt-luna');
  assert.equal(route.prompt, 'corrige le libellé');
  assert.match(route.reason, /faible/);
});

test('les commandes /medium, /fable, /gpt et /send restent locales', () => {
  const models = ['gpt-5.6-luna', 'gpt-5.6-terra', 'claude-sonnet', 'claude-fable'];
  assert.equal(pickModel('/medium analyse ce bug', models, state).model, 'gpt-5.6-terra');
  assert.equal(pickModel('/fable refactorise le module', models, state).model, 'claude-fable');
  assert.equal(pickModel('/gpt corrige le test', models, state).prompt, 'corrige le test');
  assert.equal(pickModel('/send corrige le test', models, state).prompt, 'corrige le test');
});

test('les commandes courtes /low et /high choisissent leurs gammes locales', () => {
  const models = ['gpt-5.6-luna', 'gpt-5.6-terra', 'claude-fable'];
  const tierState = { ...state, tiers: { light: ['luna'], medium: ['terra'], heavy: ['fable'] } };
  assert.equal(pickModel('/low corrige le test', models, tierState).model, 'gpt-5.6-luna');
  assert.equal(pickModel('/high audite le module', models, tierState).model, 'claude-fable');
});

test('les profils, /plan et /dry-run restent des directives locales', () => {
  const directives = parseTaskDirectives('/plan /security /fable audite src/auth');
  assert.deepEqual(directives, {
    prompt: 'audite src/auth',
    tagModel: undefined,
    requested: { kind: 'model', value: 'fable' },
    profile: 'security',
    executionMode: 'plan',
  });
  assert.equal(parseTaskDirectives('/dry-run propose un patch').executionMode, 'dry-run');
  assert.equal(normalizeRoutingProfile('sécurité'), 'security');
  assert.equal(normalizeRoutingProfile('non-existant'), null);
});

test('un profil choisit sa gamme sans modifier la demande envoyée', () => {
  const models = ['gpt-luna', 'claude-sonnet', 'claude-opus'];
  const route = pickModel('/quality réécris le module', models, state);
  assert.equal(route.model, 'claude-opus');
  assert.equal(route.prompt, 'réécris le module');
  assert.equal(route.profile, 'quality');
  assert.equal(route.executionMode, 'apply');
  assert.match(route.reason, /profil quality/);
  assert.equal(pickModel('[light] corrige le libellé', models, state).model, 'gpt-luna');
});

test('plan et dry-run retirent strictement les outils d’écriture', () => {
  const all = ['list_directory', 'read_file', 'search_files', 'edit_file', 'write_file'];
  assert.deepEqual(clientToolsForExecutionMode(all, 'plan'), ['list_directory', 'read_file', 'search_files']);
  assert.deepEqual(clientToolsForExecutionMode(all, 'dry-run'), ['list_directory', 'read_file', 'search_files']);
  assert.deepEqual(clientToolsForExecutionMode(all, 'apply'), all);
});

test('l’index intelligent ne transmet que chemins, symboles et imports', () => {
  const root = fileURLToPath(new URL('./fixtures/mini-app/', import.meta.url));
  const entries = workspaceSymbolIndex(root, 20);
  const app = entries.find((entry) => entry.path === 'src/app.js');
  assert.ok(app);
  assert.ok(app.symbols.includes('renderTask'));
  const formatted = formatWorkspaceSymbolIndex(entries);
  assert.match(formatted, /src\/app\.js/);
  assert.doesNotMatch(formatted, /document\.createElement|Persist tasks/);
  assert.ok(formatted.length <= 6_000);
});

test('la mesure de tokens distingue estimation locale et usage fournisseur', () => {
  assert.deepEqual(normalizeProviderTokenUsage({ prompt_tokens: 13, completion_tokens: 8, total_tokens: 21 }), {
    source: 'provider', inputTokens: 13, outputTokens: 8, totalTokens: 21,
  });
  assert.equal(normalizeProviderTokenUsage({}), null);
  const measurement = tokenMeasurementForPrompt('bonjour monde', { input_tokens: 4, output_tokens: 2 });
  assert.equal(measurement.localPromptEstimateTokens, 4);
  assert.deepEqual(measurement.providerUsage, { source: 'provider', inputTokens: 4, outputTokens: 2 });
});

test('le sémaphore local partage une seule place en mode éco', async () => {
  const eco = { mode: 'eco', maxParallel: 6 };
  const lease = await acquireGlobalSlot(eco, `test-${Date.now()}`, new AbortController().signal);
  try {
    const slots = globalSlotStatus(eco);
    assert.equal(slots.limit, 1);
    assert.ok(slots.active >= 1);
  } finally {
    lease.release();
  }
});

test('le résolveur bloque les sorties explicites du workspace', () => {
  assert.throws(() => resolveSafe(process.cwd(), '../secret.txt'), /hors workspace/);
  assert.throws(() => resolveSafe(process.cwd(), 'C:\\Windows\\win.ini'), /hors workspace/);
});

test('les prompts envoyés restent formulés comme une demande humaine', () => {
  const mcp = readFileSync(new URL('../plugin/mcp_server.mjs', import.meta.url), 'utf8');
  const orchestrator = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../plugin/fs_core.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(mcp, /Tu es un agent de code délégué/);
  assert.doesNotMatch(orchestrator, /Tu es un agent de code délégué/);
  assert.doesNotMatch(core, /text:\s*`\$\{ATG\}\s*\$\{prompt\}`/);
});

test('un chat persistant ne renvoie pas le résumé parent', () => {
  const mcp = readFileSync(new URL('../plugin/mcp_server.mjs', import.meta.url), 'utf8');
  assert.match(mcp, /if \(job\.parentId && !hasPersistentChat\)/);
  assert.match(mcp, /addLocalContext\(route\.prompt, job, st, Boolean\(chatId\)\)/);
});

test('un chat existant reçoit seulement la nouvelle demande', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response(sse([
      { type: 'stream.open', chat_id: 'chat-42' },
      { type: 'response.output_text.delta', delta: 'Terminé.' },
      { type: 'completed', message: { content: 'Terminé.' } },
    ]), { status: 200 });
  };
  try {
    const result = await streamGeneration({
      state,
      model: 'claude-sonnet',
      agentMap: new Map([['claude-sonnet', 17]]),
      instructions: 'INSTRUCTIONS INITIALES',
      prompt: 'Corrige seulement src/api.ts',
      chatId: 'chat-42',
      signal: new AbortController().signal,
    });
    assert.equal(request.url, 'https://api.francestudent.ai/chats/chat-42');
    assert.deepEqual(request.body, { content: 'Corrige seulement src/api.ts', agentId: 17 });
    assert.equal(result.chatId, 'chat-42');
    assert.equal(result.text, 'Terminé.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('le premier tour initialise le chat avec les règles une seule fois', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response(sse([
      { type: 'stream.open', chat_id: 'chat-new' },
      { type: 'completed', message: { content: 'Prêt.' } },
    ]), { status: 200 });
  };
  try {
    const result = await streamGeneration({
      state,
      model: 'claude-sonnet',
      agentMap: new Map([['claude-sonnet', 17]]),
      instructions: 'INSTRUCTIONS INITIALES',
      prompt: 'Crée le fichier demandé',
      signal: new AbortController().signal,
    });
    assert.equal(request.url, 'https://api.francestudent.ai/chats/stream');
    assert.equal(request.body.initialContent, 'INSTRUCTIONS INITIALES\n\nTâche initiale :\nCrée le fichier demandé');
    assert.equal(result.chatId, 'chat-new');
    assert.equal(result.text, 'Prêt.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un stream expose estimation locale et usage réellement fourni par le fournisseur', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sse([
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 } } },
  ]), { status: 200 });
  try {
    const result = await streamGeneration({
      state,
      model: 'provider-model',
      instructions: 'Réponds.',
      prompt: 'Bonjour',
      signal: new AbortController().signal,
    });
    assert.equal(result.tokenMeasurement.localPromptEstimateTokens, 2);
    assert.deepEqual(result.tokenMeasurement.providerUsage, {
      source: 'provider', inputTokens: 9, outputTokens: 2, totalTokens: 11,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un flux chat ne transforme pas les mesures absentes en zéros', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sse([
    { type: 'stream.open', chat_id: 'chat-usage-partiel' },
    { type: 'completed', message: { content: 'OK', tokenUsage: { totalTokenCount: 7 } } },
  ]), { status: 200 });
  try {
    const result = await streamGeneration({
      state,
      model: 'claude-sonnet',
      agentMap: new Map([['claude-sonnet', 17]]),
      instructions: 'Réponds.',
      prompt: 'Bonjour',
      signal: new AbortController().signal,
    });
    assert.deepEqual(result.usage, { total_tokens: 7 });
    assert.deepEqual(result.tokenMeasurement.providerUsage, {
      source: 'provider', totalTokens: 7,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('le catalogue modèles retombe sur /v1/models si /models est indisponible', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    if (new URL(String(url)).pathname === '/models') return new Response('indisponible', { status: 404 });
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 });
  };
  try {
    const catalog = await fetchModelCatalog(state);
    assert.equal(catalog.available, true);
    assert.equal(catalog.source, '/v1/models');
    assert.deepEqual(catalog.models, [{ id: 'model-a' }]);
    assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET']);
    assert.deepEqual(calls.map((call) => call.url), [
      'https://api.francestudent.ai/models',
      'https://api.francestudent.ai/v1/models',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('les catalogues distants restent GET-only et isolent un endpoint non offert', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init.method });
    if (path === '/mcp/servers') return new Response('absent', { status: 404 });
    return new Response(JSON.stringify({ items: [{ id: path.slice(1) }] }), { status: 200 });
  };
  try {
    const catalog = await fetchRemoteCatalog(state, 'all');
    assert.deepEqual(calls.map((call) => call.path).sort(), ['/filesv2', '/mcp/servers', '/projects', '/skills']);
    assert.ok(calls.every((call) => call.method === 'GET'));
    assert.equal(catalog.skills.source, '/skills');
    assert.deepEqual(catalog.files.items, [{ id: 'filesv2' }]);
    assert.equal(catalog.mcpServers.available, false);
    assert.match(catalog.mcpServers.error, /HTTP 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('les métriques de flux absentes ne bloquent pas le plugin', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('inconnu', { status: 404 });
  try {
    assert.deepEqual(await fetchChatStreamMetrics(state), {
      available: false,
      source: '/metrics/chat-streams',
      metrics: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('le catalogue compacté ne déverse pas une liste entière dans le contexte', () => {
  const compacted = compactCatalog({ large: Array.from({ length: 80 }, (_, n) => ({ n, text: 'x'.repeat(800) })) });
  assert.equal(compacted.large.length, 60);
  assert.equal(compacted.large[0].text.length, 601);
});

test('une SSE interrompue se rattache une fois avec Last-Event-ID', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) {
      return new Response(interruptedSse(sseWithIds([
        { id: 'evt-1', event: { type: 'stream.open', chat_id: 'chat-recover' } },
        { id: 'evt-2', event: { type: 'response.output_text.delta', delta: 'Bon' } },
      ])), { status: 200 });
    }
    return new Response(sseWithIds([
      { id: 'evt-3', event: { type: 'response.output_text.delta', delta: 'jour' } },
      { id: 'evt-4', event: { type: 'completed', message: { content: 'Bonjour' } } },
    ]), { status: 200 });
  };
  try {
    const result = await streamGeneration({
      state,
      model: 'claude-sonnet',
      agentMap: new Map([['claude-sonnet', 17]]),
      instructions: 'Règles initiales',
      prompt: 'Réponds bonjour',
      signal: new AbortController().signal,
    });
    assert.equal(result.text, 'Bonjour');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, 'https://api.francestudent.ai/chats/chat-recover/stream');
    assert.equal(new Headers(requests[1].init.headers).get('Last-Event-ID'), 'evt-2');
    assert.equal(requests[1].init.method, 'GET');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('une fermeture SSE sans événement terminal se rattache aussi une fois', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) {
      // The stream ends normally at the transport layer but lacks `completed`.
      return new Response(sseWithIds([
        { id: 'evt-close-1', event: { type: 'stream.open', chat_id: 'chat-close' } },
        { id: 'evt-close-2', event: { type: 'response.output_text.delta', delta: 'Bon' } },
      ]), { status: 200 });
    }
    return new Response(sseWithIds([
      { id: 'evt-close-3', event: { type: 'response.output_text.delta', delta: 'jour' } },
      { id: 'evt-close-4', event: { type: 'completed', message: { content: 'Bonjour' } } },
    ]), { status: 200 });
  };
  try {
    const result = await streamGeneration({
      state,
      model: 'claude-sonnet',
      agentMap: new Map([['claude-sonnet', 17]]),
      instructions: 'Règles initiales',
      prompt: 'Réponds bonjour',
      signal: new AbortController().signal,
    });
    assert.equal(result.text, 'Bonjour');
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[1].init.headers).get('Last-Event-ID'), 'evt-close-2');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('une erreur métier SSE ne déclenche pas de rattachement', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(sseWithIds([
      { id: 'evt-error', event: { type: 'stream.open', chat_id: 'chat-error' } },
      { id: 'evt-error-2', event: { type: 'error', message: 'requête refusée' } },
    ]), { status: 200 });
  };
  try {
    await assert.rejects(
      () => streamGeneration({
        state,
        model: 'claude-sonnet',
        agentMap: new Map([['claude-sonnet', 17]]),
        instructions: 'Règles initiales',
        prompt: 'Réponds bonjour',
        signal: new AbortController().signal,
      }),
      /requête refusée/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('le repli ne propose que le prochain modèle autorisé de la même gamme', () => {
  const retryState = {
    ...state,
    tiers: { light: ['luna'], medium: ['sonnet', 'terra'], heavy: ['opus'] },
  };
  assert.deepEqual(
    sameTierFallbackModels('claude-sonnet', ['claude-sonnet', 'gpt-terra', 'gpt-luna', 'claude-opus'], retryState),
    ['gpt-terra'],
  );
});

test('la détection de refus conserve le motif fournisseur sans inventer de refus', () => {
  assert.equal(
    refusalReasonFromEvent({ type: 'response.refusal.delta', delta: 'Motif fournisseur exact.' }),
    'Motif fournisseur exact.',
  );
  assert.equal(refusalReasonFromEvent({ type: 'response.refusal.delta' }), MISSING_REFUSAL_REASON);
  assert.equal(refusalReasonFromEvent({ type: 'error', message: 'requête refusée' }), null);
  assert.equal(refusalReasonFromText('Cette réponse mentionne un refus mais fournit une solution.'), null);
  assert.equal(refusalReasonFromText('Je ne peux pas vous aider avec cette demande.'), 'Je ne peux pas vous aider avec cette demande.');
});

test('un refus structuré relance une fois un modèle de même gamme dans un chat neuf', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const retries = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (requests.length === 1) {
      return new Response(sse([
        { type: 'stream.open', chat_id: 'chat-refuse' },
        { type: 'response.refusal.delta', delta: 'Motif fournisseur exact.' },
      ]), { status: 200 });
    }
    return new Response(sse([
      { type: 'stream.open', chat_id: 'chat-retry' },
      { type: 'response.output_text.delta', delta: 'Terminé.' },
      { type: 'completed', message: { content: 'Terminé.' } },
    ]), { status: 200 });
  };
  try {
    const retryState = { ...state, tiers: { light: ['luna'], medium: ['sonnet', 'terra'], heavy: ['opus'] } };
    const result = await streamGenerationWithRefusalFallback({
      state: retryState,
      model: 'claude-sonnet',
      availableModels: ['claude-sonnet', 'gpt-terra', 'gpt-luna'],
      agentMap: new Map([['claude-sonnet', 17], ['gpt-terra', 18], ['gpt-luna', 19]]),
      instructions: 'Règles initiales',
      prompt: 'Écris le correctif.',
      signal: new AbortController().signal,
      onRetry: (retry) => retries.push(retry),
    });
    assert.equal(result.model, 'gpt-terra');
    assert.deepEqual(result.refusals, [{ model: 'claude-sonnet', reason: 'Motif fournisseur exact.' }]);
    assert.deepEqual(retries, [{ from: 'claude-sonnet', to: 'gpt-terra', reason: 'Motif fournisseur exact.', attempt: 2 }]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://api.francestudent.ai/chats/stream');
    assert.equal(requests[1].url, 'https://api.francestudent.ai/chats/stream');
    assert.equal(requests[0].body.agentId, 17);
    assert.equal(requests[1].body.agentId, 18);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un second refus de la même gamme termine avec les deux motifs réels', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(sse([
      { type: 'stream.open', chat_id: `chat-${calls}` },
      { type: 'response.refusal.delta', delta: `Motif ${calls}.` },
    ]), { status: 200 });
  };
  try {
    const retryState = { ...state, tiers: { light: ['luna'], medium: ['sonnet', 'terra'], heavy: ['opus'] } };
    await assert.rejects(
      () => streamGenerationWithRefusalFallback({
        state: retryState,
        model: 'claude-sonnet',
        availableModels: ['claude-sonnet', 'gpt-terra'],
        agentMap: new Map([['claude-sonnet', 17], ['gpt-terra', 18]]),
        instructions: 'Règles initiales',
        prompt: 'Écris le correctif.',
        signal: new AbortController().signal,
      }),
      (error) => {
        assert.equal(error.message, 'Motif 2.');
        assert.deepEqual(error.refusals, [
          { model: 'claude-sonnet', reason: 'Motif 1.' },
          { model: 'gpt-terra', reason: 'Motif 2.' },
        ]);
        return true;
      },
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('une erreur réseau ou un appel outil ne déclenche jamais de changement de modèle', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError('réseau indisponible');
  };
  try {
    await assert.rejects(
      () => streamGenerationWithRefusalFallback({
        state,
        model: 'claude-sonnet',
        availableModels: ['claude-sonnet', 'gpt-luna'],
        agentMap: new Map([['claude-sonnet', 17], ['gpt-luna', 18]]),
        instructions: 'Règles initiales',
        prompt: 'Écris le correctif.',
        signal: new AbortController().signal,
      }),
      /réseau indisponible/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un refus après un outil de lecture relance une fois la même gamme', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (requests.length === 1) {
      return new Response(sse([
        { type: 'stream.open', chat_id: 'chat-tool' },
        { type: 'completed', message: { toolCalls: [{ callId: 'tool-1', name: 'list_directory', arguments: { path: '.', depth: 1 } }] } },
      ]), { status: 200 });
    }
    if (requests.length === 2) {
      return new Response(sse([
        { type: 'response.refusal.delta', delta: 'Motif après outil lecture.' },
      ]), { status: 200 });
    }
    return new Response(sse([
      { type: 'stream.open', chat_id: 'chat-tool-retry' },
      { type: 'completed', message: { content: 'Terminé après reprise.' } },
    ]), { status: 200 });
  };
  try {
    const result = await streamGenerationWithRefusalFallback({
      state: { ...state, tiers: { light: ['luna'], medium: ['sonnet', 'terra'], heavy: ['opus'] } },
      model: 'claude-sonnet',
      availableModels: ['claude-sonnet', 'gpt-terra'],
      agentMap: new Map([['claude-sonnet', 17], ['gpt-terra', 18]]),
      instructions: 'Règles initiales',
      prompt: 'Écris le correctif.',
      workspaceRoot: process.cwd(),
      clientTools: ['list_directory'],
      signal: new AbortController().signal,
    });
    assert.equal(result.model, 'gpt-terra');
    assert.deepEqual(result.refusals, [{ model: 'claude-sonnet', reason: 'Motif après outil lecture.' }]);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].url, 'https://api.francestudent.ai/chats/chat-tool');
    assert.equal(requests[2].url, 'https://api.francestudent.ai/chats/stream');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un outil d ecriture non offert ne peut pas ecrire dans un dry-run local', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const forbiddenPath = `.fs-atg-denied-tool-${process.pid}-${Date.now()}.txt`;
  const forbiddenAbsolute = new URL(`../${forbiddenPath}`, import.meta.url);
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (requests.length === 1) {
      return new Response(sse([
        { type: 'stream.open', chat_id: 'chat-denied-tool' },
        { type: 'completed', message: { toolCalls: [{ callId: 'denied-1', name: 'write_file', arguments: { path: forbiddenPath, content: 'must-not-exist' } }] } },
      ]), { status: 200 });
    }
    return new Response(sse([
      { type: 'completed', message: { content: 'Aucune ecriture effectuee.' } },
    ]), { status: 200 });
  };
  try {
    await streamGeneration({
      state,
      model: 'claude-sonnet',
      agentMap: new Map([['claude-sonnet', 17]]),
      instructions: 'Propose un plan sans ecriture.',
      prompt: 'Prepare une simulation.',
      workspaceRoot: process.cwd(),
      clientTools: ['list_directory', 'read_file', 'search_files'],
      signal: new AbortController().signal,
    });
    assert.equal(existsSync(forbiddenAbsolute), false);
    assert.equal(requests.length, 2);
    assert.match(requests[1].body.toolResults[0].output, /non autorise/);
    assert.equal(requests[1].body.toolResults[0].isError, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (existsSync(forbiddenAbsolute)) unlinkSync(forbiddenAbsolute);
  }
});

test('un refus apres une ecriture locale ne relance jamais un autre modele', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const writtenPath = `.fs-atg-write-retry-${process.pid}-${Date.now()}.txt`;
  const writtenAbsolute = new URL(`../${writtenPath}`, import.meta.url);
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (requests.length === 1) {
      return new Response(sse([
        { type: 'stream.open', chat_id: 'chat-write-tool' },
        { type: 'completed', message: { toolCalls: [{ callId: 'write-1', name: 'write_file', arguments: { path: writtenPath, content: 'written once' } }] } },
      ]), { status: 200 });
    }
    return new Response(sse([
      { type: 'response.refusal.delta', delta: 'Motif apres ecriture.' },
    ]), { status: 200 });
  };
  try {
    await assert.rejects(
      () => streamGenerationWithRefusalFallback({
        state,
        model: 'claude-sonnet',
        availableModels: ['claude-sonnet', 'gpt-luna'],
        agentMap: new Map([['claude-sonnet', 17], ['gpt-luna', 18]]),
        instructions: 'Ecris le correctif.',
        prompt: 'Fais une ecriture.',
        workspaceRoot: process.cwd(),
        clientTools: ['write_file'],
        signal: new AbortController().signal,
      }),
      /Motif apres ecriture/,
    );
    assert.equal(requests.length, 2);
    assert.equal(existsSync(writtenAbsolute), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (existsSync(writtenAbsolute)) unlinkSync(writtenAbsolute);
  }
});

test('les jobs MCP obsolètes disparaissent du panneau après le TTL', () => {
  const now = 2_000_000;
  const jobs = [{ jobId: 'still-running', status: 'running' }];
  assert.deepEqual(liveJobsFromSnapshot({ heartbeatAt: now - 5_000, jobs }, now), jobs);
  assert.deepEqual(liveJobsFromSnapshot({ heartbeatAt: now - 31_000, jobs }, now), []);
  assert.deepEqual(liveJobsFromSnapshot(jobs, now, now - 5_000), jobs);
  assert.deepEqual(liveJobsFromSnapshot(jobs, now, now - 31_000), []);
});

test('la liste locale de secours ne se présente pas comme une disponibilité API', () => {
  const fallback = defaultModelsBundle();
  assert.equal(fallback.available, false);
  assert.equal(fallback.source, 'local-fallback');
  assert.ok(fallback.ids.length > 0);
});
