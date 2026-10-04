// Fits the per-category confidence table on the CALIBRATE split (+ its variants) and writes it with a markdown report.
// Usage: node --import tsx tools/eval/calibrate.mjs --pred eval-results/predictions-<ts>.jsonl[,more.jsonl] [--target 0.95] [--out data/calibration]
// (or: make calibrate ARGS='...'). Output: <out>/table.json (stamped with the pipeline_hash) and <out>/report.md, git-ignored.
// Refuses predictions of other splits, of the real photos, or made by another pipeline than the current one.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CalibrationTable, pipelineHash } from '../../apps/server/src/calibration.ts';
import { fieldRows, readRecords } from './predictions.mjs';
import { ci, DEFAULT_TARGET, fitCategory, MIN_BIN_N, pct } from './stats.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The calibration table (without hash and date) from the field rows of predictions. */
export function fitTable(rows, { target = DEFAULT_TARGET, minN = MIN_BIN_N } = {}) {
  const categories = {};
  for (const category of [...new Set(rows.map((r) => r.category))].sort()) {
    const mine = rows.filter((r) => r.category === category);
    const known = mine.filter((r) => r.field.status === 'KNOWN').map((r) => ({ quality: r.quality, ok: r.ok }));
    categories[category] = fitCategory(known, mine, { target, minN });
  }
  return { target, min_n: minN, categories };
}

/** Throws unless every record belongs to the calibrate split (variants included) and was read by `hash`. */
export function checkRecords(records, hash) {
  if (!records.length) throw new Error('no prediction records');
  for (const r of records) {
    if (r.photo || r.group !== 'calibrate') throw new Error(`record ${r.photo ?? `${r.page_no}/${r.variant}`} is in group "${r.group}": only the calibrate split may fit the table`);
    if (r.pipeline_hash !== hash) throw new Error(`record ${r.page_no}/${r.variant} was read by another pipeline (${String(r.pipeline_hash).slice(0, 12)} != ${hash.slice(0, 12)}): rerun make predict`);
  }
}

const row = (cells) => `| ${cells.join(' | ')} |`;

export function renderReport(table, rows, meta) {
  const out = [];
  out.push('# Calibration report', '');
  out.push(`- pipeline_hash: \`${meta.pipeline_hash}\``, `- date: ${meta.created_at}`);
  out.push(`- records: ${meta.records} (${meta.pages} pages, ${meta.variants} degraded variants), fields scored: ${rows.length}`);
  out.push(`- target: ${pct(table.target, 0)} · min examples per bin: ${table.min_n} · at most 3 bins · Wilson 95 % intervals`, '');
  out.push('## Decision rule', '');
  out.push(`A category whose KNOWN accuracy has a Wilson 95 % **lower** bound below the target (${pct(table.target, 0)}) has its KNOWN fields demoted to NEEDS_REVIEW (reason \`low_category_confidence\`) by the server.`);
  out.push(`The reference accuracy is that of the best-quality bin (quality factor 1: gate OK) after merging bins under ${table.min_n} examples; a category whose reference bin has fewer than ${table.min_n} examples is **insufficient**: no number, no demotion (no evidence either way).`);
  out.push(`With no error at all, the lower bound reaches 95 % only from about 73 examples (n=30 gives 88.6 %).`);
  out.push('Final confidence stored in `ExtractedField.calibrated` = reference accuracy × quality factor (OK 1, kept WARNING 0.5). It is never shown as a percentage in the main UI.', '');
  out.push('## Per category: accuracy of KNOWN fields', '');
  out.push(row(['category', 'n KNOWN (ref. bin)', 'accuracy', 'Wilson 95 %', 'verdict']), row(['---', '---', '---', '---', '---']));
  for (const [name, c] of Object.entries(table.categories)) {
    const verdict = c.accuracy === null ? `insufficient n (< ${table.min_n})` : c.demote ? 'DEMOTE' : 'keep';
    out.push(row([name, c.n, pct(c.accuracy), ci(c.low, c.high), verdict]));
  }
  out.push('', '## Bins by quality factor (KNOWN fields)', '');
  out.push(row(['category', 'quality', 'n', 'accuracy', 'Wilson 95 %']), row(['---', '---', '---', '---', '---']));
  for (const [name, c] of Object.entries(table.categories)) {
    for (const b of c.bins) out.push(row([name, b.quality_min === b.quality_max ? b.quality_min : `${b.quality_min}-${b.quality_max}`, b.n, pct(b.accuracy), ci(b.low, b.high)]));
    if (!c.bins.length) out.push(row([name, '-', 0, 'n/a', 'n/a']));
  }
  out.push('', '## Doubt recall: wrong values that were flagged (NEEDS_REVIEW, ILLEGIBLE or UNKNOWN)', '');
  out.push(row(['category', 'wrong values', 'flagged', 'doubt recall', 'Wilson 95 %']), row(['---', '---', '---', '---', '---']));
  for (const [name, c] of Object.entries(table.categories)) out.push(row([name, c.doubt.wrong, c.doubt.flagged, pct(c.doubt.recall), ci(c.doubt.low, c.doubt.high)]));
  out.push('', '## Agreement (model emptiness vs ink), text readings', '');
  out.push('Among KNOWN fields agreement is always 1 and validators always passed (that is what KNOWN means), so only the quality factor can split them. Agreement shows what the flagging catches:', '');
  out.push(row(['category', 'agreement 1: n', 'accuracy', 'agreement 0: n', 'accuracy']), row(['---', '---', '---', '---', '---']));
  for (const name of Object.keys(table.categories)) {
    const text = rows.filter((r) => r.category === name && r.field.signals.agreement !== null);
    const part = (a) => {
      const g = text.filter((r) => r.field.signals.agreement === a);
      return [g.length, g.length ? pct(g.filter((r) => r.ok).length / g.length) : 'n/a'];
    };
    if (text.length) out.push(row([name, ...part(1), ...part(0)]));
  }
  const insufficient = Object.entries(table.categories).filter(([, c]) => c.accuracy === null).map(([n]) => n);
  if (insufficient.length) out.push('', `**Insufficient n**: ${insufficient.join(', ')}. Run more calibrate pages (and variants) before trusting this table.`);
  return out.join('\n') + '\n';
}

async function main() {
  const { values } = parseArgs({ options: { pred: { type: 'string' }, target: { type: 'string', default: String(DEFAULT_TARGET) }, out: { type: 'string', default: 'data/calibration' } } });
  if (!values.pred) throw new Error('--pred <predictions.jsonl[,more.jsonl]> is required (make predict --split calibrate ...)');
  const records = await readRecords(values.pred.split(','));
  const hash = pipelineHash();
  checkRecords(records, hash);
  const gt = JSON.parse(readFileSync(resolve(repo, 'tools/eval/data/ground_truth.json'), 'utf8'));
  const rows = fieldRows(records, gt);
  const created_at = new Date().toISOString();
  const table = CalibrationTable.parse({ pipeline_hash: hash, created_at, ...fitTable(rows, { target: Number(values.target) }) });
  const out = resolve(repo, values.out);
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'table.json'), JSON.stringify(table, null, 2) + '\n');
  const variants = records.filter((r) => r.variant !== 'clean').length;
  const report = renderReport(table, rows, { pipeline_hash: hash, created_at, records: records.length, pages: new Set(records.map((r) => r.page_no)).size, variants });
  writeFileSync(resolve(out, 'report.md'), report);
  console.log(report);
  console.log(`wrote ${resolve(out, 'table.json')} and ${resolve(out, 'report.md')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`calibrate failed: ${e.message}`);
    process.exit(1);
  });
}
