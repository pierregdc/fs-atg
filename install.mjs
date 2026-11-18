import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'plugin');
if (!fs.existsSync(src)) {
  throw new Error(`Plugin introuvable : ${src}`);
}
const dest = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'fs-atg');
fs.mkdirSync(dest, { recursive: true });
// Runtime state belongs to the installed plugin, never to this source tree.
// In particular, do not overwrite an existing key/session/history when a new
// build is installed from a development folder that happens to contain a
// sidecar state file.
const runtimeEntries = new Set(['.fsatg_state.json', '.fsatg_live.json', '.fsatg_slots', '.fsatg_reviews']);
fs.cpSync(src, dest, {
  recursive: true,
  force: true,
  filter: (sourcePath) => !runtimeEntries.has(path.basename(sourcePath)),
});

// Version 0.6.3 keeps only concise native slash commands and preserves state.
// native slash commands. cpSync does not remove files that disappeared from
// the source, so remove only the known obsolete skill directories. Runtime
// state lives elsewhere and is deliberately untouched.
const obsoleteSlashSkills = [
  'francestudent', 'fs-send', 'fs-plan', 'fs-dry-run',
  'fs-eco', 'fs-fast', 'fs-quality', 'fs-security', 'fs-refactor',
  'fs-medium', 'fs-fable', 'fs-gpt', 'fs-new', 'fs-compact',
  'fs-diagnostics', 'fs-apply', 'fs-undo',
];
const installedSkillRoot = path.resolve(dest, 'skills');
for (const name of obsoleteSlashSkills) {
  const candidate = path.resolve(installedSkillRoot, name);
  if (!candidate.startsWith(`${installedSkillRoot}${path.sep}`)) {
    throw new Error(`Skill obsolète hors plugin refusé : ${name}`);
  }
  fs.rmSync(candidate, { recursive: true, force: true });
}

const serverPath = path.join(dest, 'mcp_server.mjs').replaceAll('\\', '/');
const mcpConfig = {
  mcpServers: {
    'fs-atg': { command: 'node', args: [serverPath] },
  },
};
fs.writeFileSync(path.join(dest, 'mcp_config.json'), JSON.stringify(mcpConfig, null, 2) + '\n');

execSync('npm install --omit=dev', { cwd: dest, stdio: 'inherit' });
console.log(`\nPlugin fs-atg installé dans : ${dest}`);
console.log('Rechargez Antigravity puis collez votre clé API ou sessionToken dans Paramètres.');
