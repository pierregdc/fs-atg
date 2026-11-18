import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const panelPath = new URL('../plugin/sidecars/fs_atg_panel/index.html', import.meta.url);

test('panneau Antigravity : markup cohérent et scripts syntaxiquement valides', async () => {
  const html = await readFile(panelPath, 'utf8');
  const markup = html.slice(0, html.search(/<script\b/i));
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicated)], [], 'les identifiants DOM doivent être uniques');

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert.ok(scripts.length >= 1, 'le panneau doit contenir son script de contrôle');
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});

test('panneau Antigravity : aucun état de compte n’est inventé avant vérification', async () => {
  const html = await readFile(panelPath, 'utf8');
  assert.match(html, /modelAvailability/);
  assert.match(html, /Disponibilité non vérifiée/);
  assert.match(html, /id="cnt-light">—<\/span>/);
  assert.match(html, /id="toggleKeyVisibility"/);
  assert.match(html, /id="mcpTransport"/);
  assert.match(html, /Quota Antigravity : non exposé au connecteur/);
  assert.doesNotMatch(html, /URL de base API/);
  assert.doesNotMatch(html, /baseUrlInput/);
  assert.doesNotMatch(html, /Jeton enregistré et actif/);
});
