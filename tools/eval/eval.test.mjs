import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPages, parsePageNo, patientOf, pageTypeOf } from './dedupe.mjs';
import { buildSplit, splitPatients, SEED } from './split.mjs';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
const load = (f) => readFile(join(dataDir, f), 'utf8').then(JSON.parse, () => null);

// Synthetic pages so the logic is tested even without the generated JSON.
const synthetic = Array.from({ length: 80 }, (_, i) => ({ page_no: i + 1, patient: patientOf(i + 1) }));
const heldOut = [{ file: '1-1.jpg' }, { file: '1-2.jpg' }];

test('page number, patient and page type from the page number', () => {
  assert.equal(parsePageNo('dossiers_specimen_10_patientes-07__1O_M-H0E7z.png'), 7);
  assert.equal(parsePageNo('dossiers_specimen_10_patientes-80.png'), 80);
  assert.equal(parsePageNo('1-1.jpg'), null);
  assert.deepEqual([patientOf(1), patientOf(8), patientOf(9), patientOf(80)], [1, 1, 2, 10]);
  assert.deepEqual([pageTypeOf(1), pageTypeOf(8), pageTypeOf(9), pageTypeOf(80)], [1, 8, 1, 8]);
});

test('buildPages groups duplicates and rejects conflicting content', () => {
  const p = buildPages([
    { file: 'x-02.png', sha256: 'b' },
    { file: 'x-01__a.png', sha256: 'a' },
    { file: 'x-01.png', sha256: 'a' },
  ]);
  assert.deepEqual(p.map((x) => [x.page_no, x.files.length]), [[1, 2], [2, 1]]);
  assert.throws(() => buildPages([{ file: 'x-01.png', sha256: 'a' }, { file: 'x-01__z.png', sha256: 'b' }]));
});

function checkSplit(split, pages) {
  const groups = Object.values(split.groups);
  const patients = groups.flatMap((g) => g.patients);
  assert.equal(new Set(patients).size, patients.length, 'a patient is in two groups');
  assert.deepEqual([...patients].sort((a, b) => a - b), [...new Set(pages.map((p) => p.patient))].sort((a, b) => a - b));
  const pageNos = groups.flatMap((g) => g.pages).sort((a, b) => a - b);
  assert.deepEqual(pageNos, pages.map((p) => p.page_no).sort((a, b) => a - b), 'pages not covered exactly once');
  for (const f of split.held_out) {
    assert.ok(!JSON.stringify(split.groups).includes(f), `${f} appears in a group`);
  }
}

test('split (synthetic): partition, sizes, determinism', () => {
  const s = buildSplit(synthetic, heldOut);
  checkSplit(s, synthetic);
  assert.deepEqual(Object.values(s.groups).map((g) => g.patients.length), [4, 3, 3]);
  assert.equal(pages(s), 80);
  assert.deepEqual(buildSplit(synthetic, heldOut), s);
  assert.deepEqual(splitPatients([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], SEED), splitPatients([10, 9, 8, 7, 6, 5, 4, 3, 2, 1], SEED));
  assert.notDeepEqual(splitPatients([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1), splitPatients([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2));
});
const pages = (s) => Object.values(s.groups).reduce((n, g) => n + g.pages.length, 0);

test('generated pages.json / split.json are consistent', async (t) => {
  const p = await load('pages.json');
  const s = await load('split.json');
  if (!p || !s) return t.skip('run `make pages` to generate the JSON files');
  assert.equal(p.pages.length, 80);
  assert.equal(p.held_out.length, 5);
  checkSplit(s, p.pages);
  assert.equal(s.seed, SEED);
  assert.deepEqual(s, buildSplit(p.pages, p.held_out)); // split.json matches a fresh run
});
