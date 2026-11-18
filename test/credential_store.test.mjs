import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREDENTIAL_TARGET,
  clearStateCredential,
  credentialAvailability,
  deleteCredential,
  readCredential,
  resolveStateCredential,
  saveStateCredential,
  writeCredential,
} from '../plugin/credential_store.mjs';

test('trousseau Windows : le store est explicitement indisponible hors Windows', async (t) => {
  if (process.platform === 'win32') return t.skip('couvert par le test d’intégration Windows');
  const state = await credentialAvailability();
  assert.equal(state.available, false);
  const value = await readCredential();
  assert.deepEqual(value, { available: false, value: '' });
});

test('trousseau Windows : écrit, lit et efface un secret de test isolé', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows uniquement');
  const target = `${CREDENTIAL_TARGET}.Test.${process.pid}.${Date.now()}`;
  const secret = 'fs-atg-test-secret-only';
  try {
    await deleteCredential(target);
    const stored = await writeCredential(secret, target);
    assert.equal(stored.available, true);
    const read = await readCredential(target);
    assert.equal(read.value, secret);
  } finally {
    await deleteCredential(target).catch(() => undefined);
  }
});

test('migration : une clé legacy ne disparaît qu’après lecture de vérification', async () => {
  const state = { apiKey: 'legacy-secret' };
  const originalPlatform = process.platform;
  if (originalPlatform !== 'win32') {
    const result = await resolveStateCredential(state, { environmentValue: '' });
    assert.deepEqual(result, { value: 'legacy-secret', source: 'state-file', migrated: false });
    assert.equal(state.apiKey, 'legacy-secret');
    return;
  }
  let written = '';
  const result = await resolveStateCredential(state, {
    environmentValue: '',
    write: async (value) => { written = value; return { available: true }; },
    read: async () => ({ available: true, value: 'legacy-secret' }),
  });
  assert.equal(written, 'legacy-secret');
  assert.equal(result.migrated, true);
  assert.equal(state.apiKey, '');
});

test('migration : une vérification échouée conserve la clé legacy', async () => {
  const state = { apiKey: 'legacy-secret' };
  if (process.platform !== 'win32') return;
  const result = await resolveStateCredential(state, {
    environmentValue: '',
    write: async () => ({ available: true }),
    read: async () => ({ available: true, value: 'autre-secret' }),
  });
  assert.equal(result.migrated, false);
  assert.equal(state.apiKey, 'legacy-secret');
});

test('sauvegarde et effacement injectables ne touchent pas une clé existante en cas d’échec', async () => {
  const state = { apiKey: 'old' };
  if (process.platform !== 'win32') {
    await saveStateCredential(state, 'new');
    assert.equal(state.apiKey, 'new');
    await clearStateCredential(state);
    assert.equal(state.apiKey, '');
    return;
  }
  await assert.rejects(() => saveStateCredential(state, 'new', { write: async () => ({ available: false }) }));
  assert.equal(state.apiKey, 'old');
  await assert.rejects(() => clearStateCredential(state, { remove: async () => ({ available: false }) }));
  assert.equal(state.apiKey, 'old');
});

test('sauvegarde : verification echouee conserve la valeur legacy', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows uniquement');
  const state = { apiKey: 'old' };
  await assert.rejects(() => saveStateCredential(state, 'new', {
    write: async () => ({ available: true }),
    read: async () => ({ available: true, value: 'other' }),
  }));
  assert.equal(state.apiKey, 'old');
});

test('sauvegarde : ecriture relue a l identique remplace la valeur legacy', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows uniquement');
  const state = { apiKey: 'old' };
  const result = await saveStateCredential(state, 'new', {
    write: async () => ({ available: true }),
    read: async () => ({ available: true, value: 'new' }),
  });
  assert.equal(result.storage, 'windows-credential-manager');
  assert.equal(state.apiKey, '');
});
