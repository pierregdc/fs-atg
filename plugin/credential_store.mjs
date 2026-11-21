import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(__dirname, 'windows_credential_store.ps1');
export const CREDENTIAL_TARGET = 'FranceStudent.ATG.ApiKey.v1';
export const SESSION_CREDENTIAL_TARGET = 'FranceStudent.ATG.WebSession.v1';
const WIN_CRED_MAX_BYTES = 2400;

function parseResult(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error('Le trousseau Windows n’a renvoyé aucune réponse.');
  const result = JSON.parse(line);
  if (!result?.ok) throw new Error(String(result?.error || 'Le trousseau Windows a refusé l’opération.'));
  return result;
}

const KEYCHAIN_ACCOUNT = 'fs-atg';
let linuxSecretToolCache = null;

/** True when a native OS secret store is usable: Windows Credential Manager, macOS Keychain, Linux Secret Service (secret-tool). */
export function keychainSupported() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  if (process.platform === 'linux') {
    if (linuxSecretToolCache === null) {
      try {
        linuxSecretToolCache = spawnSync('secret-tool', ['--version'], { stdio: 'ignore', windowsHide: true }).status !== null;
      } catch { linuxSecretToolCache = false; }
    }
    return linuxSecretToolCache;
  }
  return false;
}

function runProcess(cmd, args, input = '') {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { resolve({ code: -1, stdout: '' }); return; }
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('error', () => resolve({ code: -1, stdout: '' }));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const securityQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** macOS `security` / Linux `secret-tool`; secrets travel through stdin, never through argv. */
async function runUnixKeychain(action, input, target) {
  const mac = process.platform === 'darwin';
  if (action === 'get') {
    const r = mac
      ? await runProcess('security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', target, '-w'])
      : await runProcess('secret-tool', ['lookup', 'service', KEYCHAIN_ACCOUNT, 'target', target]);
    const value = r.stdout.replace(/\r?\n$/, '');
    if (r.code !== 0 || !value) return { available: true, ok: true, found: false };
    return { available: true, ok: true, found: true, valueBase64: Buffer.from(value, 'utf8').toString('base64') };
  }
  if (action === 'set') {
    const r = mac
      ? await runProcess('security', ['-i'], `add-generic-password -U -a ${securityQuote(KEYCHAIN_ACCOUNT)} -s ${securityQuote(target)} -w ${securityQuote(input)}\n`)
      : await runProcess('secret-tool', ['store', '--label=France Student ATG', 'service', KEYCHAIN_ACCOUNT, 'target', target], input);
    if (r.code !== 0) throw new Error('Le trousseau système est indisponible.');
    return { available: true, ok: true };
  }
  if (action === 'delete') {
    if (mac) await runProcess('security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', target]);
    else await runProcess('secret-tool', ['clear', 'service', KEYCHAIN_ACCOUNT, 'target', target]);
    return { available: true, ok: true };
  }
  throw new Error(`Action trousseau inconnue : ${action}`);
}

function runWindowsCredential(action, input = '', target = CREDENTIAL_TARGET) {
  if (process.platform !== 'win32') {
    if (!keychainSupported()) return Promise.resolve({ available: false, found: false });
    return runUnixKeychain(action, input, target);
  }
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
  const value = Buffer.from(result.valueBase64, 'base64').toString('utf8');
  if (target === CREDENTIAL_TARGET && value.trim() === 'test-key') {
    await runWindowsCredential('delete', '', target).catch(() => {});
    return { available: true, value: '' };
  }
  return { available: true, value };
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
    return { available: keychainSupported(), configured: false };
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
    if (legacy === 'test-key' || legacy.length < 10) {
      return { value: legacy, source: 'state-file', migrated: false };
    }
    if (!keychainSupported()) return { value: legacy, source: 'state-file', migrated: false };
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
  return { value: '', source: keychainSupported() ? 'unavailable' : 'state-file', migrated: false };
}

