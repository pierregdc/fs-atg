import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

async function bundled(source, name, vscode) {
  const dir = await mkdtemp(join(tmpdir(), 'fs-atg-vsix-features-'));
  const outfile = join(dir, `${name}.cjs`);
  await build({
    entryPoints: [fileURLToPath(new URL(source, import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['vscode'],
    outfile,
  });
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { value: require(outfile), dispose: () => rm(dir, { recursive: true, force: true }) };
  } finally {
    Module._load = originalLoad;
  }
}

function routerVscode(profile = 'eco') {
  return { workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'routingProfile' ? profile : fallback }) } };
}

test('VSIX routing: slash controls stay local and profiles select their intended tier', async t => {
  const { value: router, dispose } = await bundled('../src/router.ts', 'router', routerVscode());
  t.after(dispose);

  const parsed = router.parseTaskControls('/plan /security /fable audite ce module', 'gpt-');
  assert.equal(parsed.prompt, 'audite ce module');
  assert.equal(parsed.executionMode, 'plan');
  assert.equal(parsed.routingProfile, 'security');
  assert.equal(parsed.explicit, 'fable');
  assert.equal(router.parseTaskControls('/auto corrige le typo', 'fable').explicit, undefined);

  const cfg = {
    allowed: [], blocked: [],
    tiers: { light: ['haiku'], medium: ['sonnet'], heavy: ['fable'] },
    routingProfile: 'eco',
  };
  const models = ['haiku-1', 'sonnet-1', 'fable-1'];
  assert.equal(router.pickModel('/eco corrige un typo', models, cfg).model, 'haiku-1');
  assert.equal(router.pickModel('/security verifie les acces', models, cfg).model, 'fable-1');
  assert.equal(router.pickModel('/low corrige un typo', models, cfg).model, 'haiku-1');
  assert.equal(router.pickModel('/high verifie les acces', models, cfg).model, 'fable-1');
  assert.equal(router.pickModel('/dry-run /refactor simplifie', models, cfg).executionMode, 'dry-run');
});

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath.replace(/\\/g, '/'); this.scheme = 'file'; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(join(base.fsPath, ...parts)); }
  static from(parts) { return new Uri(parts.path); }
}

test('VSIX undo: a user change after apply is reported and never overwritten', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fs-atg-undo-'));
  const file = join(root, 'sample.txt');
  await writeFile(file, 'before\n', 'utf8');
  const vscode = {
    Uri,
    workspace: {
      workspaceFolders: [{ uri: Uri.file(root) }],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      asRelativePath: uri => uri.fsPath.slice(root.length + 1),
      findFiles: async () => [],
      fs: {
        stat: async uri => ({ size: (await stat(uri.fsPath)).size }),
        readFile: async uri => new Uint8Array(await readFile(uri.fsPath)),
        writeFile: async (uri, bytes) => { await writeFile(uri.fsPath, bytes); },
        createDirectory: async uri => { await mkdir(uri.fsPath, { recursive: true }); },
        delete: async uri => { await unlink(uri.fsPath); },
      },
    },
  };
  const { value: applier, dispose } = await bundled('../src/applier.ts', 'applier', vscode);
  t.after(async () => { dispose(); await rm(root, { recursive: true, force: true }); });

  const journal = new applier.ChangeJournal();
  const uri = Uri.file(file);
  await journal.capture('job-1', 'sample.txt', uri);
  await writeFile(file, 'provider result\n', 'utf8');
  await journal.markApplied('job-1', 'sample.txt', uri);

  await writeFile(file, 'user edit\n', 'utf8');
  const protectedResult = await journal.restore('job-1');
  assert.deepEqual(protectedResult.restored, []);
  assert.deepEqual(protectedResult.changed, ['sample.txt']);
  assert.equal(await readFile(file, 'utf8'), 'user edit\n');

  await writeFile(file, 'provider result\n', 'utf8');
  const restored = await journal.restore('job-1');
  assert.deepEqual(restored.restored, ['sample.txt']);
  assert.equal(await readFile(file, 'utf8'), 'before\n');
});
