import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BBoxFrac } from '@care-agent/schema';
import { loadPageSchema } from '@care-agent/schema/node';
import { loadCellBoxes } from '../cli/pages';
import { analyzeZone, type AnalyzeDeps } from './analyze';
import type { PageImage } from './ink';
import { inkOnlyFields } from './manual';

const schema = loadPageSchema('delivery');
const cellBoxes = loadCellBoxes('delivery');
const W = 1000;
const H = 1400;

// Blank page; a text cell gets a small blob, a checkbox is filled (same idea as analyze.test.ts).
function pageWith(inked: string[]): PageImage {
  const data = Buffer.alloc(W * H * 3, 255);
  for (const id of inked) {
    const box = cellBoxes.get(id)!;
    const [x0, y0, x1, y1] = box.bbox_frac as BBoxFrac;
    const [cx, cy] = [Math.round(((x0 + x1) / 2) * W), Math.round(((y0 + y1) / 2) * H)];
    const [xa, xb, ya, yb] = box.kind === 'checkbox' ? [Math.round(x0 * W), Math.round(x1 * W), Math.round(y0 * H), Math.round(y1 * H)] : [cx - 10, cx + 10, cy - 3, cy + 3];
    for (let y = ya; y < yb; y++) data.fill(0, (y * W + xa) * 3, (y * W + xb) * 3);
  }
  return { data, width: W, height: H };
}

test('ink-only reading: checkboxes KNOWN, text without ink NOT_PROVIDED, text with ink UNKNOWN "manual"', () => {
  const fields = inkOnlyFields(pageWith(['p04.maternite', 'p04.autres', 'p04.date_de_l_accouchement']), schema, cellBoxes);
  const by = (id: string) => fields.find((f) => f.field_id === id)!;
  assert.deepEqual([by('p04.maternite').value, by('p04.maternite').status], [true, 'KNOWN']);
  assert.deepEqual([by('p04.clinique_privee').value, by('p04.clinique_privee').status], [false, 'KNOWN']);
  assert.deepEqual([by('p04.autres').value, by('p04.autres').status, by('p04.autres').reason], [null, 'UNKNOWN', 'manual']);
  assert.equal(by('p04.date_de_l_accouchement').status, 'UNKNOWN');
  assert.deepEqual([by('p04.poids_a_la_naissance').value, by('p04.poids_a_la_naissance').status], [null, 'NOT_PROVIDED']);
  assert.equal(fields.filter((f) => f.status === 'UNKNOWN').length, 2);
  assert.equal(fields.length, schema.zones.flatMap((z) => z.cells).length);
});

test('free text read by the model is masked before it is stored (identifiers never reach a field)', async () => {
  const deps: AnalyzeDeps = {
    modelName: 'test',
    cellBoxes,
    model: async () => ({ content: JSON.stringify({ cells: ['voir Fatima, tel 0612345678, rue des Orangers 12'] }), logprobs: [], timings: { prompt_tokens: 0, prefill_s: 0, output_tokens: 0, gen_s: 0 } }),
  };
  const z = await analyzeZone(pageWith(['p04.autres']), schema, 'p04.place', deps);
  const cell = z.cells.find((c) => c.field_id === 'p04.autres')!;
  assert.equal(cell.verbatim, 'voir Fatima, tel [masqué], [masqué]');
  assert.doesNotMatch(String(cell.value), /0612345678|Orangers/);
});
