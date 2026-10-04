import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtractedField } from '@care-agent/schema';
import { loadPageSchema } from '@care-agent/schema/node';
import { applyCalibration, loadCalibration, pipelineHash, qualityFactor, type CalibrationTable, type CategoryEntry } from './calibration';
import { reviewItem } from './review';
import { applyLowQuality } from './worker';

const schema = loadPageSchema('cover');
const idOf = (category: string) => schema.fields.find((f) => f.category === category)!.id;
const entry = (over: Partial<CategoryEntry>): CategoryEntry => ({
  n: 200, correct: 190, accuracy: 0.95, low: 0.91, high: 0.97, demote: false, bins: [], doubt: { wrong: 0, flagged: 0, recall: null, low: null, high: null }, ...over,
});
const table = (categories: Record<string, CategoryEntry>, hash = pipelineHash()): CalibrationTable => ({ pipeline_hash: hash, created_at: 'x', target: 0.95, min_n: 30, categories });
const field = (field_id: string, over: Partial<ExtractedField> = {}): ExtractedField => ({
  field_id, value: 'x', verbatim: 'x', status: 'KNOWN', confidence_signals: { agreement: 1, validators_passed: true, quality: 1 }, source_page: 1, ...over,
});

test('pipeline_hash is stable and changes with the model tag', () => {
  const a = pipelineHash();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(pipelineHash(), a);
  const before = process.env.MODEL;
  process.env.MODEL = 'another-model:1b';
  try {
    assert.notEqual(pipelineHash(), a);
  } finally {
    if (before === undefined) delete process.env.MODEL;
    else process.env.MODEL = before;
  }
  assert.equal(pipelineHash(), a);
});

test('a table of another pipeline is refused and logged; a matching one is loaded; a missing one is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calib-'));
  const logs: string[] = [];
  const save = (name: string, t: CalibrationTable) => {
    writeFileSync(join(dir, name), JSON.stringify(t));
    return join(dir, name);
  };
  const good = save('good.json', table({}));
  assert.equal(loadCalibration(good, pipelineHash(), (m) => logs.push(m))?.pipeline_hash, pipelineHash());
  assert.equal(logs.length, 0);
  assert.equal(loadCalibration(save('bad.json', table({}, 'f'.repeat(64))), pipelineHash(), (m) => logs.push(m)), undefined);
  assert.match(logs[0], /table ignored, pipeline_hash ffffffffffff != current/);
  assert.equal(loadCalibration(join(dir, 'nope.json'), pipelineHash(), (m) => logs.push(m)), undefined);
  assert.match(logs[1], /no table/);
  writeFileSync(join(dir, 'junk.json'), '{"pipeline_hash": 1}');
  assert.equal(loadCalibration(join(dir, 'junk.json'), pipelineHash(), (m) => logs.push(m)), undefined);
  assert.match(logs[2], /unreadable/);
});

test('demotion rule: KNOWN fields of a demoted category go to review; others get calibrated = accuracy x quality', () => {
  const [text, box, free] = [idOf('short_text'), idOf('checkbox'), idOf('free_text')];
  const t = table({
    short_text: entry({ accuracy: 0.9, low: 0.8, high: 0.95, n: 120, demote: true }),
    checkbox: entry({ accuracy: 0.99, low: 0.98, high: 0.995, n: 900 }),
    free_text: entry({ n: 10, correct: 10, accuracy: null, low: null, high: null }), // insufficient: no evidence either way
  });
  const half = field(box, { confidence_signals: { agreement: 1, validators_passed: true, quality: 0.5 } });
  const out = applyCalibration(t, schema, [field(text), half, field(free), field(text, { status: 'NEEDS_REVIEW', reason: 'x' })]);
  assert.equal(out[0].status, 'NEEDS_REVIEW');
  assert.equal(out[0].reason, 'low_category_confidence');
  assert.equal(out[0].calibrated, 0.9);
  assert.equal(out[1].status, 'KNOWN');
  assert.equal(out[1].calibrated, 0.495); // 0.99 x quality 0.5
  assert.deepEqual(out[1].calibration, { low: 0.49, high: 0.4975, n: 900 });
  assert.equal(out[2].calibrated, undefined);
  assert.equal(out[2].status, 'KNOWN');
  assert.equal(out[3].reason, 'x'); // already flagged: untouched
  assert.equal(out[3].calibrated, undefined);
  assert.deepEqual(applyCalibration(undefined, schema, [field(text)]), [field(text)]);
});

test('LOW_QUALITY rescales calibrated to the page quality and keeps a category demotion reason', () => {
  const [text, box] = [idOf('short_text'), idOf('checkbox')];
  const t = table({ short_text: entry({ accuracy: 0.8, low: 0.6, high: 0.9, demote: true }), checkbox: entry({ accuracy: 0.98, low: 0.96, high: 0.99 }) });
  const read = applyCalibration(t, schema, [field(text), field(box)]);
  const [demoted, kept] = applyLowQuality({ flags: ['LOW_QUALITY'] }, read);
  assert.equal(demoted.reason, 'low_category_confidence');
  assert.equal(demoted.calibrated, 0.4);
  assert.equal(kept.reason, 'low_quality');
  assert.equal(kept.calibrated, 0.49);
  assert.equal(kept.confidence_signals.quality, qualityFactor('WARNING'));
});

test('the review item of a demoted field says why in French; the percentage lives in detail_fr only', () => {
  const [text] = [idOf('short_text')];
  const [f] = applyCalibration(table({ short_text: entry({ accuracy: 0.9, low: 0.8, high: 0.95, n: 120, demote: true }) }), schema, [field(text)]);
  const item = reviewItem('p', f, 'Région');
  assert.equal(item.reason_code, 'low_category_confidence');
  assert.equal(item.kind, 'doubt');
  assert.match(item.text_fr, /difficile à lire/);
  assert.doesNotMatch(item.text_fr, /%/);
  assert.equal(item.detail_fr, 'confiance estimée 90 % [80–95 %] sur 120 exemples');
  assert.equal(reviewItem('p', field(text), 'Région').detail_fr, undefined);
});
