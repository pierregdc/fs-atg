import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchAccessTokenFromWebSession,
  loadState,
  OFFICIAL_WEB_ORIGIN,
  saveWebSessionAndPrime,
  SESSION_COOKIE_NAMES,
} from './fs_core.mjs';
import { logEvent } from './logger.mjs';

const LOGIN_POLL_INTERVAL_MS = 1000;
const LOGIN_MAX_WAIT_MS = 5 * 60_000;
const CDP_READY_TIMEOUT_MS = 15_000;
const VALID_DOMAINS = new Set(['ia.francestudent.org', 'francestudent.org']);

let loginStatus = {
  state: 'idle',
  message: '',
  error: null,
  startedAt: null,
  updatedAt: null,
  browserName: null,
};

let activeSession = null;

function setStatus(patch) {
  loginStatus = { ...loginStatus, ...patch, updatedAt: Date.now() };
  return { ...loginStatus };
}

export function getBrowserLoginStatus() {
  return { ...loginStatus };
}

function browserCandidates() {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    return [
      { name: 'Google Chrome', path: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', path: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      ...(local ? [{ name: 'Google Chrome', path: join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') }] : []),
      { name: 'Microsoft Edge', path: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Microsoft Edge', path: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      ...(local ? [{ name: 'Microsoft Edge', path: join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') }] : []),
      { name: 'Brave', path: join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { name: 'Brave', path: join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      ...(local ? [{ name: 'Brave', path: join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') }] : []),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    ];
  }
  return [
    { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
    { name: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
    { name: 'Chromium', path: '/usr/bin/chromium' },
    { name: 'Chromium', path: '/usr/bin/chromium-browser' },
    { name: 'Chromium', path: '/snap/bin/chromium' },
    { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
    { name: 'Brave', path: '/usr/bin/brave-browser' },
  ];
}

export function findChromiumExecutable() {
  const custom = String(process.env.FS_ATG_BROWSER_PATH || '').trim();
  if (custom && existsSync(custom)) {
    return { name: 'Navigateur personnalisé', path: custom };
  }
  for (const candidate of browserCandidates()) {
    if (candidate.path && existsSync(candidate.path)) return candidate;
  }
  return null;
}

export function extractSessionCookieFromCdpCookies(cookies) {
  if (!Array.isArray(cookies)) return null;
  const scoped = cookies.filter((c) => {
    const dom = String(c?.domain || '').trim().toLowerCase().replace(/^\./, '');
    return VALID_DOMAINS.has(dom) && typeof c?.value === 'string' && c.value.length > 0;
  });
  if (!scoped.length) return null;

  const deviceCookie = scoped.find((c) => c.name === 'francestudent-device-id');
  const deviceId = deviceCookie?.value ? String(deviceCookie.value).trim() : null;

  for (const baseName of SESSION_COOKIE_NAMES) {
    const exact = scoped.find((c) => c.name === baseName);
    if (exact) {
      return { sessionToken: exact.value, cookieName: baseName, deviceId };
    }
  }

  for (const baseName of SESSION_COOKIE_NAMES) {
    const prefix = `${baseName}.`;
    const chunks = scoped
      .filter((c) => c.name.startsWith(prefix) && /^\d+$/.test(c.name.slice(prefix.length)))
      .map((c) => ({ idx: Number(c.name.slice(prefix.length)), value: c.value }))
      .sort((a, b) => a.idx - b.idx);
    if (chunks.length) {
      return {
        sessionToken: chunks.map((p) => p.value).join(''),
        cookieName: baseName,
        deviceId,
      };
    }
  }

  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function removeUserDataDirBestEffort(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    setTimeout(() => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 800).unref?.();
  }
}

function cleanupSession(session) {
  if (!session) return;
  try { session.ws?.close?.(); } catch { /* ignore */ }
  try {
    if (session.child && !session.child.killed && session.child.exitCode === null) {
      session.child.kill();
    }
  } catch { /* ignore */ }
  removeUserDataDirBestEffort(session.userDataDir);
  if (activeSession === session) activeSession = null;
}

export function cancelBrowserLogin() {
  if (activeSession) {
    activeSession.cancelled = true;
    cleanupSession(activeSession);
  }
  return setStatus({
    state: 'cancelled',
    message: 'Connexion navigateur annulée.',
    error: null,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCdpEndpoint(port, session) {
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
  while (Date.now() < deadline && !session.cancelled && !session.exited) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const json = await res.json();
        if (json?.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch { /* wait until CDP starts listening */ }
    await sleep(250);
  }
  return null;
}

async function openCdpClient(wsUrl) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('WebSocket natif indisponible dans ce runtime Node.');
  }
  return await new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    const failAll = (err) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
    };

    ws.addEventListener('open', () => {
      resolve({
        ws,
        call(method, params = {}) {
          return new Promise((resCall, rejCall) => {
            if (ws.readyState !== 1) {
              rejCall(new Error('Connexion CDP fermée.'));
              return;
            }
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rejCall(new Error(`Timeout CDP (${method})`));
            }, 5000);
            pending.set(id, { resolve: resCall, reject: rejCall, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          failAll(new Error('CDP fermé.'));
          try { ws.close(); } catch { /* ignore */ }
        },
      });
    }, { once: true });

    ws.addEventListener('error', () => {
      const err = new Error('Erreur WebSocket CDP.');
      failAll(err);
      reject(err);
    }, { once: true });

    ws.addEventListener('close', () => {
      failAll(new Error('Connexion CDP interrompue.'));
    });

    ws.addEventListener('message', (ev) => {
      try {
        const txt = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
        const msg = JSON.parse(txt);
        if (msg?.id && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) entry.reject(new Error(msg.error.message || 'Erreur CDP'));
          else entry.resolve(msg.result);
        }
      } catch { /* ignore malformed CDP frames */ }
    });
  });
}

async function readAllBrowserCookies(cdp, port) {
  try {
    const res = await cdp.call('Storage.getCookies');
    if (Array.isArray(res?.cookies) && res.cookies.length) return res.cookies;
  } catch { /* fallback to first page target */ }

  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (listRes.ok) {
      const pages = await listRes.json();
      const firstWs = Array.isArray(pages) ? pages.find((p) => p?.webSocketDebuggerUrl)?.webSocketDebuggerUrl : null;
      if (firstWs) {
        const pageCdp = await openCdpClient(firstWs);
        try {
          const res = await pageCdp.call('Network.getAllCookies');
          if (Array.isArray(res?.cookies)) return res.cookies;
        } finally {
          pageCdp.close();
        }
      }
    }
  } catch { /* ignore fallback errors */ }
  return [];
}

async function runBrowserLoginLoop(session, port, onComplete) {
  let cdp = null;
  try {
    const wsUrl = await waitForCdpEndpoint(port, session);
    if (session.cancelled || session.exited) {
      if (!session.cancelled && loginStatus.state !== 'done' && loginStatus.state !== 'error') {
        setStatus({ state: 'cancelled', message: 'Fenêtre fermée avant la fin de la connexion.', error: null });
      }
      return;
    }
    if (!wsUrl) {
      setStatus({
        state: 'error',
        error: 'Impossible de communiquer avec la fenêtre de connexion navigateur.',
        message: 'Connexion navigateur impossible.',
      });
      logEvent('error', 'auth', 'auth.browser_login.cdp_timeout', 'Port de débogage navigateur indisponible.');
      return;
    }

    cdp = await openCdpClient(wsUrl);
    session.ws = cdp.ws;
    setStatus({
      state: 'waiting_login',
      message: `Connecte-toi sur France Student dans la fenêtre ${session.browserName} ouverte…`,
      error: null,
    });

    const deadline = Date.now() + LOGIN_MAX_WAIT_MS;
    let verifyFailures = 0;
    while (Date.now() < deadline && !session.cancelled && !session.exited) {
      const cookies = await readAllBrowserCookies(cdp, port);
      const found = extractSessionCookieFromCdpCookies(cookies);
      if (found?.sessionToken) {
        setStatus({ state: 'verifying', message: 'Vérification de la session France Student…', error: null });
        const deviceId = found.deviceId || randomUUID();
        try {
          const tok = await fetchAccessTokenFromWebSession({
            sessionToken: found.sessionToken,
            cookieName: found.cookieName,
            deviceId,
          });
          const st = loadState();
          await saveWebSessionAndPrime(
            st,
            {
              sessionToken: tok.renewedCookie || found.sessionToken,
              cookieName: tok.renewedCookieName || found.cookieName,
              deviceId,
              updatedAt: Date.now(),
            },
            tok.accessToken,
            tok.expiresAtMs
          );
          try { await cdp.call('Browser.close'); } catch { /* ignore */ }
          setStatus({
            state: 'done',
            message: 'Connecté à France Student — session longue durée active.',
            error: null,
          });
          logEvent('info', 'auth', 'auth.browser_login.done', `Connexion navigateur réussie via ${session.browserName}.`);
          if (typeof onComplete === 'function') await onComplete();
          return;
        } catch (err) {
          verifyFailures += 1;
          if (verifyFailures >= 3) {
            setStatus({
              state: 'error',
              error: err?.message || 'Session refusée par France Student.',
              message: 'Échec de vérification de la session.',
            });
            logEvent('error', 'auth', 'auth.browser_login.verify_failed', err?.message || 'Erreur api-token');
            return;
          }
          setStatus({
            state: 'waiting_login',
            message: `Finalisation de la connexion dans ${session.browserName}…`,
            error: null,
          });
        }
      }
      await sleep(LOGIN_POLL_INTERVAL_MS);
    }

    if (session.cancelled) return;
    if (session.exited) {
      setStatus({ state: 'cancelled', message: 'Fenêtre fermée avant la fin de la connexion.', error: null });
      return;
    }
    setStatus({
      state: 'error',
      error: 'Délai de connexion dépassé (5 min). Réessaie.',
      message: 'Délai dépassé.',
    });
  } catch (err) {
    if (!session.cancelled && loginStatus.state !== 'done') {
      const msg = err?.message || 'Erreur pendant la connexion navigateur.';
      setStatus({ state: 'error', error: msg, message: msg });
      logEvent('error', 'auth', 'auth.browser_login.error', msg);
    }
  } finally {
    cdp?.close?.();
    cleanupSession(session);
  }
}

export async function startBrowserLogin({ onComplete } = {}) {
  if (activeSession && ['opening', 'waiting_login', 'verifying'].includes(loginStatus.state)) {
    return getBrowserLoginStatus();
  }

  const browser = findChromiumExecutable();
  if (!browser) {
    const errMsg = 'Chrome ou Edge introuvable — utilise la connexion manuelle ci-dessous.';
    setStatus({
      state: 'error',
      error: errMsg,
      message: 'Navigateur compatible introuvable.',
      browserName: null,
    });
    throw new Error(errMsg);
  }

  const port = await getFreePort();
  const userDataDir = join(tmpdir(), `fs-atg-login-${randomUUID()}`);
  const args = [
    `--app=${OFFICIAL_WEB_ORIGIN}`,
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--window-size=520,760',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ];

  const child = spawn(browser.path, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  });

  const session = {
    child,
    ws: null,
    userDataDir,
    browserName: browser.name,
    cancelled: false,
    exited: false,
  };
  activeSession = session;

  setStatus({
    state: 'opening',
    message: `Ouverture de ${browser.name} sur France Student…`,
    error: null,
    startedAt: Date.now(),
    browserName: browser.name,
  });
  logEvent('info', 'auth', 'auth.browser_login.start', `Lancement fenêtre de connexion (${browser.name}).`);

  child.on('exit', () => {
    session.exited = true;
    if (!session.cancelled && ['opening', 'waiting_login'].includes(loginStatus.state)) {
      setStatus({
        state: 'cancelled',
        message: 'Fenêtre fermée avant la fin de la connexion.',
        error: null,
      });
    }
  });

  child.on('error', (err) => {
    session.exited = true;
    setStatus({
      state: 'error',
      error: err?.message || `Impossible de lancer ${browser.name}.`,
      message: `Impossible de lancer ${browser.name}.`,
    });
  });

  void runBrowserLoginLoop(session, port, onComplete);
  return getBrowserLoginStatus();
}

process.once('exit', () => {
  if (activeSession) {
    activeSession.cancelled = true;
    cleanupSession(activeSession);
  }
});
