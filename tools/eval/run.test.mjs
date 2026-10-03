import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { evaluate, isCorrect } from './run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gt = {
  1: {
    layout: 'pregnancy',
    page_type: 3,
    slots: [
      { key: 'p03.poids_kg.v2_t1', kind: 'text', value: '62.7' },
      { key: 'p03.ta.v2_t1', kind: 'text', value: '104/74' },
      { key: 'p03.fer.v1_t1', kind: 'text', value: '' },
      { key: 'p03.groupage_b', kind: 'checkbox', value: true },
      { key: 'p03.groupage_a', kind: 'checkbox', value: false },
      { key: 'p03.examen_fait_par.v2_t1', kind: 'text', value: '<staff>' },
    ],
  },
};
const truth = { 1: Object.fromEntries(gt[1].slots.map((s) => [s.key, s.value])) };

test('truth scores 100 %, empty scores 0 % on non-empty slots and 100 % on empty ones', () => {
  const t = evaluate(gt, truth, ['1']);
  assert.deepEqual([t.overall.all.n, t.overall.all.correct], [6, 6]);
  const e = evaluate(gt, {}, ['1']);
  assert.deepEqual(e.overall.non_empty, { n: 4, correct: 0 });
  assert.deepEqual(e.overall.empty, { n: 2, correct: 2 });
  assert.deepEqual(e.missing_pages, ['1']);
});

test('one wrong value gives the right count; noise in spacing and accents is forgiven', () => {
  const pred = { 1: { ...truth[1], 'p03.ta.v2_t1': '104/75', 'p03.poids_kg.v2_t1': '6 2,7', 'p03.examen_fait_par.v2_t1': 'Dr X' } };
  const r = evaluate(gt, pred, ['1']);
  assert.deepEqual(r.overall.all, { n: 6, correct: 5 });
  assert.deepEqual(r.by_key['p03.ta.v2_t1'].non_empty, { n: 1, correct: 0 });
  assert.deepEqual(r.by_layout.pregnancy.all, { n: 6, correct: 5 });
});

test('a prediction for an empty cell is wrong, a ticked box read as unticked is wrong', () => {
  assert.equal(isCorrect(gt[1].slots[2], 'Oui'), false);
  assert.equal(isCorrect(gt[1].slots[3], false), false);
  assert.equal(isCorrect(gt[1].slots[3], 'true'), true);
});

test('CLI on the real ground truth: truth 100 %, empty 0 % on non-empty slots', async (t) => {
  const real = await readFile(join(here, 'data', 'ground_truth.json'), 'utf8').catch(() => null);
  if (!real) return t.skip('run `make truth` first');
  const out = await mkdtemp(join(tmpdir(), 'eval-'));
  const run = async (extractor) => {
    await promisify(execFile)('node', [join(here, 'run.mjs'), '--extractor', extractor, '--out', out]);
    const files = (await readdir(out)).sort();
    return JSON.parse(await readFile(join(out, files.at(-1)), 'utf8'));
  };
  const a = await run('truth');
  assert.equal(a.overall.all.correct, a.overall.all.n);
  assert.ok(a.overall.all.n > 0);
  await new Promise((r) => setTimeout(r, 5));
  const b = await run('empty');
  assert.equal(b.overall.non_empty.correct, 0);
  assert.equal(b.overall.empty.correct, b.overall.empty.n);
});

test('a letter missing from the handwriting font is not counted as a model error', () => {
  const slot = { kind: 'text', value: 'Néant' };
  assert.ok(isCorrect(slot, 'N ant'));
  assert.ok(isCorrect(slot, 'Neant'));
  assert.ok(!isCorrect(slot, 'Nant!'));
  assert.ok(!isCorrect(slot, ''));
});
