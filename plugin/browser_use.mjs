import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromiumExecutable } from './browser_auth.mjs';
import { logEvent } from './logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BROWSER_PROFILE_DIR = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_browser_use_profile');
export const BROWSER_CAPTURE_DIR = join(__dirname, 'sidecars', 'fs_atg_panel', '.fsatg_captures');

export const BROWSER_ACTIONS = Object.freeze([
  'status',
  'open',
  'snapshot',
  'screenshot',
  'click',
  'fill',
  'press',
  'scroll',
  'eval',
  'console',
  'close',
]);

const FORBIDDEN_URL_RE = /^(?:file:\/\/.*(?:\.env|id_rsa|credentials|secrets)|chrome:\/\/settings\/passwords)/i;

export function validateBrowserUrl(rawUrl) {
  const u = String(rawUrl || '').trim();
  if (!u) throw new Error('URL requise.');
  if (FORBIDDEN_URL_RE.test(u)) {
    throw new Error(`URL locale sensible refusée : ${u}`);
  }
  const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) ? u : `https://${u}`;
  const parsed = new URL(normalized);
  if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
    throw new Error(`Protocole non autorisé dans fs_browser : ${parsed.protocol}`);
  }
  return parsed.toString();
}

let managedBrowser = null;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openCdpSocket(wsUrl) {
  return await new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();

    const failAll = (err) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    };

    ws.addEventListener('open', () => {
      resolve({
        ws,
        call(method, params = {}, timeoutMs = 10_000) {
          return new Promise((res, rej) => {
            if (ws.readyState !== 1) {
              rej(new Error('Session CDP fermée.'));
              return;
            }
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`Timeout CDP (${method})`));
            }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(event, fn) {
          const list = listeners.get(event) || [];
          list.push(fn);
          listeners.set(event, list);
        },
        close() {
          failAll(new Error('CDP fermé.'));
          try { ws.close(); } catch {}
        },
      });
    }, { once: true });

    ws.addEventListener('error', () => {
      const err = new Error('Erreur WebSocket CDP.');
      failAll(err);
      reject(err);
    }, { once: true });

    ws.addEventListener('close', () => failAll(new Error('Connexion CDP fermée.')));

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
        } else if (msg?.method && listeners.has(msg.method)) {
          for (const fn of listeners.get(msg.method)) {
            try { fn(msg.params); } catch {}
          }
        }
      } catch {}
    });
  });
}

async function ensureBrowserSession({ headless = true } = {}) {
  if (managedBrowser && managedBrowser.child && managedBrowser.child.exitCode === null && managedBrowser.pageCdp?.ws?.readyState === 1) {
    return managedBrowser;
  }
  await closeBrowserSession();

  const exe = findChromiumExecutable();
  if (!exe) throw new Error('Chrome ou Edge introuvable sur ce système.');

  mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
  const port = await getFreePort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${BROWSER_PROFILE_DIR}`,
    '--window-size=1280,820',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    'about:blank',
  ];

  const child = spawn(exe.path, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: headless,
  });

  const deadline = Date.now() + 12_000;
  let pageWsUrl = null;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) {
        const list = await res.json();
        const page = Array.isArray(list) ? list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
        if (page) {
          pageWsUrl = page.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {}
    await sleep(200);
  }

  if (!pageWsUrl) {
    try { child.kill(); } catch {}
    throw new Error(`Impossible d'attacher CDP à ${exe.name}.`);
  }

  const pageCdp = await openCdpSocket(pageWsUrl);
  const consoleLogs = [];
  await pageCdp.call('Page.enable');
  await pageCdp.call('Runtime.enable');
  await pageCdp.call('DOM.enable').catch(() => {});

  pageCdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p?.args || []).map((a) => a?.value ?? a?.description ?? '').join(' ');
    consoleLogs.push({ ts: Date.now(), type: p?.type || 'log', text: text.slice(0, 500) });
    if (consoleLogs.length > 80) consoleLogs.shift();
  });
  pageCdp.on('Runtime.exceptionThrown', (p) => {
    const desc = p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'Exception page';
    consoleLogs.push({ ts: Date.now(), type: 'exception', text: String(desc).slice(0, 500) });
    if (consoleLogs.length > 80) consoleLogs.shift();
  });

  managedBrowser = {
    browserName: exe.name,
    headless: Boolean(headless),
    port,
    child,
    pageCdp,
    consoleLogs,
    startedAt: Date.now(),
    currentUrl: 'about:blank',
  };
  return managedBrowser;
}

