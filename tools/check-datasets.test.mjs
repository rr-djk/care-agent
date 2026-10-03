import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDatasets } from './check-datasets.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

// Builds <tmp>/datasets with a.txt, b.txt (same content as a) and c.txt; root.txt sits in <tmp>.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'care-ds-'));
  const dir = join(root, 'datasets');
  await mkdir(join(dir, 'sub'), { recursive: true });
  const files = { 'a.txt': 'same', 'sub/b.txt': 'same', 'c.txt': 'other' };
  for (const [p, c] of Object.entries(files)) await writeFile(join(dir, p), c);
  await writeFile(join(root, 'root.txt'), 'parent');
  const all = { ...files, 'root.txt': 'parent' };
  const manifest = { files: Object.entries(all).map(([path, c]) => ({ path, bytes: c.length, sha256: sha(c) })) };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

test('ok case, parent fallback and duplicates', async () => {
  const dir = await fixture();
  const r = await checkDatasets(dir);
  assert.equal(r.total, 4);
  assert.equal(r.ok, 4);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.parentUsed, ['root.txt']);
  assert.equal(r.duplicates, 2);
});

test('modified file is detected', async () => {
  const dir = await fixture();
  await writeFile(join(dir, 'c.txt'), 'OTHER'); // same size, different hash
  const r = await checkDatasets(dir);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^SHA256 c\.txt/);
  await writeFile(join(dir, 'c.txt'), 'longer content');
  assert.match((await checkDatasets(dir)).problems[0], /^SIZE c\.txt/);
});

test('missing file is detected', async () => {
  const dir = await fixture();
  const { rm } = await import('node:fs/promises');
  await rm(join(dir, 'sub/b.txt'));
  const r = await checkDatasets(dir);
  assert.deepEqual(r.problems, ['MISSING sub/b.txt']);
});
