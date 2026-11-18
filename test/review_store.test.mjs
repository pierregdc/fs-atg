import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyReview, stageReview, undoReview } from '../plugin/review_store.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fs-atg-review-'));
  const storeDir = join(root, '.reviews');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'app.js'), 'export const answer = 1;\n', 'utf8');
  return { root, storeDir };
}

test('dry-run : la revue montre un diff, applique puis restaure sans écrire avant approbation', async () => {
  const { root, storeDir } = await fixture();
  try {
    const review = stageReview(root, [
      { path: 'src/app.js', content: 'export const answer = 2;\n' },
      { path: 'src/new.js', content: 'export const created = true;\n' },
    ], { storeDir });
    assert.equal(review.status, 'pending');
    assert.equal(review.files.length, 2);
    assert.match(review.files[0].diff, /- export const answer = 1/);
    assert.equal(await readFile(join(root, 'src', 'app.js'), 'utf8'), 'export const answer = 1;\n');

    const applied = applyReview(review.id, { storeDir });
    assert.equal(applied.status, 'applied');
    assert.equal(await readFile(join(root, 'src', 'app.js'), 'utf8'), 'export const answer = 2;\n');
    assert.equal(await readFile(join(root, 'src', 'new.js'), 'utf8'), 'export const created = true;\n');

    const undone = undoReview(review.id, { storeDir });
    assert.equal(undone.status, 'undone');
    assert.equal(await readFile(join(root, 'src', 'app.js'), 'utf8'), 'export const answer = 1;\n');
    await assert.rejects(() => readFile(join(root, 'src', 'new.js'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dry-run : l’application refuse d’écraser un fichier modifié après la revue', async () => {
  const { root, storeDir } = await fixture();
  try {
    const review = stageReview(root, [{ path: 'src/app.js', content: 'export const answer = 2;\n' }], { storeDir });
    await writeFile(join(root, 'src', 'app.js'), 'export const answer = 99;\n', 'utf8');
    assert.throws(() => applyReview(review.id, { storeDir }), /a changé depuis le dry-run/);
    assert.equal(await readFile(join(root, 'src', 'app.js'), 'utf8'), 'export const answer = 99;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dry-run : undo refuse d’écraser une modification faite après application', async () => {
  const { root, storeDir } = await fixture();
  try {
    const review = stageReview(root, [{ path: 'src/app.js', content: 'export const answer = 2;\n' }], { storeDir });
    applyReview(review.id, { storeDir });
    await writeFile(join(root, 'src', 'app.js'), 'export const answer = 99;\n', 'utf8');
    assert.throws(() => undoReview(review.id, { storeDir }), /a changé depuis l’application/);
    assert.equal(await readFile(join(root, 'src', 'app.js'), 'utf8'), 'export const answer = 99;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dry-run : chemins normalisés et sensibles sont refusés avant snapshot', async () => {
  const { root, storeDir } = await fixture();
  try {
    assert.throws(() => stageReview(root, [
      { path: 'src/app.js', content: 'export const answer = 2;\n' },
      { path: 'src\\app.js', content: 'export const answer = 3;\n' },
    ], { storeDir }), /dupliqué/);
    assert.throws(
      () => stageReview(root, [{ path: 'secrets.pem', content: 'never persist this' }], { storeDir }),
      /Chemin sensible/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
