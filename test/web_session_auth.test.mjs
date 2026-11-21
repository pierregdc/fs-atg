import assert from 'node:assert/strict';
import test from 'node:test';

import { extractSessionCookieFromCdpCookies } from '../plugin/browser_auth.mjs';
import {
  clearWebAccessCache,
  DEFAULT_STATE,
  extractSetCookieValue,
  fetchAccessTokenFromWebSession,
  parseApiTokenResponse,
  primeWebAccessCache,
  resolveAuthToken,
} from '../plugin/fs_core.mjs';

test('parseApiTokenResponse gère secondes, millisecondes, expiresIn, fallback 300s et payload invalide', () => {
  const now = 1_700_000_000_000;

  // Payload sans accessToken
  assert.equal(parseApiTokenResponse(null, now), null);
  assert.equal(parseApiTokenResponse({ expiresIn: 300 }, now), null);
  assert.equal(parseApiTokenResponse({ accessToken: '   ' }, now), null);

  // expiresAt en secondes Unix
  const secRes = parseApiTokenResponse({ accessToken: 'jwt-1', expiresAt: 1_700_000_600 }, now);
  assert.deepEqual(secRes, { accessToken: 'jwt-1', expiresAtMs: 1_700_000_600_000 });

  // expiresAt en millisecondes Unix
  const msRes = parseApiTokenResponse({ accessToken: 'jwt-2', expiresAt: 1_700_000_900_000 }, now);
  assert.deepEqual(msRes, { accessToken: 'jwt-2', expiresAtMs: 1_700_000_900_000 });

  // expiresIn quand expiresAt absent ou expiré
  const expInRes = parseApiTokenResponse({ accessToken: 'jwt-3', expiresIn: 120 }, now);
  assert.deepEqual(expInRes, { accessToken: 'jwt-3', expiresAtMs: now + 120_000 });

  const expiredAtRes = parseApiTokenResponse({ accessToken: 'jwt-4', expiresAt: 1_600_000_000, expiresIn: 180 }, now);
  assert.deepEqual(expiredAtRes, { accessToken: 'jwt-4', expiresAtMs: now + 180_000 });

  // Fallback par défaut 300s
  const fallbackRes = parseApiTokenResponse({ accessToken: 'jwt-5' }, now);
  assert.deepEqual(fallbackRes, { accessToken: 'jwt-5', expiresAtMs: now + 300_000 });
});

test('extractSetCookieValue extrait next-auth.session-token et __Secure-next-auth.session-token et ignore les cookies expirés', () => {
  const h1 = new Headers();
  h1.append('Set-Cookie', 'next-auth.session-token=tok-std; Path=/; HttpOnly');
  assert.deepEqual(extractSetCookieValue(h1), {
    name: 'next-auth.session-token',
    value: 'tok-std',
  });

  const h2 = new Headers();
  h2.append('Set-Cookie', 'next-auth.session-token=tok-std; Path=/');
  h2.append('Set-Cookie', '__Secure-next-auth.session-token=tok-sec; Path=/; Secure; HttpOnly');
  assert.deepEqual(extractSetCookieValue(h2), {
    name: '__Secure-next-auth.session-token',
    value: 'tok-sec',
  });

  const hExpired = new Headers();
  hExpired.append('Set-Cookie', 'next-auth.session-token=dead; Max-Age=0; Path=/');
  hExpired.append('Set-Cookie', '__Secure-next-auth.session-token=dead2; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/');
  assert.equal(extractSetCookieValue(hExpired), null);
});

test('extractSessionCookieFromCdpCookies gère simple, __Secure-, chunké .0/.1 et ignore domaines tiers', () => {
  // Domaine tiers ignoré
  assert.equal(
    extractSessionCookieFromCdpCookies([
      { domain: '.evil.example', name: 'next-auth.session-token', value: 'bad' },
    ]),
    null
  );

  // Cookie simple + device id
  const simple = extractSessionCookieFromCdpCookies([
    { domain: 'ia.francestudent.org', name: 'next-auth.session-token', value: 'sess-abc' },
    { domain: '.francestudent.org', name: 'francestudent-device-id', value: 'dev-123' },
  ]);
  assert.deepEqual(simple, {
    sessionToken: 'sess-abc',
    cookieName: 'next-auth.session-token',
    deviceId: 'dev-123',
  });

  // __Secure- prioritaire
  const secure = extractSessionCookieFromCdpCookies([
    { domain: 'ia.francestudent.org', name: 'next-auth.session-token', value: 'std' },
    { domain: 'ia.francestudent.org', name: '__Secure-next-auth.session-token', value: 'sec' },
  ]);
  assert.deepEqual(secure, {
    sessionToken: 'sec',
    cookieName: '__Secure-next-auth.session-token',
    deviceId: null,
  });

  // Cookies chunkés NextAuth .0 / .1 (dans le désordre)
  const chunked = extractSessionCookieFromCdpCookies([
    { domain: '.ia.francestudent.org', name: '__Secure-next-auth.session-token.1', value: 'partB' },
    { domain: '.ia.francestudent.org', name: '__Secure-next-auth.session-token.0', value: 'partA-' },
    { domain: 'ia.francestudent.org', name: 'francestudent-device-id', value: 'dev-999' },
  ]);
  assert.deepEqual(chunked, {
    sessionToken: 'partA-partB',
    cookieName: '__Secure-next-auth.session-token',
    deviceId: 'dev-999',
  });
});

