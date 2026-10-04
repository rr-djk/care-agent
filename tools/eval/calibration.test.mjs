// Step 13 tools: Wilson, binning, category fit, variants manifest, calibrate / quality-curve / report on tiny synthetic predictions.
// Needs tsx (calibrate.mjs and quality-curve.mjs import TypeScript): `make test` runs `node --import tsx --test tools/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRecords, fitTable, renderReport } from './calibrate.mjs';
import { fieldRows, toValues } from './predictions.mjs';
import { curve, suggest } from './quality-curve.mjs';
import { buildReport, checkRecords as checkVerify } from './report.mjs';
import { fitCategory, makeBins, wilson } from './stats.mjs';
import { groupOf, manifestEntry, VARIANTS, verifyManifest } from './variants.mjs';

const data = (f) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data', f), 'utf8'));
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Wilson interval: known values, edges, symmetry', () => {
  const [lo, hi] = wilson(9, 10);
  near(lo, 0.5958);
  near(hi, 0.9821);
  assert.deepEqual(wilson(0, 0), [null, null]);
  const [l0, h0] = wilson(0, 20);
  assert.equal(l0, 0);
  near(h0, 0.161);
  const [a, b] = wilson(30, 30);
  near(a, 0.8865); // 30 examples without an error do not reach 95 %
  assert.equal(b, 1);
  const [x, y] = wilson(5, 20);
  const [x2, y2] = wilson(15, 20);
  near(x + y2, 1);
  near(y + x2, 1);
});

const rows = (spec) => spec.flatMap(([score, n, correct]) => Array.from({ length: n }, (_, i) => ({ score, ok: i < correct })));

test('bins: enough examples keep their own bin; fewer than 30 merge into the neighbour; at most 3 bins', () => {
  assert.deepEqual(makeBins(rows([[0.5, 40, 30], [1, 100, 95]])).map((b) => [b.min, b.max, b.n, b.correct]), [[0.5, 0.5, 40, 30], [1, 1, 100, 95]]);
  assert.deepEqual(makeBins(rows([[0.5, 10, 5], [1, 100, 95]])).map((b) => [b.min, b.max, b.n, b.correct]), [[0.5, 1, 110, 100]]); // n < 30: merged
  const four = makeBins(rows([[0.2, 40, 20], [0.4, 35, 20], [0.7, 50, 40], [1, 60, 55]]));
  assert.equal(four.length, 3);
  assert.equal(four.reduce((s, b) => s + b.n, 0), 185);
  assert.deepEqual(makeBins(rows([[1, 10, 10]])).map((b) => b.n), [10]); // a single small bin stays (reported insufficient)
  assert.deepEqual(makeBins([]), []);
});

test('fitCategory: demote on the lower bound, insufficient n gives no number and no demotion, doubt recall', () => {
  const known = (n, correct, quality = 1) => Array.from({ length: n }, (_, i) => ({ quality, ok: i < correct }));
  const all = [...known(200, 199), { quality: 1, ok: false, flagged: true }, { quality: 1, ok: false, flagged: false }].map((r) => ({ ok: r.ok, flagged: r.flagged ?? false }));
  const good = fitCategory(known(200, 199), all);
  assert.equal(good.demote, false); // 199/200: lower bound 0.9644 >= 0.95
  assert.ok(good.low >= 0.95);
  assert.deepEqual([good.doubt.wrong, good.doubt.flagged], [3, 1]);
  const bad = fitCategory(known(200, 180), []);
  assert.equal(bad.demote, true);
  near(bad.accuracy, 0.9);
  const tiny = fitCategory(known(12, 12), []);
  assert.deepEqual([tiny.accuracy, tiny.low, tiny.demote, tiny.n], [null, null, false, 12]);
  assert.equal(fitCategory([], []).accuracy, null);
  assert.equal(fitCategory(known(5, 5), []).doubt.recall, null);
  const lax = fitCategory(known(200, 180), [], { target: 0.8 });
  assert.equal(lax.demote, false);
});

