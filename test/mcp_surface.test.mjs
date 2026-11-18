import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverPath = fileURLToPath(new URL('../plugin/mcp_server.mjs', import.meta.url));

test('surface MCP : les outils de revue, état et diagnostic sont publiés sans identifiant', async (t) => {
  const appData = await mkdtemp(join(tmpdir(), 'fs-atg-mcp-surface-'));
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, APPDATA: appData, FS_ATG_API_KEY: '' },
  });
  t.after(async () => {
    if (!child.killed) child.kill();
    await rm(appData, { recursive: true, force: true });
  });

  const tools = await new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('Délai de démarrage MCP dépassé.')), 8_000);
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.on('error', fail);
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) fail(new Error(text));
    });
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        }
        if (message.id === 2) {
          clearTimeout(timeout);
          resolve(message.result?.tools ?? []);
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'surface-test', version: '1.0.0' } },
    }) + '\n');
  });

  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes('fs_delegate'));
  assert.ok(names.includes('fs_apply_review'));
  assert.ok(names.includes('fs_undo_review'));
  assert.ok(names.includes('fs_status'));
  assert.ok(names.includes('fs_diagnostics'));
});
