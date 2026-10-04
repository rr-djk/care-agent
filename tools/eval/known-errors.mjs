// Silent errors of a `make predict` file (any reader): per layout, handwritten text cells right, wrong but KNOWN (the
// errors nobody will check), wrong but sent to review, missed (no reading: blank status), and the share of the text
// cells holding a value or a doubt that go to review. Clean pages only.
// Usage: node tools/eval/known-errors.mjs --pred eval-results/predictions-<time>.jsonl
// Same comparison rule as `make eval` (run.mjs isCorrect); review = NEEDS_REVIEW, ILLEGIBLE or UNKNOWN. Checkbox cells are
// left out (ink decides them in every reader).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { predictedValue, readRecords } from './predictions.mjs';
import { isCorrect } from './run.mjs';

const { values } = parseArgs({ options: { pred: { type: 'string' } } });
if (!values.pred) throw new Error('--pred <predictions.jsonl> is required');
const gt = JSON.parse(await readFile(join(import.meta.dirname, 'data/ground_truth.json'), 'utf8'));
const records = (await readRecords(values.pred)).filter((r) => r.variant === 'clean' && r.page_no);
const rows = new Map();
const REVIEW = new Set(['NEEDS_REVIEW', 'ILLEGIBLE', 'UNKNOWN']);
const row = (k) => rows.get(k) ?? rows.set(k, { pages: 0, hw: 0, right: 0, wrongKnown: 0, wrongFlagged: 0, missed: 0, text: 0, review: 0, s: 0 }).get(k);
for (const r of records) {
  const fields = new Map(r.fields.map((f) => [f.field_id, f]));
  for (const k of [r.layout, 'all']) {
    const g = row(k);
    g.pages++;
    g.s += r.latency?.wall_s ?? 0;
    for (const slot of gt[r.page_no].slots) {
      const f = fields.get(slot.key);
      if (slot.kind !== 'text' || !f) continue;
      if (f.status === 'KNOWN' || REVIEW.has(f.status)) g.text++; // a value or a doubt (blank cells left out)
      if (REVIEW.has(f.status)) g.review++;
      if (slot.value === '') continue;
      g.hw++;
      if (isCorrect(slot, predictedValue(f))) g.right++;
      else if (f.status === 'KNOWN') g.wrongKnown++;
      else if (REVIEW.has(f.status)) g.wrongFlagged++;
      else g.missed++;
    }
  }
}
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)} %` : 'n/a');
console.log(`${values.pred}: ${records.length} clean pages, reader ${records[0]?.reader ?? 'gemma'}`);
console.log('layout              pages  handwritten right     wrong KNOWN  wrong to review  missed  cells to review  s/page');
for (const [k, g] of [...rows].sort(([a], [b]) => (a === 'all') - (b === 'all') || a.localeCompare(b))) {
  console.log(`${k.padEnd(19)} ${String(g.pages).padStart(5)}  ${`${pct(g.right, g.hw)} (${g.right}/${g.hw})`.padEnd(20)} ${String(g.wrongKnown).padStart(11)}  ${String(g.wrongFlagged).padStart(15)}  ${String(g.missed).padStart(6)}  ${pct(g.review, g.text).padStart(15)}  ${(g.s / g.pages).toFixed(1).padStart(6)}`);
}