export async function closeBrowserSession() {
  if (!managedBrowser) return { ok: true, active: false };
  const sess = managedBrowser;
  managedBrowser = null;
  try { await sess.pageCdp?.call('Browser.close', {}, 1500); } catch {}
  try { sess.pageCdp?.close(); } catch {}
  try { if (sess.child && sess.child.exitCode === null) sess.child.kill(); } catch {}
  return { ok: true, active: false };
}

export function getBrowserSessionStatus() {
  const active = Boolean(managedBrowser && managedBrowser.child?.exitCode === null && managedBrowser.pageCdp?.ws?.readyState === 1);
  return {
    active,
    browserName: managedBrowser?.browserName || null,
    headless: managedBrowser?.headless ?? null,
    currentUrl: managedBrowser?.currentUrl || null,
    consoleCount: managedBrowser?.consoleLogs?.length || 0,
  };
}

async function evalInPage(pageCdp, fnSource, arg = null) {
  const expr = `(${fnSource})(${JSON.stringify(arg)})`;
  const res = await pageCdp.call('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res?.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Erreur évaluation JS page.');
  }
  return res?.result?.value;
}

const SNAPSHOT_DOM_FN = `function(opts) {
  const maxNodes = (opts && opts.maxElements) || 60;
  const interactive = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [onclick]'));
  const items = [];
  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name && el.tagName) return el.tagName.toLowerCase() + '[name="' + el.name.replace(/"/g, '\\\\"') + '"]';
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : []);
    if (cls.length) return tag + '.' + cls.map((c) => CSS.escape(c)).join('.');
    return tag;
  }
  for (const el of interactive) {
    if (items.length >= maxNodes) break;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const label = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
    items.push({
      index: items.length + 1,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      label: label || undefined,
      href: el.getAttribute('href') || undefined,
      selector: cssPath(el),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    });
  }
  const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 15).map((h) => h.innerText.trim()).filter(Boolean);
  const bodyText = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, (opts && opts.maxText) || 3500);
  return {
    url: location.href,
    title: document.title,
    headings,
    textExcerpt: bodyText,
    interactiveCount: items.length,
    elements: items,
  };
}`;

