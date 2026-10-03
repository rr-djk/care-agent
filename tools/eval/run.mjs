#!/usr/bin/env node
// Minimal eval harness: ground_truth.json vs a predictions JSON ({page_no: {key: value}}).
// Usage: run.mjs [--split tune|calibrate|verify|all] [--pages p2,p3,p4] [--extractor truth|empty|<predictions.json>]
//                [--gt file] [--out dir]
// Exact match per slot after normalization (normalize.mjs). A slot is "empty" in the ground truth when its
// value is "" or false; predicting nothing for it is correct, and it is reported apart from the non-empty slots.
// Staff slots hold "<staff>" in the ground truth: any non-empty prediction is correct (no staff name is stored).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { normalize } from './normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STAFF = '<staff>';

const isEmpty = (v) => v === '' || v === false;
const toBool = (v) => v === true || (typeof v === 'string' && ['true', 'oui', 'yes', '1'].includes(normalize(v)));
// Some handwriting fonts have no glyph for accented letters: the image shows "N ant" where the truth is
// "Néant". A reading that matches once accented letters are dropped from both sides is not the model's error.
const dropAccented = (v) => String(v).toLowerCase().replace(/[^\x00-\x7f]/g, '').replace(/\s+/g, '');

export function isCorrect(slot, predicted) {
  if (slot.kind === 'checkbox') return toBool(predicted) === slot.value;
  const p = normalize(predicted ?? '');
  if (slot.value === STAFF) return p !== '';
  return p === normalize(slot.value) || (p !== '' && dropAccented(predicted) === dropAccented(slot.value));
}

const bucket = () => ({ n: 0, correct: 0 });
const add = (b, ok) => { b.n++; if (ok) b.correct++; };
const acc = (b) => (b.n ? b.correct / b.n : null);
const group = () => ({ non_empty: bucket(), empty: bucket(), all: bucket() });
const addTo = (g, slot, ok) => { add(slot.value === '' || slot.value === false ? g.empty : g.non_empty, ok); add(g.all, ok); };

/** gt: ground truth by page_no; predictions: {page_no: {key: value}}; pageNos: pages to score. */
export function evaluate(gt, predictions, pageNos) {
  const overall = group();
  const byLayout = {};
  const byKey = {};
  const missingPages = [];
  let extraKeys = 0;
  for (const no of pageNos) {
    const page = gt[no];
    const pred = predictions[no];
    if (!pred) missingPages.push(no);
    const keys = new Set(page.slots.map((s) => s.key));
    extraKeys += Object.keys(pred ?? {}).filter((k) => !keys.has(k)).length;
    for (const slot of page.slots) {
      const ok = isCorrect(slot, pred?.[slot.key]);
      addTo(overall, slot, ok);
      addTo((byLayout[page.layout] ??= group()), slot, ok);
      addTo((byKey[slot.key] ??= group()), slot, ok);
    }
  }
  return { pages: pageNos.length, missing_pages: missingPages, extra_keys: extraKeys, overall, by_layout: byLayout, by_key: byKey };
}

const pct = (b) => (b.n ? `${(100 * acc(b)).toFixed(1)}%`.padStart(6) : '   n/a');
const cell = (b) => `${String(b.n).padStart(5)} ${pct(b)}`;

export function formatTable(result) {
  const rows = [['layout', 'non-empty', 'empty', 'all'], ...Object.entries({ ...result.by_layout, overall: result.overall })
    .map(([name, g]) => [name, cell(g.non_empty), cell(g.empty), cell(g.all)])];
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ')).join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      split: { type: 'string', default: 'all' },
      pages: { type: 'string', default: 'p2,p3,p4' },
      extractor: { type: 'string', default: 'truth' },
      gt: { type: 'string', default: join(here, 'data', 'ground_truth.json') },
      out: { type: 'string', default: resolve(here, '..', '..', 'eval-results') },
    },
  });
  const gt = JSON.parse(await readFile(values.gt, 'utf8'));
  const split = JSON.parse(await readFile(join(here, 'data', 'split.json'), 'utf8'));
  const types = new Set(values.pages.split(',').map((p) => Number(/^p(\d)$/.exec(p.trim())?.[1])));
  if (types.has(NaN)) throw new Error(`--pages expects p1..p8, got "${values.pages}"`);
  let allowed;
  if (values.split === 'all') allowed = null;
  else if (split.groups[values.split]) allowed = new Set(split.groups[values.split].pages);
  else throw new Error(`--split must be tune, calibrate, verify or all, got "${values.split}"`);
  const pageNos = Object.keys(gt).filter((no) => types.has(gt[no].page_type) && (!allowed || allowed.has(Number(no))));

  let predictions;
  if (values.extractor === 'truth') predictions = Object.fromEntries(pageNos.map((no) => [no, Object.fromEntries(gt[no].slots.map((s) => [s.key, s.value]))]));
  else if (values.extractor === 'empty') predictions = {};
  else predictions = JSON.parse(await readFile(values.extractor, 'utf8'));

  const result = evaluate(gt, predictions, pageNos);
  const stamp = new Date().toISOString();
  await mkdir(values.out, { recursive: true });
  const file = join(values.out, `eval-${stamp.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify({ timestamp: stamp, args: values, ...result }, null, 2) + '\n');
  console.log(`extractor=${values.extractor} split=${values.split} pages=${values.pages} (${result.pages} pages, ${result.missing_pages.length} without predictions, ${result.extra_keys} extra keys)`);
  console.log(formatTable(result));
  console.log(`wrote ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`eval failed: ${e.message}`);
    process.exit(1);
  });
}
