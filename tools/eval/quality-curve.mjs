// Quality curve: accuracy on non-empty cells against the gate metrics, per degradation family and level, from the
// predictions of the clean pages AND their variants. Suggests where the WARNING / REJECT thresholds of
// packages/quality/src/thresholds.ts should sit (the decision stays human: see docs/quality.md for the procedure).
// Usage: node --import tsx tools/eval/quality-curve.mjs --pred eval-results/predictions-<ts>.jsonl[,more] [--drop 0.05] [--collapse 0.25]
// (or: make quality-curve ARGS='...'). Output: eval-results/quality-curve-<ts>.md (also printed).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { THRESHOLDS } from '../../packages/quality/src/thresholds.ts';
import { fieldRows, readRecords } from './predictions.mjs';
import { pct } from './stats.mjs';
import { VARIANTS } from './variants.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const f = (x, d = 2) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));

// family -> the metric that should explain it, the direction in which it gets worse, and the threshold it would set
const WATCH = {
  'gaussian blur (sigma)': { metric: 'blur', worse: 'lower', threshold: 'blurMin' },
  'motion blur (px)': { metric: 'isotropy', worse: 'lower', threshold: 'isotropyMin' },
  'darkness (gain)': { metric: 'brightness', worse: 'lower', threshold: 'lumaDarkMax' },
  'glare (page share)': { metric: 'glare', worse: 'higher', threshold: 'glareMax' },
};

/**
 * One line per (variant): pages, non-empty cells, accuracy, drop against the clean reading of the same pages, mean gate metrics.
 * Clean = the records of variant 'clean' of the same source pages.
 */
export function curve(rows, records) {
  const nonEmpty = rows.filter((r) => !r.empty);
  const accuracy = (rs) => (rs.length ? rs.filter((r) => r.ok).length / rs.length : null);
  const lines = [];
  for (const v of [{ id: 'clean', family: 'clean', level: 0 }, ...VARIANTS]) {
    const recs = records.filter((r) => r.variant === v.id && !r.photo);
    if (!recs.length) continue;
    const pages = new Set(recs.map((r) => r.page_no));
    const mine = nonEmpty.filter((r) => r.record.variant === v.id && !r.record.photo);
    const clean = nonEmpty.filter((r) => r.record.variant === 'clean' && pages.has(r.record.page_no));
    const g = (k) => mean(recs.map((r) => r.gate[k]));
    lines.push({
      id: v.id,
      family: v.family,
      level: v.level,
      pages: pages.size,
      cells: mine.length,
      accuracy: accuracy(mine),
      clean_accuracy: accuracy(clean),
      outcomes: ['OK', 'WARNING', 'REJECT'].map((o) => recs.filter((r) => r.gate.outcome === o).length).join('/'),
      metrics: { blur: g('blur'), isotropy: g('isotropy'), brightness: g('brightness'), glare: g('glare'), framing: g('framing'), skew_deg: g('skew_deg') },
    });
  }
  return lines;
}

/** For each watched family: the mildest level whose accuracy fell by `drop` (WARNING candidate) and by `collapse`, with the metric there. */
export function suggest(lines, { drop = 0.05, collapse = 0.25 } = {}) {
  const out = [];
  for (const [family, w] of Object.entries(WATCH)) {
    const levels = lines.filter((l) => l.family === family).sort((a, b) => a.level - b.level);
    if (!levels.length) continue;
    const first = (d) => levels.find((l) => l.clean_accuracy !== null && l.accuracy !== null && l.clean_accuracy - l.accuracy >= d);
    out.push({ family, ...w, current: THRESHOLDS[w.threshold], warn: first(drop), collapse: first(collapse) });
  }
  return out;
}

export function render(lines, suggestions, opts) {
  const o = [];
  o.push('# Quality curve', '', 'Accuracy on non-empty cells (exact match after normalization) against the gate metrics, mean over the pages of each variant.', '');
  o.push('| variant | level | pages | cells | accuracy | clean (same pages) | change | OK/WARN/REJECT | blur | isotropy | brightness | glare | framing | skew ° |');
  o.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const l of lines) {
    const drop = l.accuracy !== null && l.clean_accuracy !== null ? `${((l.accuracy - l.clean_accuracy) * 100).toFixed(1)} pt` : 'n/a';
    const m = l.metrics;
    o.push(`| ${l.id} | ${l.level} | ${l.pages} | ${l.cells} | ${pct(l.accuracy)} | ${pct(l.clean_accuracy)} | ${drop} | ${l.outcomes} | ${f(m.blur, 0)} | ${f(m.isotropy)} | ${f(m.brightness, 0)} | ${f(m.glare, 3)} | ${f(m.framing)} | ${f(m.skew_deg, 0)} |`);
  }
  o.push('', `## Where accuracy collapses (WARNING candidate = drop >= ${opts.drop * 100} pt, collapse = drop >= ${opts.collapse * 100} pt)`, '');
  o.push('| family | metric (direction of worse) | threshold now | first level with the drop | metric there | collapse level | metric there |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of suggestions) {
    o.push(`| ${s.family} | ${s.metric} (${s.worse}) | ${s.threshold} = ${s.current} | ${s.warn ? s.warn.id : 'none'} | ${s.warn ? f(s.warn.metrics[s.metric], 3) : '-'} | ${s.collapse ? s.collapse.id : 'none'} | ${s.collapse ? f(s.collapse.metrics[s.metric], 3) : '-'} |`);
  }
  o.push('', 'How to read: a WARNING threshold belongs between the metric of the last level that still reads well and the metric of the first level with the drop; the REJECT level is where reading is hopeless. A family with `none` never lost accuracy at the tested levels: the current threshold is not contradicted. Do not change thresholds from a handful of pages (see the cells column): rerun on the full calibrate split first.');
  return o.join('\n') + '\n';
}

async function main() {
  const { values } = parseArgs({ options: { pred: { type: 'string' }, drop: { type: 'string', default: '0.05' }, collapse: { type: 'string', default: '0.25' } } });
  if (!values.pred) throw new Error('--pred <predictions.jsonl[,more.jsonl]> is required (make predict ... --variants all)');
  const records = await readRecords(values.pred.split(','));
  const gt = JSON.parse(readFileSync(resolve(repo, 'tools/eval/data/ground_truth.json'), 'utf8'));
  const opts = { drop: Number(values.drop), collapse: Number(values.collapse) };
  const lines = curve(fieldRows(records, gt), records);
  const report = render(lines, suggest(lines, opts), opts);
  mkdirSync(resolve(repo, 'eval-results'), { recursive: true });
  const file = resolve(repo, `eval-results/quality-curve-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(file, report);
  console.log(report);
  console.log(`wrote ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`quality-curve failed: ${e.message}`);
    process.exit(1);
  });
}
