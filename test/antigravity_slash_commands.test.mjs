import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const nativeCommands = [
  'send', 'plan', 'dry-run', 'low', 'medium', 'high',
  'eco', 'fast', 'new', 'compact', 'diagnostics',
];

test('les commandes France Student sont des skills Antigravity natifs', () => {
  for (const command of nativeCommands) {
    const skill = readFileSync(join(root, 'plugin', 'skills', command, 'SKILL.md'), 'utf8');
    assert.match(skill, new RegExp(`^---\\nname: ${command}\\n`, 'u'));
    assert.match(skill, /^description: .+/mu);
    assert.doesNotMatch(skill, /disable-slash-command:\s*true/u);
  }
});

test('le panneau Antigravity ne possède plus sa propre autocomplétion slash', () => {
  const panel = readFileSync(join(root, 'plugin', 'sidecars', 'fs_atg_panel', 'index.html'), 'utf8');
  assert.doesNotMatch(panel, /const SLASH_COMMANDS/u);
  assert.doesNotMatch(panel, /function updateCmdBar/u);
  assert.doesNotMatch(panel, /id="cmdBar"/u);
  assert.match(panel, /commandes France Student sont disponibles dans le chat Antigravity/u);
});

test('les raccourcis de routage délèguent immédiatement, sans lecture native préalable', () => {
  const directives = new Map([
    ['send', '/send '],
    ['plan', '/plan '],
    ['dry-run', '/dry-run '],
    ['low', '/low '],
    ['medium', '/medium '],
    ['high', '/high '],
    ['eco', '/eco '],
    ['fast', '/fast '],
  ]);
  for (const [command, directive] of directives) {
    const skill = readFileSync(join(root, 'plugin', 'skills', command, 'SKILL.md'), 'utf8');
    assert.ok(skill.includes(`\`${directive}\` + la demande exacte`));
    assert.match(skill, /Appelle immédiatement `fs_delegate`/u);
    assert.match(skill, /fs_job_status/u);
  }
});
