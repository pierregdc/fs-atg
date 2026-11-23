import { logEvent } from './logger.mjs';

export const WEB_ACTIONS = Object.freeze(['fetch', 'search']);

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function htmlToCleanMarkdown(html = '', baseUrl = '') {
  const raw = String(html || '');
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '';

  const links = [];
  const linkRe = /<a\b[^>]*?\bhref=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(raw)) && links.length < 40) {
    const hrefRaw = m[1].trim();
    const label = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!label || /^(?:javascript|mailto|tel):/i.test(hrefRaw)) continue;
    let url = hrefRaw;
    if (baseUrl) {
      try { url = new URL(hrefRaw, baseUrl).toString(); } catch {}
    }
    if (!links.some((l) => l.url === url)) {
      links.push({ label: label.slice(0, 90), url });
    }
  }

  let body = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style|noscript|svg|iframe|nav|footer|header)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|iframe|nav|footer|header)>/gi, ' ')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<(?:p|div|section|article|tr|br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, ' ');

  body = decodeHtmlEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
    .join('\n')
    .trim();

  return { title, markdown: body, links };
}

export async function executeWebAction(params = {}, { fetchImpl = fetch } = {}) {
  const action = String(params?.action || 'fetch').trim();
  if (!WEB_ACTIONS.includes(action)) {
    throw new Error(`Action fs_web inconnue : "${action}". Actions valides : ${WEB_ACTIONS.join(', ')}`);
  }

  if (action === 'fetch') {
    const rawUrl = String(params.url || '').trim();
    if (!rawUrl) throw new Error('Paramètre "url" requis pour fetch.');
    const targetUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Protocole refusé : ${parsed.protocol}`);
    }
    const maxChars = Math.min(40_000, Math.max(500, Number(params.maxChars) || 12_000));
    const res = await fetchImpl(parsed.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FranceStudentATG/2.3',
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    });
    const contentType = String(res.headers?.get?.('content-type') || '');
    const rawText = await res.text();
    logEvent('info', 'web', 'web.fetch', `GET ${parsed.toString()} (HTTP ${res.status}, ${rawText.length} car.).`);

    if (/application\/json/i.test(contentType)) {
      return {
        ok: res.ok,
        status: res.status,
        url: parsed.toString(),
        contentType,
        content: rawText.slice(0, maxChars),
        truncated: rawText.length > maxChars,
      };
    }

    const { title, markdown, links } = htmlToCleanMarkdown(rawText, parsed.toString());
    return {
      ok: res.ok,
      status: res.status,
      url: parsed.toString(),
      title,
      content: markdown.slice(0, maxChars),
      truncated: markdown.length > maxChars,
      links: links.slice(0, 25),
    };
  }

  if (action === 'search') {
    const query = String(params.query || '').trim();
    if (!query) throw new Error('Paramètre "query" requis pour search.');
    const limit = Math.min(15, Math.max(1, Number(params.limit) || 6));
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchImpl(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FranceStudentATG/2.3',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(12_000),
    });
    const html = await res.text();
    const results = [];
    const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;
    let m;
    while ((m = blockRe.exec(html)) && results.length < limit) {
      let href = decodeHtmlEntities(m[1]);
      const uddg = /[?&]uddg=([^&]+)/.exec(href);
      if (uddg) {
        try { href = decodeURIComponent(uddg[1]); } catch {}
      }
      const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      const snippet = decodeHtmlEntities((m[3] || m[4] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      if (title && /^https?:\/\//i.test(href)) {
        results.push({ title, url: href, snippet });
      }
    }
    logEvent('info', 'web', 'web.search', `Recherche web "${query}" (${results.length} résultat(s)).`);
    return { ok: true, action: 'search', query, count: results.length, results };
  }

  throw new Error(`Action non supportée : ${action}`);
}
