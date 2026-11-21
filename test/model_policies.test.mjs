import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_STATE,
  enrichModelsCatalog,
  getModelPolicy,
  groupModelsByTier,
  MODEL_POLICIES,
  modelIsAllowed,
  pickModel,
  rankModelsBestToWorst,
} from '../plugin/fs_core.mjs';

const AVAILABLE = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'gpt-6.2-astra',
];

function makeState(overrides = {}) {
  return {
    ...DEFAULT_STATE,
    modelPolicies: {},
    allowedModels: [],
    blockedModels: [],
    ...overrides,
  };
}

test('getModelPolicy gère allow par défaut, ask, deny et rétrocompatibilité blockedModels/allowedModels', () => {
  assert.deepEqual([...MODEL_POLICIES], ['allow', 'ask', 'deny']);

  const s1 = makeState({
    modelPolicies: {
      'claude-opus-5-5': 'ask',
      'gpt-6.2-astra': 'deny',
    },
  });
  assert.equal(getModelPolicy('claude-sonnet-5-5', s1), 'allow');
  assert.equal(getModelPolicy('claude-opus-5-5', s1), 'ask');
  assert.equal(getModelPolicy('gpt-6.2-astra', s1), 'deny');

  // Rétrocompatibilité avec blockedModels / allowedModels sans modelPolicies explicite
  const sLegacyBlocked = makeState({ blockedModels: ['haiku', 'ask:claude-opus-5-5'] });
  assert.equal(getModelPolicy('claude-haiku-5-5', sLegacyBlocked), 'deny');
  assert.equal(getModelPolicy('claude-opus-5-5', sLegacyBlocked), 'ask');
  assert.equal(getModelPolicy('claude-sonnet-5-5', sLegacyBlocked), 'allow');

  // modelPolicies explicite prend le pas sur l'ancien filtre
  const sOverride = makeState({
    blockedModels: ['opus'],
    modelPolicies: { 'claude-opus-5-5': 'ask' },
  });
  assert.equal(getModelPolicy('claude-opus-5-5', sOverride), 'ask');

  const sLegacyAllowed = makeState({ allowedModels: ['sonnet'] });
  assert.equal(getModelPolicy('claude-sonnet-5-5', sLegacyAllowed), 'allow');
  assert.equal(getModelPolicy('claude-haiku-5-5', sLegacyAllowed), 'deny');
});

test('modelIsAllowed distingue allow et ask selon allowAsk', () => {
  const st = makeState({
    modelPolicies: {
      'claude-opus-5-5': 'ask',
      'gpt-6.2-astra': 'deny',
    },
  });
  assert.equal(modelIsAllowed('claude-sonnet-5-5', st), true);
  assert.equal(modelIsAllowed('claude-opus-5-5', st), false);
  assert.equal(modelIsAllowed('claude-opus-5-5', st, { allowAsk: true }), true);
  assert.equal(modelIsAllowed('gpt-6.2-astra', st, { allowAsk: true }), false);
});

test('pickModel exclut deny et lève une erreur explicite si un modèle deny est forcé', () => {
  const st = makeState({
    modelPolicies: {
      'claude-opus-5-5': 'deny',
      'gpt-6.2-astra': 'deny',
    },
  });
  // Même avec un prompt/effort demandant un modèle fort, ne choisit jamais un modèle deny
  const picked = pickModel('/max refactor architecture globale', AVAILABLE, st);
  assert.notEqual(picked.model, 'claude-opus-5-5');
  assert.notEqual(picked.model, 'gpt-6.2-astra');
  assert.equal(picked.needsApproval, false);

  assert.throws(
    () => pickModel('/opus corrige ce bug', AVAILABLE, st),
    /désactivé \(Non\)/i
  );

  const allDenied = makeState({
    modelPolicies: Object.fromEntries(AVAILABLE.map((id) => [id, 'deny'])),
  });
  assert.throws(
    () => pickModel('corrige ce bug', AVAILABLE, allDenied),
    /Aucun modèle autorisé disponible/i
  );
});

