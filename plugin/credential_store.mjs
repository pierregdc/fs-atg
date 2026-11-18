import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(__dirname, 'windows_credential_store.ps1');
export const CREDENTIAL_TARGET = 'FranceStudent.ATG.ApiKey.v1';

function parseResult(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error('Le trousseau Windows n’a renvoyé aucune réponse.');
  const result = JSON.parse(line);
  if (!result?.ok) throw new Error(String(result?.error || 'Le trousseau Windows a refusé l’opération.'));
  return result;
}

function runWindowsCredential(action, input = '', target = CREDENTIAL_TARGET) {
  if (process.platform !== 'win32') return Promise.resolve({ available: false, found: false });
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', HELPER_PATH, '-Action', action, '-Target', target,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => reject(new Error('Le trousseau Windows est indisponible.')));
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error('Le trousseau Windows est indisponible.')); return; }
      try { resolve({ available: true, ...parseResult(stdout) }); }
      catch (error) {
        // Never include stdout/stderr because they can accidentally contain a secret.
        reject(error instanceof Error ? error : new Error('Le trousseau Windows est indisponible.'));
      }
    });
    child.stdin.end(String(input));
  });
}

export async function readCredential(target = CREDENTIAL_TARGET) {
  const result = await runWindowsCredential('get', '', target);
  if (!result.available || !result.found || typeof result.valueBase64 !== 'string') return { available: Boolean(result.available), value: '' };
  return { available: true, value: Buffer.from(result.valueBase64, 'base64').toString('utf8') };
}

export async function writeCredential(value, target = CREDENTIAL_TARGET) {
  const secret = String(value ?? '').trim();
  if (!secret) throw new Error('La clé est vide.');
  const result = await runWindowsCredential('set', secret, target);
  return { available: Boolean(result.available), stored: Boolean(result.available) };
}

export async function deleteCredential(target = CREDENTIAL_TARGET) {
  const result = await runWindowsCredential('delete', '', target);
  return { available: Boolean(result.available), deleted: Boolean(result.available) };
}

export async function credentialAvailability() {
  try {
    const result = await runWindowsCredential('get');
    return { available: Boolean(result.available), configured: Boolean(result.found) };
  } catch {
    return { available: process.platform === 'win32', configured: false };
  }
}

/**
 * Resolves a credential without ever putting it in a returned diagnostic.
 * A legacy plaintext `state.apiKey` is removed only after a write *and a read*
 * from Windows Credential Manager have both succeeded.
 */
export async function resolveStateCredential(state, {
  environmentValue = process.env.FS_ATG_API_KEY,
  read = readCredential,
  write = writeCredential,
} = {}) {
  const environment = String(environmentValue || '').trim();
  if (environment) return { value: environment, source: 'environment', migrated: false };

  const legacy = String(state?.apiKey || '').trim();
  if (legacy) {
    if (process.platform !== 'win32') return { value: legacy, source: 'state-file', migrated: false };
    try {
      const stored = await write(legacy);
      if (stored?.available) {
        const verified = await read();
        if (verified?.available && verified.value === legacy) {
          state.apiKey = '';
          state.credentialStorage = 'windows-credential-manager';
          return { value: legacy, source: 'windows-credential-manager', migrated: true };
        }
      }
    } catch {
      // Keep the legacy state untouched; an unavailable keychain must never
      // turn into a lost credential.
    }
    return { value: legacy, source: 'state-file', migrated: false };
  }

  try {
    const stored = await read();
    if (stored?.available && stored.value) {
      state.credentialStorage = 'windows-credential-manager';
      return { value: stored.value, source: 'windows-credential-manager', migrated: false };
    }
  } catch { /* reported as unavailable by status, never as an empty success */ }
  return { value: '', source: process.platform === 'win32' ? 'unavailable' : 'state-file', migrated: false };
}

export async function saveStateCredential(state, value, {
  write = writeCredential,
  read = readCredential,
} = {}) {
  const secret = String(value || '').trim();
  if (!secret) throw new Error('La clé est vide.');
  if (process.platform !== 'win32') {
    state.apiKey = secret;
    state.credentialStorage = 'state-file';
    return { storage: 'state-file' };
  }
  const stored = await write(secret);
  if (!stored?.available) throw new Error('Le trousseau Windows est indisponible : la clé existante est conservée.');
  const verified = await read();
  if (!verified?.available || verified.value !== secret) {
    throw new Error('Verification du trousseau impossible : la cle existante est conservee.');
  }
  state.apiKey = '';
  state.credentialStorage = 'windows-credential-manager';
  return { storage: 'windows-credential-manager' };
}

export async function clearStateCredential(state, {
  remove = deleteCredential,
} = {}) {
  if (process.platform === 'win32') {
    const removed = await remove();
    if (!removed?.available) throw new Error('Le trousseau Windows est indisponible : la clé existante est conservée.');
  }
  state.apiKey = '';
  delete state.credentialStorage;
}

export async function stateCredentialStatus(state, {
  availability = credentialAvailability,
} = {}) {
  if (String(process.env.FS_ATG_API_KEY || '').trim()) {
    return { configured: true, storage: 'environment', migrated: false };
  }
  if (String(state?.apiKey || '').trim()) {
    return { configured: true, storage: 'state-file', migrated: false };
  }
  const status = await availability();
  return {
    configured: Boolean(status.configured),
    storage: status.configured ? 'windows-credential-manager' : (status.available ? 'windows-credential-manager' : 'unavailable'),
    migrated: false,
  };
}