test('variants: ids, entries inherit patient and group, a changed group is leakage', () => {
  const split = data('split.json');
  const pages = data('pages.json').pages;
  for (const page of pages) {
    for (const v of VARIANTS) {
      const e = manifestEntry(page, v.id, split);
      assert.equal(e.group, groupOf(split, page.page_no));
      assert.equal(e.patient, page.patient);
      assert.ok(split.groups[e.group].patients.includes(e.patient), 'the variant patient is in the group of its source');
      assert.equal(e.file, `${page.page_no}/${v.id}.png`);
    }
  }
  const manifest = { variants: pages.flatMap((p) => VARIANTS.map((v) => manifestEntry(p, v.id, split))) };
  verifyManifest(manifest, split, pages);
  const tampered = { variants: [{ ...manifest.variants[0], group: manifest.variants[0].group === 'tune' ? 'verify' : 'tune' }] };
  assert.throws(() => verifyManifest(tampered, split, pages), /leakage/);
  assert.throws(() => verifyManifest({ variants: [{ ...manifest.variants[0], patient: 99 }] }, split, pages), /patient/);
  assert.throws(() => manifestEntry(pages[0], 'nope', split), /unknown variant/);
  assert.throws(() => manifestEntry({ page_no: 999, patient: 1 }, 'glare', split), /no split group/);
});

// --- tiny synthetic predictions ------------------------------------------------------------------------------------
const gt = {
  1: { layout: 'cover', page_type: 1, slots: [{ key: 'a', kind: 'text', value: '12' }, { key: 'b', kind: 'text', value: 'Oui' }, { key: 'c', kind: 'text', value: '' }, { key: 'x', kind: 'checkbox', value: true }, { key: 'y', kind: 'checkbox', value: false }] },
};
const gate = (over = {}) => ({ outcome: 'OK', quality: 1, blur: 2500, isotropy: 0.8, brightness: 200, glare: 0, framing: 1, spread: 120, clipped: 0, black: 0, skew_deg: 0, messages: [], ...over });
const field = (field_id, category, status, verbatim, value, quality = 1, agreement = 1) => ({ field_id, category, type: typeof value === 'boolean' ? 'checkbox' : 'short_text', status, verbatim, value, signals: { agreement, validators_passed: true, ink: 0.1, quality } });
const record = (over = {}) => ({
  page_no: 1, variant: 'clean', layout: 'cover', group: 'calibrate', patient: 1, pipeline_hash: 'h'.repeat(64), model: 'm', gate: gate(), latency: { model_s: 40, wall_s: 41, zones: 3, skipped: 2, cache_hits: 0 },
  fields: [field('a', 'admin_number', 'KNOWN', '12', 12), field('b', 'short_text', 'KNOWN', 'Non', 'Non'), field('c', 'short_text', 'NOT_PROVIDED', '', null), field('x', 'checkbox', 'KNOWN', null, true), field('y', 'checkbox', 'KNOWN', null, false)],
  ...over,
});

test('field rows score against the ground truth; toValues keeps the clean pages only', () => {
  const recs = [record(), record({ variant: 'blur-s2', fields: [field('a', 'admin_number', 'NEEDS_REVIEW', '', null, 1, 0)] })];
  const r = fieldRows(recs, gt);
  assert.equal(r.length, 5 + 1);
  assert.deepEqual(r.filter((x) => x.record.variant === 'clean').map((x) => x.ok), [true, false, true, true, true]);
  assert.equal(r[5].flagged, true);
  assert.deepEqual(toValues(recs), { 1: { a: '12', b: 'Non', c: '', x: true, y: false } });
});

test('calibrate: refuses other splits, photos and another pipeline; fits and reports with insufficient n', () => {
  const hash = 'h'.repeat(64);
  assert.throws(() => checkRecords([record({ group: 'tune' })], hash), /only the calibrate split/);
  assert.throws(() => checkRecords([record({ photo: '1-1', group: 'held_out' })], hash), /only the calibrate split/);
  assert.throws(() => checkRecords([record()], 'z'.repeat(64)), /another pipeline/);
  assert.throws(() => checkRecords([], hash), /no prediction/);
  checkRecords([record(), record({ variant: 'blur-s2' })], hash);

  const r = fieldRows([record()], gt);
  const t = fitTable(r);
  assert.deepEqual(Object.keys(t.categories), ['admin_number', 'checkbox', 'short_text']);
  assert.equal(t.categories.checkbox.accuracy, null); // 2 examples: insufficient n
  assert.equal(t.categories.checkbox.demote, false);
  assert.deepEqual([t.categories.short_text.doubt.wrong, t.categories.short_text.doubt.flagged], [1, 0]); // "Non" for "Oui", KNOWN: silent error
  const md = renderReport(t, r, { pipeline_hash: hash, created_at: 'now', records: 1, pages: 1, variants: 0 });
  assert.match(md, /Decision rule/);
  assert.match(md, /lower \*\*bound|\*\*lower\*\* bound/);
  assert.match(md, /insufficient n/);
  assert.match(md, /Insufficient n\*\*: admin_number, checkbox, short_text/);
});