test('fetchAccessTokenFromWebSession retourne le JWT + rotation Set-Cookie et lève sessionExpired sur 401/302', async () => {
  let capturedUrl = '';
  let capturedInit = null;
  const okHeaders = new Headers({ 'Content-Type': 'application/json' });
  okHeaders.append('Set-Cookie', '__Secure-next-auth.session-token=rotated-cookie; Path=/; HttpOnly');

  const okRes = await fetchAccessTokenFromWebSession(
    { sessionToken: 'init-cookie', cookieName: '__Secure-next-auth.session-token', deviceId: 'dev-1' },
    {
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(JSON.stringify({ accessToken: 'jwt-fresh', expiresIn: 300 }), {
          status: 200,
          headers: okHeaders,
        });
      },
    }
  );
  assert.equal(capturedUrl, 'https://ia.francestudent.org/api/auth/api-token');
  assert.equal(capturedInit.redirect, 'manual');
  assert.match(capturedInit.headers.Cookie, /__Secure-next-auth\.session-token=init-cookie/);
  assert.match(capturedInit.headers.Cookie, /francestudent-device-id=dev-1/);
  assert.equal(capturedInit.headers['francestudent-device-id'], 'dev-1');
  assert.equal(okRes.accessToken, 'jwt-fresh');
  assert.equal(okRes.renewedCookie, 'rotated-cookie');
  assert.equal(okRes.renewedCookieName, '__Secure-next-auth.session-token');

  await assert.rejects(
    () =>
      fetchAccessTokenFromWebSession(
        { sessionToken: 'expired-cookie', deviceId: 'dev-1' },
        { fetchImpl: async () => new Response('', { status: 401 }) }
      ),
    (err) => err?.sessionExpired === true && err?.status === 401
  );

  await assert.rejects(
    () =>
      fetchAccessTokenFromWebSession(
        { sessionToken: 'redirected-cookie', deviceId: 'dev-1' },
        { fetchImpl: async () => new Response('', { status: 302, headers: { Location: '/login' } }) }
      ),
    (err) => err?.sessionExpired === true && err?.status === 401
  );
});

test('resolveAuthToken gère override env, cache valide, rafraîchissement < 60s, single-flight et fallback clé manuelle', async () => {
  const prevEnv = process.env.FS_ATG_API_KEY;
  try {
    clearWebAccessCache();
    process.env.FS_ATG_API_KEY = 'env-key-123';
    assert.equal(await resolveAuthToken({}), 'env-key-123');
    delete process.env.FS_ATG_API_KEY;

    const st = {
      ...DEFAULT_STATE,
      _ephemeral: true,
      credentialVersion: 'v-test-1',
      webSessionConfigured: true,
      webSession: {
        sessionToken: 'sess-tok-1',
        cookieName: 'next-auth.session-token',
        deviceId: 'dev-42',
        updatedAt: Date.now(),
      },
    };

    // 1. Cache encore valide (> 60s avant expiration) : 0 appel fetch
    let calls = 0;
    primeWebAccessCache('cached-jwt', Date.now() + 180_000, 'v-test-1');
    const tCached = await resolveAuthToken(st, {
      persist: false,
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: 500 });
      },
    });
    assert.equal(tCached, 'cached-jwt');
    assert.equal(calls, 0);

    // 2. Cache proche de l'expiration (< 60s) + appels concurrents = 1 seul appel single-flight
    primeWebAccessCache('soon-expired-jwt', Date.now() + 20_000, 'v-test-1');
    const mockFetch = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      const h = new Headers({ 'Content-Type': 'application/json' });
      h.append('Set-Cookie', 'next-auth.session-token=sess-tok-2; Path=/');
      return new Response(JSON.stringify({ accessToken: 'refreshed-jwt', expiresIn: 600 }), {
        status: 200,
        headers: h,
      });
    };
    const [a, b, c] = await Promise.all([
      resolveAuthToken(st, { persist: false, fetchImpl: mockFetch }),
      resolveAuthToken(st, { persist: false, fetchImpl: mockFetch }),
      resolveAuthToken(st, { persist: false, fetchImpl: mockFetch }),
    ]);
    assert.equal(calls, 1);
    assert.equal(a, 'refreshed-jwt');
    assert.equal(b, 'refreshed-jwt');
    assert.equal(c, 'refreshed-jwt');
    assert.equal(st.webSession.sessionToken, 'sess-tok-2');

    // 3. Fallback clé manuelle si aucune session web
    clearWebAccessCache();
    const fallbackState = {
      ...DEFAULT_STATE,
      _ephemeral: true,
      apiKey: 'manual-api-key',
    };
    assert.equal(await resolveAuthToken(fallbackState), 'manual-api-key');
  } finally {
    clearWebAccessCache();
    if (prevEnv === undefined) delete process.env.FS_ATG_API_KEY;
    else process.env.FS_ATG_API_KEY = prevEnv;
  }
});
