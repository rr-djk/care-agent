import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadCellBoxes, loadPageImage, pagePngPath, repoRoot } from '../cli/pages';
import { cellHasInk, checkboxInkRatio, inkRatio } from './ink';

const gt = JSON.parse(readFileSync(`${repoRoot}/tools/eval/data/ground_truth.json`, 'utf8'));
let png: string | undefined;
try {
  png = pagePngPath(19);
  readFileSync(png);
} catch {
  png = undefined;
}

// Page 19: patient 3, pregnancy. Template geometry, as at run time.
test('ink detector on real cells', { skip: !png && 'DATASETS_DIR not available' }, async () => {
  const page = await loadPageImage(png!);
  const boxes = loadCellBoxes('pregnancy');
  const slot = (key: string) => gt['19'].slots.find((s: { key: string }) => s.key === key);
  const ratio = (key: string) => (boxes.get(key)!.kind === 'checkbox' ? checkboxInkRatio : inkRatio)(page, boxes.get(key)!.bbox_frac);
  assert.equal(slot('p03.ddr').value, '07/04/2025');
  assert.ok(cellHasInk(ratio('p03.ddr')));
  assert.equal(slot('p03.groupage_a').value, false);
  assert.ok(!cellHasInk(ratio('p03.groupage_a'), 'checkbox'));
  assert.equal(slot('p03.groupage_o').value, true);
  assert.ok(cellHasInk(ratio('p03.groupage_o'), 'checkbox'));
  assert.equal(slot('p03.rendez_vous.v2_t1').value, '');
  assert.ok(!cellHasInk(ratio('p03.rendez_vous.v2_t1'))); // empty cell with leaked grid lines
});

test('text threshold is per layout: delivery ignores dotted-line leakage', () => {
  assert.ok(cellHasInk(0.005, 'text', 'pregnancy'));
  assert.ok(!cellHasInk(0.005, 'text', 'delivery'));
  assert.ok(cellHasInk(0.02, 'text', 'delivery'));
});