test('calibrate on enough examples: a 90 % category is demoted and a clean one is kept', () => {
  const many = (n, wrongCount, category) =>
    Array.from({ length: n }, (_, i) => ({ category, field: { status: 'KNOWN', signals: { agreement: 1, quality: 1 } }, ok: i >= wrongCount, flagged: false, quality: 1 }));
  const t = fitTable([...many(200, 20, 'short_text'), ...many(400, 0, 'checkbox')]);
  assert.equal(t.categories.short_text.demote, true);
  assert.equal(t.categories.checkbox.demote, false);
  assert.ok(t.categories.checkbox.low > 0.99);
});

test('quality curve: accuracy of non-empty cells per variant, drop vs clean, threshold suggestion', () => {
  const ok = [field('a', 'admin_number', 'KNOWN', '12', 12), field('b', 'short_text', 'KNOWN', 'Oui', 'Oui')];
  const bad = [field('a', 'admin_number', 'KNOWN', '17', 17), field('b', 'short_text', 'KNOWN', 'Non', 'Non')];
  const recs = [
    record({ fields: ok }),
    record({ variant: 'blur-s1', gate: gate({ blur: 900 }), fields: ok }),
    record({ variant: 'blur-s4', gate: gate({ blur: 12, outcome: 'WARNING' }), fields: bad }),
  ];
  const lines = curve(fieldRows(recs, gt), recs);
  assert.deepEqual(lines.map((l) => l.id), ['clean', 'blur-s1', 'blur-s4']);
  assert.deepEqual(lines.map((l) => l.accuracy), [1, 1, 0]);
  assert.equal(lines[2].clean_accuracy, 1);
  assert.equal(lines[2].outcomes, '0/1/0');
  const s = suggest(lines).find((x) => x.metric === 'blur');
  assert.equal(s.warn.id, 'blur-s4'); // first level whose accuracy fell by >= 5 points
  assert.equal(s.collapse.id, 'blur-s4');
  assert.equal(s.warn.metrics.blur, 12);
  assert.equal(s.current, 250);
});

test('report on a tiny verify file: sections, counts, demotion by the table, refused table, real photo', () => {
  const verify = record({ group: 'verify' });
  const photo = { ...record({ group: 'held_out', page_no: null, photo: '1-1', variant: 'real', layout: 'real_cover' }), fields: [field('p01.region', 'short_text', 'KNOWN', 'Casa-Settat', 'Casa-Settat'), field('p01.dr', 'checkbox', 'KNOWN', null, true)] };
  const labels = { photos: { '1-1.jpg': { fields: [{ key: 'p01.region', kind: 'text', value: 'Casa-Settat' }, { key: 'p01.dr', kind: 'checkbox', value: false }, { key: 'p01.fiche', kind: 'text', value: '?' }] } } };
  const hash = verify.pipeline_hash;
  const entry = (demote) => ({ n: 100, correct: 90, accuracy: 0.9, low: 0.82, high: 0.95, demote, bins: [], doubt: { wrong: 0, flagged: 0, recall: null, low: null, high: null } });
  const table = { pipeline_hash: hash, created_at: 'x', target: 0.95, min_n: 30, categories: { short_text: entry(true), checkbox: entry(false), admin_number: entry(false) } };

  const md = buildReport([verify, photo], gt, labels, table, 'today');
  for (const h of ['## Accuracy per layout', '## Status accuracy', '## Calibration per category', '## Doubt recall', '## Coverage against error', '## Latency per page', '## Clean specimens against the real photo']) assert.match(md, new RegExp(h));
  assert.match(md, /applied \(pipeline_hash matches, 1 categories demoted\)/);
  assert.match(md, /\| cover \| 2\/3 = 66\.7 %/); // non-empty cells: a and the ticked box right, b wrong
  assert.match(md, /\| all pages \| 1 \| 40\.0 \| 40\.0 \| 40\.0 \|/);
  assert.match(md, /with the table \(demoted categories reviewed\)/);
  assert.match(md, /`p01\.dr` read true status KNOWN \(accepted: silent error\)/);
  assert.doesNotMatch(md, /p01\.fiche/); // '?' labels are skipped

  const refused = buildReport([verify], gt, labels, { ...table, pipeline_hash: 'z'.repeat(64) }, 'today');
  assert.match(refused, /REFUSED/);
  assert.doesNotMatch(refused, /with the table/);
  assert.match(buildReport([verify], gt, labels, undefined, 'today'), /none \(rows "with table" omitted\)/);
  assert.throws(() => checkVerify([record({ group: 'calibrate' })]), /verify pages only/);
});
