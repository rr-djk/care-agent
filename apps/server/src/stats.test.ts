import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aggregate, referenceAggregates } from './stats';

const r = (field_id: string, value: string) => ({ field_id, value });
const many = (id: string, value: string, n: number) => Array.from({ length: n }, (_, i) => r(`${id}.v${i % 3 + 1}_t${Math.floor(i / 3) + 1}`, value));
const block = (blocks: ReturnType<typeof aggregate>, id: string) => blocks.find((b) => b.id === id)!;

test('bands: systolic and temperature edges fall in the upper band, newborn and mother temperatures are pooled', () => {
  const readings = [
    ...many('p03.ta', '119/80', 5), ...many('p03.ta', '120/80', 5), ...many('p05.ta', '140/90', 5), ...many('p03.ta', '160/100', 5),
    ...many('p05.t_deg', '36.0', 5), ...many('p06.temperature', '37.5', 5), ...many('p06.temperature', '35.9', 5), ...many('p05.t_deg', '38,0', 5),
  ];
  const blocks = aggregate(readings);
  assert.deepEqual(block(blocks, 'bp_systolic').bins.map((b) => b.count), [5, 5, 5, 5]);
  assert.deepEqual(block(blocks, 'temperature').bins.map((b) => b.count), [5, 5, 5, 5]);
  assert.equal(block(blocks, 'bp_systolic').n, 20);
});

test('small cells are hidden (1 to 4 readings), zero stays zero; a malformed reading is ignored', () => {
  const blocks = aggregate([...many('p03.syphilis_tpha_vdrl', 'Neg', 12), ...many('p03.syphilis_tpha_vdrl', 'Pos', 2), r('p03.ta.v1_t1', 'abc'), r('p03.ag_hbs.v1_t1', 'Neg')]);
  assert.deepEqual(block(blocks, 'syphilis').bins, [{ label_fr: 'Négatif', count: 12 }, { label_fr: 'Positif', count: null }]);
  assert.deepEqual(block(blocks, 'hepatitis').bins.map((b) => b.count), [null, 0]);
  assert.equal(block(blocks, 'bp_systolic').n, 0);
  assert.ok(!JSON.stringify(blocks).includes('p03.')); // field ids never leave the server
});

test('reference CSV: bands and 0/1 results, empty = not tested; a missing file is null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-'));
  const file = join(dir, 'ref.csv');
  const head = 'id,mean systolic bp (mmhg),hiv test result,syphilis test result,hepatitis c test result';
  const rows = Array.from({ length: 12 }, (_, i) => `${i},${i < 6 ? 110 : 130},0,${i < 6 ? 1 : 0},${i === 0 ? '' : 0}`);
  writeFileSync(file, [head, ...rows].join('\n'));
  const ref = referenceAggregates(file)!;
  assert.equal(ref.source, 'reference');
  assert.deepEqual(block(ref.blocks, 'bp_systolic').bins.map((b) => b.count), [6, 6, 0, 0]);
  assert.deepEqual(block(ref.blocks, 'syphilis').bins.map((b) => b.count), [6, 6]);
  assert.deepEqual(block(ref.blocks, 'hiv').bins.map((b) => b.count), [12, 0]);
  assert.equal(block(ref.blocks, 'hepatitis').n, 11);
  assert.equal(referenceAggregates(join(dir, 'none.csv')), null);
});