export async function saveStateCredential(state, value, {
  write = writeCredential,
  read = readCredential,
} = {}) {
  const secret = String(value || '').trim();
  if (!secret) throw new Error('La clé est vide.');
  if (!keychainSupported()) {
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
  if (keychainSupported()) {
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

function splitUtf8Chunks(value, maxBytes = WIN_CRED_MAX_BYTES) {
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of String(value ?? '')) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (current && currentBytes + chBytes > maxBytes) {
      chunks.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function readChunkedCredential(target = SESSION_CREDENTIAL_TARGET) {
  const head = await readCredential(target);
  if (!head.available || !head.value) return { available: Boolean(head.available), value: '' };
  try {
    const parsed = JSON.parse(head.value);
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.__chunks) && parsed.__chunks > 0) {
      const parts = [];
      for (let i = 0; i < parsed.__chunks; i += 1) {
        const part = await readCredential(`${target}.${i}`);
        if (!part.available || !part.value) return { available: Boolean(part.available), value: '' };
        parts.push(part.value);
      }
      return { available: true, value: parts.join('') };
    }
  } catch { /* direct JSON or non-manifest value */ }
  return { available: true, value: head.value };
}

async function writeChunkedCredential(value, target = SESSION_CREDENTIAL_TARGET) {
  const raw = String(value ?? '');
  if (!raw) throw new Error('Le secret de session est vide.');
  if (Buffer.byteLength(raw, 'utf8') <= WIN_CRED_MAX_BYTES) {
    const written = await writeCredential(raw, target);
    for (let i = 0; i < 8; i += 1) {
      await deleteCredential(`${target}.${i}`).catch(() => {});
    }
    return written;
  }
  const chunks = splitUtf8Chunks(raw, WIN_CRED_MAX_BYTES);
  for (let i = 0; i < chunks.length; i += 1) {
    const res = await writeCredential(chunks[i], `${target}.${i}`);
    if (!res?.available) return res;
  }
  for (let i = chunks.length; i < chunks.length + 8; i += 1) {
    await deleteCredential(`${target}.${i}`).catch(() => {});
  }
  return await writeCredential(JSON.stringify({ __chunks: chunks.length }), target);
}

async function deleteChunkedCredential(target = SESSION_CREDENTIAL_TARGET) {
  let chunkCount = 8;
  try {
    const head = await readCredential(target);
    if (head.value) {
      const parsed = JSON.parse(head.value);
      if (Number.isInteger(parsed?.__chunks) && parsed.__chunks > 0) chunkCount = Math.max(8, parsed.__chunks);
    }
  } catch { /* ignore */ }
  for (let i = 0; i < chunkCount; i += 1) {
    await deleteCredential(`${target}.${i}`).catch(() => {});
  }
  return await deleteCredential(target);
}

function normalizeWebSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionToken = String(raw.sessionToken || '').trim();
  if (!sessionToken) return null;
  return {
    sessionToken,
    cookieName: String(raw.cookieName || 'next-auth.session-token').trim() || 'next-auth.session-token',
    deviceId: String(raw.deviceId || '').trim(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

export async function readWebSession(state) {
  if (!keychainSupported() || state?._ephemeral === true) {
    return normalizeWebSession(state?.webSession);
  }
  try {
    const stored = await readChunkedCredential(SESSION_CREDENTIAL_TARGET);
    if (!stored.available || !stored.value) return null;
    return normalizeWebSession(JSON.parse(stored.value));
  } catch {
    return null;
  }
}

export async function saveWebSession(state, session) {
  const payload = normalizeWebSession(session);
  if (!payload) throw new Error('Jeton de session France Student vide ou invalide.');
  if (!keychainSupported() || state?._ephemeral) {
    state.webSession = payload;
    state.webSessionConfigured = true;
    state.webSessionStorage = state?._ephemeral ? 'memory' : 'state-file';
    state.webSessionUpdatedAt = payload.updatedAt;
    return { storage: state.webSessionStorage };
  }
  const serialized = JSON.stringify(payload);
  const stored = await writeChunkedCredential(serialized, SESSION_CREDENTIAL_TARGET);
  if (!stored?.available) throw new Error('Le trousseau Windows est indisponible pour enregistrer la session.');
  const verified = await readChunkedCredential(SESSION_CREDENTIAL_TARGET);
  if (!verified?.available || verified.value !== serialized) {
    throw new Error('Vérification de la session dans le trousseau Windows impossible.');
  }
  delete state.webSession;
  state.webSessionConfigured = true;
  state.webSessionStorage = 'windows-credential-manager';
  state.webSessionUpdatedAt = payload.updatedAt;
  return { storage: 'windows-credential-manager' };
}

export async function clearWebSession(state) {
  if (keychainSupported()) {
    await deleteChunkedCredential(SESSION_CREDENTIAL_TARGET);
  }
  if (state && typeof state === 'object') {
    delete state.webSession;
    delete state.webSessionConfigured;
    delete state.webSessionStorage;
    delete state.webSessionUpdatedAt;
  }
}
