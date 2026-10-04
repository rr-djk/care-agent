// Statistics shared by calibrate.mjs, quality-curve.mjs and report.mjs: Wilson interval, binning with merging, category fit.

export const MIN_BIN_N = 30; // fewer examples in a bin: merged into its neighbour
export const MAX_BINS = 3;
export const DEFAULT_TARGET = 0.95;
/** Statuses that put a field in the review queue (apps/server/src/review.ts `isPending`): "flagged". */
export const FLAGGED = ['NEEDS_REVIEW', 'ILLEGIBLE', 'UNKNOWN'];

/** Wilson score interval [low, high] for k successes out of n (z = 1.96: 95 %); [null, null] when n = 0. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/**
 * Bins of rows `{score, ok}`, ascending by score: one group per distinct score, then at most `maxBins` (the adjacent pair with
 * the fewest examples merges first), then any bin under `minN` merges into its smaller neighbour. [{min, max, n, correct}].
 */
export function makeBins(rows, { maxBins = MAX_BINS, minN = MIN_BIN_N } = {}) {
  const byScore = new Map();
  for (const r of rows) {
    const g = byScore.get(r.score) ?? { min: r.score, max: r.score, n: 0, correct: 0 };
    g.n++;
    g.correct += +r.ok;
    byScore.set(r.score, g);
  }
  let bins = [...byScore.values()].sort((a, b) => a.min - b.min);
  const merge = (i) => bins.splice(i, 2, { min: bins[i].min, max: bins[i + 1].max, n: bins[i].n + bins[i + 1].n, correct: bins[i].correct + bins[i + 1].correct });
  while (bins.length > maxBins) {
    let best = 0;
    for (let i = 1; i < bins.length - 1; i++) if (bins[i].n + bins[i + 1].n < bins[best].n + bins[best + 1].n) best = i;
    merge(best);
  }
  for (;;) {
    const small = bins.findIndex((b) => b.n < minN);
    if (small < 0 || bins.length === 1) break;
    const left = bins[small - 1]?.n ?? Infinity;
    const right = bins[small + 1]?.n ?? Infinity;
    merge(left <= right ? small - 1 : small);
  }
  return bins;
}

const withCi = (b) => {
  const [low, high] = wilson(b.correct, b.n);
  return { n: b.n, correct: b.correct, accuracy: b.n ? b.correct / b.n : null, low, high };
};

/**
 * Calibration entry of one category (the shape of `CategoryEntry` in apps/server/src/calibration.ts).
 * known: rows `{quality, ok}` of the fields that ended KNOWN; all: rows `{ok, flagged}` of every field (doubt recall).
 * The server uses the reference bin = the best-quality bin after merging; it needs >= minN examples, else accuracy is null.
 * Decision rule: demote when the Wilson lower bound of the reference accuracy is under `target`.
 */
export function fitCategory(known, all, { target = DEFAULT_TARGET, minN = MIN_BIN_N } = {}) {
  const bins = makeBins(known.map((r) => ({ score: r.quality, ok: r.ok })), { minN });
  const ref = bins.length ? withCi(bins[bins.length - 1]) : withCi({ n: 0, correct: 0 });
  const enough = ref.n >= minN;
  const wrong = all.filter((r) => !r.ok);
  const flagged = wrong.filter((r) => r.flagged).length;
  const [dlow, dhigh] = wilson(flagged, wrong.length);
  return {
    n: ref.n,
    correct: ref.correct,
    accuracy: enough ? ref.accuracy : null,
    low: enough ? ref.low : null,
    high: enough ? ref.high : null,
    demote: enough && ref.low < target,
    bins: bins.map((b) => ({ quality_min: b.min, quality_max: b.max, ...withCi(b) })),
    doubt: { wrong: wrong.length, flagged, recall: wrong.length ? flagged / wrong.length : null, low: dlow, high: dhigh },
  };
}

export const pct = (x, d = 1) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(d)} %`);
export const ci = (low, high) => (low === null ? 'n/a' : `[${pct(low)}, ${pct(high)}]`);
