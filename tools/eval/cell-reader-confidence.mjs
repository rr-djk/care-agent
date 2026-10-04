// Cell-reader experiment, phase 3 (docs/cell-reader.md): how well the per-cell confidence (readers/score.ts) separates
// right from wrong readings, on a cell-reader-bench file made with --constrain (tune split only).
// Usage: node --import tsx tools/eval/cell-reader-confidence.mjs --bench eval-results/cell-bench-<time>.jsonl
//   [--thresholds 0.3,0.5,...] [--target 0]
// Only cells the reader read (ink seen) count; ink without a reading is NEEDS_REVIEW by the status rules anyway.
// Output: AUROC per signal and for the score (95 % bootstrap interval), risk/coverage table, a threshold per category
// fitted on the clean cells (at most --target wrong left KNOWN), checked on the degraded variants. Real photos: listed, never fitted.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadPageSchema } from '@care-agent/schema/node';
import { readerScore, readerSignals, weakest } from '../../apps/server/src/vision/readers/score.ts';

const { values } = parseArgs({
  options: {
    bench: { type: 'string' },
    thresholds: { type: 'string', default: '0.3,0.5,0.6,0.7,0.8,0.85,0.9,0.95' },
    target: { type: 'string', default: '0' },
  },
});
if (!values.bench) throw new Error('--bench <cell-bench-*.jsonl> is required');
const records = (await readFile(values.bench, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.read && r.method);
if (!records.length) throw new Error('no constrained readings in this file (run the bench with --constrain)');
const fields = new Map();
const fieldOf = (r) => {
  if (!fields.has(r.layout)) fields.set(r.layout, new Map(loadPageSchema(r.layout).fields.map((f) => [f.id, f])));
  return fields.get(r.layout).get(r.key);
};

const cells = records.map((r) => {
  const sig = readerSignals({ text: r.reading ?? '', steps: (r.steps ?? []).map((s) => ({ p: s.p, frames: s.n })), logp: r.logp, logp_free: r.logp_free, rank: r.rank, runner_up: r.runner_up, posterior: r.posterior }, fieldOf(r));
  return { ...r, sig, score: readerScore(sig) };
});
const fitted = cells.filter((c) => !c.real);
const real = cells.filter((c) => c.real);

/** P(score of a right cell > score of a wrong one), ties count half. */
function auroc(xs) {
  const pos = xs.filter((x) => x.ok).map((x) => x.v), neg = xs.filter((x) => !x.ok).map((x) => x.v);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / pos.length / neg.length;
}
/** 95 % percentile bootstrap interval, resampling cells (seeded, reproducible). */
function bootstrap(xs, n = 500) {
  let seed = 20261004;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = auroc(Array.from(xs, () => xs[Math.floor(rnd() * xs.length)]));
    if (v !== null) out.push(v);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}
const f3 = (v) => (v === null || v === undefined ? ' n/a ' : v.toFixed(3));
const wrongOf = (xs) => xs.filter((c) => !c.ok).length;

for (const [name, set] of [['clean tune pages', fitted.filter((c) => (c.variant ?? 'clean') === 'clean')], ['tune variants (degraded)', fitted.filter((c) => (c.variant ?? 'clean') !== 'clean')], ['all tune cells', fitted]]) {
  if (!set.length) continue;
  console.log(`\n== ${name}: ${set.length} cells read, ${wrongOf(set)} wrong (${((100 * wrongOf(set)) / set.length).toFixed(1)} %)`);
  const signals = {
    'lowest char p': (c) => c.sig.min_char_p,
    'mean char p': (c) => c.sig.mean_char_p,
    'constraint cost': (c) => c.sig.constraint,
    'runner-up margin': (c) => c.sig.margin ?? 1,
    'weakest (phase 3)': (c) => weakest(c.sig),
    'meaning posterior': (c) => c.sig.posterior ?? 0,
    'validators': (c) => +c.sig.validators_passed,
    'ink ratio': (c) => c.ink,
    SCORE: (c) => c.score,
  };
  for (const [label, get] of Object.entries(signals)) {
    const xs = set.map((c) => ({ ok: c.ok, v: get(c) }));
    const a = auroc(xs);
    const [lo, hi] = a === null ? [null, null] : bootstrap(xs);
    console.log(`  AUROC ${label.padEnd(17)} ${f3(a)}  [${f3(lo)}, ${f3(hi)}]`);
  }
  console.log('  threshold | to review (cells)   | right sent to review | wrong left KNOWN');
  for (const t of values.thresholds.split(',').map(Number)) {
    const review = set.filter((c) => c.score < t);
    const leftWrong = set.filter((c) => c.score >= t && !c.ok).length;
    console.log(`  ${t.toFixed(2).padStart(9)} | ${`${((100 * review.length) / set.length).toFixed(1)} % (${review.length})`.padEnd(19)} | ${String(review.filter((c) => c.ok).length).padEnd(20)} | ${leftWrong} of ${wrongOf(set)}`);
  }
}

// threshold per category, fitted on the CLEAN tune cells (the lowest grid value leaving at most `target` wrong cells
// KNOWN, never below the global one), then applied to the degraded variants as a stress test
const target = Number(values.target);
const grid = Array.from({ length: 100 }, (_, i) => i / 100);
const clean = fitted.filter((c) => (c.variant ?? 'clean') === 'clean');
const varied = fitted.filter((c) => (c.variant ?? 'clean') !== 'clean');
const fit = (set) => grid.find((g) => set.filter((c) => c.score >= g && !c.ok).length <= target) ?? 1;
const global = fit(clean);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)} %` : 'n/a');
console.log(`\n== threshold fitted on the clean tune cells (at most ${target} wrong left KNOWN): global ${global.toFixed(2)}`);
console.log('  category            clean: cells wrong threshold to-review | variants: cells wrong wrong-KNOWN to-review');
for (const [cat, set] of [...Map.groupBy(clean, (c) => c.category)].sort()) {
  const t = Math.max(global, fit(set));
  const v = varied.filter((c) => c.category === cat);
  console.log(`  ${cat.padEnd(19)} ${String(set.length).padStart(11)} ${String(wrongOf(set)).padStart(5)} ${t.toFixed(2).padStart(9)} ${pct(set.filter((c) => c.score < t).length, set.length).padStart(9)} | ${String(v.length).padStart(15)} ${String(wrongOf(v)).padStart(5)} ${String(v.filter((c) => c.score >= t && !c.ok).length).padStart(11)} ${pct(v.filter((c) => c.score < t).length, v.length).padStart(9)}`);
}

console.log('\n== wrong readings (all tune cells): score and weakest signal');
for (const c of fitted.filter((x) => !x.ok).sort((a, b) => b.score - a.score)) {
  const s = c.sig;
  console.log(`  ${c.score.toFixed(2)}  ${c.page.padEnd(14)} ${c.key.padEnd(40)} ${JSON.stringify(c.truth).padEnd(16)} ${JSON.stringify(c.reading).padEnd(16)} minp ${s.min_char_p.toFixed(2)} mean ${s.mean_char_p.toFixed(2)} cons ${s.constraint.toFixed(2)}${s.margin !== undefined ? ` margin ${s.margin.toFixed(2)}` : ''}${s.validators_passed ? '' : ' VALIDATOR'}`);
}
if (real.length) {
  console.log('\n== real photo (report only, never fitted)');
  for (const c of real) console.log(`  ${c.score.toFixed(2)}  ${c.key.padEnd(40)} ${JSON.stringify(c.truth).padEnd(18)} ${JSON.stringify(c.reading)} ${c.ok ? 'right' : 'wrong'}`);
}

// leave one tune patient out: threshold fitted (0 wrong left KNOWN) on the clean cells of the other patients, applied to
// the held-out patient's clean cells and degraded variants. This is how the threshold behaves on a hand it has not seen.
const pagesJson = JSON.parse(await readFile(new URL('./data/pages.json', import.meta.url), 'utf8')).pages;
const patientOf = (c) => pagesJson.find((p) => p.page_no === Number(String(c.page).split('/')[0]))?.patient;
const patients = [...new Set(fitted.map(patientOf))].filter(Boolean).sort((a, b) => a - b);
const lopo = (scoreOf, label) => {
  let rev = 0, n = 0, wk = 0, vrev = 0, vn = 0, vwk = 0, vw = 0;
  for (const p of patients) {
    const train = clean.filter((c) => patientOf(c) !== p);
    const t = grid.find((g) => train.filter((c) => scoreOf(c) >= g && !c.ok).length <= target) ?? 1;
    const held = clean.filter((c) => patientOf(c) === p);
    const heldVar = varied.filter((c) => patientOf(c) === p);
    rev += held.filter((c) => scoreOf(c) < t).length; n += held.length; wk += held.filter((c) => scoreOf(c) >= t && !c.ok).length;
    vrev += heldVar.filter((c) => scoreOf(c) < t).length; vn += heldVar.length; vwk += heldVar.filter((c) => scoreOf(c) >= t && !c.ok).length; vw += wrongOf(heldVar);
  }
  console.log(`  ${label.padEnd(20)} clean: ${pct(rev, n).padStart(7)} to review, ${wk} wrong left KNOWN of ${wrongOf(clean)} | variants: ${pct(vrev, vn).padStart(7)} to review, ${vwk} of ${vw} wrong left KNOWN`);
};
console.log(`\n== leave one tune patient out (${patients.length} patients): threshold fitted on the others, applied to the held-out one`);
lopo((c) => weakest(c.sig), 'weakest (phase 3)');
lopo((c) => c.score, 'SCORE (posterior)');
