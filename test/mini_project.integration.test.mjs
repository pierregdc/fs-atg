import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { estimateTokens, executeClientTool, workspaceSketch } from '../plugin/fs_core.mjs';

const fixture = new URL('./fixtures/mini-app/', import.meta.url);
const task = 'Ajoute une persistance localStorage pour les tâches, sans changer le visuel.';

async function copiedMiniApp() {
  const root = await mkdtemp(join(tmpdir(), 'fs-atg-mini-app-'));
  await cp(fixture, root, { recursive: true });
  return root;
}

test('mini-projet : les outils lisent et modifient seulement les fichiers nécessaires', async () => {
  const root = await copiedMiniApp();
  const written = new Set();
  try {
    const tree = executeClientTool(root, { name: 'list_directory', arguments: { path: '.', depth: 2 } }, written);
    assert.match(tree.output, /src\/app\.js/);
    assert.match(tree.output, /styles\.css/);

    const matches = executeClientTool(root, { name: 'search_files', arguments: { query: 'TODO', path: 'src' } }, written);
    assert.match(matches.output, /src\/app\.js/);

    const read = executeClientTool(root, { name: 'read_file', arguments: { path: 'src/app.js', start_line: 1, end_line: 12 } }, written);
    assert.match(read.output, /renderTask/);
    assert.doesNotMatch(read.output, /TODO: Persist/);

    const edit = executeClientTool(root, {
      name: 'edit_file',
      arguments: {
        path: 'src/app.js',
        old_text: '// TODO: Persist tasks in localStorage.',
        new_text: 'localStorage.setItem(\'mini-tasks\', JSON.stringify([]));',
      },
    }, written);
    assert.equal(edit.isError, false);
    assert.deepEqual([...written], ['src/app.js']);

    const updated = await readFile(join(root, 'src', 'app.js'), 'utf8');
    assert.match(updated, /localStorage\.setItem/);

    const create = executeClientTool(root, {
      name: 'write_file',
      arguments: { path: 'src/storage.js', content: 'export const key = "mini-tasks";\n' },
    }, written);
    assert.equal(create.isError, false);
    assert.deepEqual([...written].sort(), ['src/app.js', 'src/storage.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mini-projet : le contexte minimal évite de recopier les sources', async () => {
  const root = await copiedMiniApp();
  try {
    const files = ['index.html', 'styles.css', 'src/app.js'];
    const contents = await Promise.all(files.map((file) => readFile(join(root, file), 'utf8')));
    const legacyPrompt = `${task}\n\nFichiers joints :\n${files.map((file, i) => `<<<FILE ${file}\n${contents[i]}\n>>>END`).join('\n')}`;
    const targetedPrompt = `${task}\n\nFichiers ciblés : ${files.join(', ')}.`;

    const legacy = estimateTokens(legacyPrompt);
    const minimal = estimateTokens(task);
    const targeted = estimateTokens(targetedPrompt);

    assert.ok(minimal < legacy, `minimal=${minimal}, legacy=${legacy}`);
    assert.ok(targeted < legacy, `targeted=${targeted}, legacy=${legacy}`);
    assert.ok((1 - minimal / legacy) > 0.80, 'le fixture doit démontrer une économie nette');

    const sketch = workspaceSketch(root, 20);
    assert.ok(sketch.includes('src/app.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
