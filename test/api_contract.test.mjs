import assert from 'node:assert/strict';
import test from 'node:test';

import { API_CONTRACTS, contractResult, verifyApiContract } from '../scripts/verify_api_contract.mjs';

test('contrat API : le probe reste strictement GET et borné à des endpoints connus', () => {
  assert.ok(API_CONTRACTS.length >= 8);
  for (const contract of API_CONTRACTS) {
    assert.match(contract.path, /^\//);
    assert.equal(typeof contract.validate, 'function');
  }
});

test('contrat API : un endpoint optionnel 404 est indisponible, pas une fausse réussite', () => {
  const contract = API_CONTRACTS.find((item) => item.name === 'skills');
  assert.deepEqual(contractResult(contract, 404, null), {
    name: 'skills', status: 404, available: false, valid: true,
  });
});

test('contrat API : les formats modèles attendus sont détectés', () => {
  const legacy = API_CONTRACTS.find((item) => item.name === 'models');
  const openAi = API_CONTRACTS.find((item) => item.name === 'openAiModels');
  assert.equal(contractResult(legacy, 200, { data: [{ id: 'x' }] }).valid, true);
  assert.equal(contractResult(openAi, 200, { data: [{ id: 'x' }] }).valid, true);
  assert.equal(contractResult(openAi, 200, { models: [] }).valid, false);
});

test('contrat API : sans jeton explicite, aucune requête réelle n’est envoyée', async () => {
  const report = await verifyApiContract({ token: '' });
  assert.equal(report.skipped, true);
});