export async function executeBrowserAction(params = {}) {
  const action = String(params?.action || 'status').trim();
  if (!BROWSER_ACTIONS.includes(action)) {
    throw new Error(`Action fs_browser inconnue : "${action}". Actions valides : ${BROWSER_ACTIONS.join(', ')}`);
  }

  if (action === 'status') {
    return { ok: true, ...getBrowserSessionStatus() };
  }
  if (action === 'close') {
    return await closeBrowserSession();
  }

  const sess = await ensureBrowserSession({ headless: params.headless !== false });
  const { pageCdp } = sess;

  switch (action) {
    case 'open': {
      const targetUrl = validateBrowserUrl(params.url);
      await pageCdp.call('Page.navigate', { url: targetUrl });
      await sleep(Math.min(5000, Math.max(400, Number(params.waitMs) || 1200)));
      sess.currentUrl = targetUrl;
      const snap = await evalInPage(pageCdp, SNAPSHOT_DOM_FN, { maxElements: 35, maxText: 2000 });
      logEvent('info', 'browser', 'browser.open', `Navigation CDP vers ${targetUrl} (${snap?.title || 'sans titre'}).`);
      return { ok: true, action: 'open', browserName: sess.browserName, headless: sess.headless, ...snap };
    }

    case 'snapshot': {
      if (params.url) {
        const targetUrl = validateBrowserUrl(params.url);
        await pageCdp.call('Page.navigate', { url: targetUrl });
        await sleep(Math.min(5000, Math.max(400, Number(params.waitMs) || 1000)));
        sess.currentUrl = targetUrl;
      }
      const snap = await evalInPage(pageCdp, SNAPSHOT_DOM_FN, {
        maxElements: Number(params.maxElements) || 60,
        maxText: Number(params.maxText) || 3500,
      });
      return { ok: true, action: 'snapshot', ...snap };
    }

    case 'screenshot': {
      if (params.url) {
        const targetUrl = validateBrowserUrl(params.url);
        await pageCdp.call('Page.navigate', { url: targetUrl });
        await sleep(Math.min(5000, Math.max(400, Number(params.waitMs) || 1200)));
        sess.currentUrl = targetUrl;
      }
      mkdirSync(BROWSER_CAPTURE_DIR, { recursive: true });
      const outPath = params.outputPath
        ? String(params.outputPath)
        : join(BROWSER_CAPTURE_DIR, `browser_${Date.now()}_${randomUUID().slice(0, 6)}.png`);
      const shot = await pageCdp.call('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(shot.data, 'base64');
      writeFileSync(outPath, buf);
      const info = await evalInPage(pageCdp, 'function(){ return { url: location.href, title: document.title }; }');
      logEvent('info', 'browser', 'browser.screenshot', `Capture navigateur enregistrée (${buf.length} octets).`, { path: outPath });
      return { ok: true, action: 'screenshot', path: outPath, bytes: buf.length, ...info };
    }

    case 'click': {
      const selector = params.selector ? String(params.selector).trim() : '';
      const text = params.text ? String(params.text).trim() : '';
      if (!selector && !text && (params.x === undefined || params.y === undefined)) {
        throw new Error('Paramètre "selector", "text" ou coordonnées (x, y) requis pour click.');
      }
      if (params.x !== undefined && params.y !== undefined && !selector && !text) {
        const x = Number(params.x);
        const y = Number(params.y);
        await pageCdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await pageCdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        await sleep(250);
        return { ok: true, action: 'click', x, y };
      }
      const clicked = await evalInPage(pageCdp, `function(arg) {
        let el = arg.selector ? document.querySelector(arg.selector) : null;
        if (!el && arg.text) {
          const q = arg.text.toLowerCase();
          const all = Array.from(document.querySelectorAll('button, a, input[type="submit"], [role="button"]'));
          el = all.find((n) => (n.innerText || n.value || n.getAttribute('aria-label') || '').toLowerCase().includes(q));
        }
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return { found: true, tag: el.tagName.toLowerCase(), label: (el.innerText || el.value || '').trim().slice(0, 80) };
      }`, { selector, text });
      if (!clicked?.found) throw new Error(`Élément introuvable pour click (${selector || text}).`);
      await sleep(300);
      return { ok: true, action: 'click', ...clicked };
    }

    case 'fill': {
      const selector = String(params.selector || '').trim();
      const value = String(params.value ?? params.text ?? '');
      if (!selector) throw new Error('Paramètre "selector" requis pour fill.');
      const filled = await evalInPage(pageCdp, `function(arg) {
        const el = document.querySelector(arg.selector);
        if (!el) return { found: false };
        el.focus();
        el.value = arg.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, tag: el.tagName.toLowerCase(), length: arg.value.length };
      }`, { selector, value });
      if (!filled?.found) throw new Error(`Champ introuvable pour fill (${selector}).`);
      return { ok: true, action: 'fill', selector, ...filled };
    }

    case 'press': {
      const key = String(params.key || 'Enter');
      await pageCdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key.length === 1 ? key : undefined });
      await pageCdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key });
      return { ok: true, action: 'press', key };
    }

    case 'scroll': {
      const deltaY = Number(params.deltaY ?? 500);
      const pos = await evalInPage(pageCdp, `function(dy) {
        window.scrollBy(0, dy);
        return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) };
      }`, deltaY);
      return { ok: true, action: 'scroll', ...pos };
    }

    case 'eval': {
      const expression = String(params.expression || '').trim();
      if (!expression) throw new Error('Paramètre "expression" requis pour eval.');
      const res = await pageCdp.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res?.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Erreur JS.');
      }
      return { ok: true, action: 'eval', value: res?.result?.value ?? res?.result?.description ?? null };
    }

    case 'console': {
      return { ok: true, action: 'console', entries: sess.consoleLogs.slice(-50) };
    }

    default:
      throw new Error(`Action non supportée : ${action}`);
  }
}

process.once('exit', () => {
  void closeBrowserSession();
});
