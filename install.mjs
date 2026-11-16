import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const src = path.resolve('plugin');
const dest = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'fs-atg');
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true, force: true });

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