test('pickModel retourne needsApproval + alternatives pour ask et débloque avec approvedModel', () => {
  const st = makeState({
    routingProfile: 'quality',
    modelPolicies: {
      'claude-opus-5-5': 'ask',
      'gpt-6.2-astra': 'deny',
    },
  });

  // Quality/heavy choisit claude-opus-5-5 (prioritaire en heavy) -> demande confirmation
  const res = pickModel('analyse architecture complète', AVAILABLE, st);
  assert.equal(res.model, 'claude-opus-5-5');
  assert.equal(res.policy, 'ask');
  assert.equal(res.needsApproval, true);
  assert.ok(Array.isArray(res.alternatives) && res.alternatives.length > 0);
  assert.ok(!res.alternatives.includes('claude-opus-5-5'));
  assert.ok(!res.alternatives.includes('gpt-6.2-astra'));

  // Même modèle validé via approvedModel -> pas de re-demande
  const approved = pickModel('analyse architecture complète', AVAILABLE, st, undefined, {
    approvedModel: 'claude-opus-5-5',
  });
  assert.equal(approved.model, 'claude-opus-5-5');
  assert.equal(approved.policy, 'ask');
  assert.equal(approved.needsApproval, false);
  assert.deepEqual(approved.alternatives, []);
});

test('rankModelsBestToWorst exclut deny et ask non approuvés (sécurité cascade 502/429)', () => {
  const st = makeState({
    modelPolicies: {
      'claude-opus-5-5': 'ask',
      'gpt-6.2-astra': 'deny',
    },
  });

  const ranked = rankModelsBestToWorst(AVAILABLE, st);
  assert.deepEqual(ranked, ['claude-sonnet-5-5', 'claude-haiku-5-5']);

  const rankedWithApproved = rankModelsBestToWorst(AVAILABLE, st, { approvedModel: 'claude-opus-5-5' });
  assert.deepEqual(rankedWithApproved, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
});

test('enrichModelsCatalog et groupModelsByTier renseignent policy et blocked', () => {
  const st = makeState({
    knownModels: Object.fromEntries(AVAILABLE.map((id) => [id, { firstSeenAt: null, baseline: true }])),
    modelPolicies: {
      'claude-opus-5-5': 'ask',
      'gpt-6.2-astra': 'deny',
    },
  });

  const catalog = enrichModelsCatalog(AVAILABLE, new Map(), st, [], { persist: false });
  const opus = catalog.find((m) => m.id === 'claude-opus-5-5');
  const astra = catalog.find((m) => m.id === 'gpt-6.2-astra');
  const sonnet = catalog.find((m) => m.id === 'claude-sonnet-5-5');

  assert.equal(opus.policy, 'ask');
  assert.equal(opus.blocked, false);
  assert.equal(astra.policy, 'deny');
  assert.equal(astra.blocked, true);
  assert.equal(sonnet.policy, 'allow');
  assert.equal(sonnet.blocked, false);

  const grouped = groupModelsByTier(AVAILABLE, st, new Map());
  const gOpus = grouped.heavy.find((m) => m.id === 'claude-opus-5-5');
  const gAstra = grouped.heavy.find((m) => m.id === 'gpt-6.2-astra');
  assert.equal(gOpus.policy, 'ask');
  assert.equal(gOpus.blocked, false);
  assert.equal(gAstra.policy, 'deny');
  assert.equal(gAstra.blocked, true);
});

test('pickModel distingue routingProfile auto, quality (Priorité Fort) et eco', () => {
  const autoState = makeState({ routingProfile: 'auto' });
  const simpleAuto = pickModel('corrige typo readme', AVAILABLE, autoState);
  assert.equal(simpleAuto.profile, 'auto');
  assert.equal(simpleAuto.model, 'claude-haiku-5-5');

  const complexAuto = pickModel('refactor architecture concurrency', AVAILABLE, autoState);
  assert.equal(complexAuto.profile, 'auto');
  assert.equal(complexAuto.model, 'claude-opus-5-5');

  const qualityState = makeState({ routingProfile: 'quality' });
  const simpleQuality = pickModel('corrige typo readme', AVAILABLE, qualityState);
  assert.equal(simpleQuality.profile, 'quality');
  assert.equal(simpleQuality.model, 'claude-opus-5-5');

  // /auto force la sélection heuristique même si le profil global est quality
  const overrideAuto = pickModel('/auto corrige typo readme', AVAILABLE, qualityState);
  assert.equal(overrideAuto.profile, 'auto');
  assert.equal(overrideAuto.model, 'claude-haiku-5-5');
});
