// Per-cell confidence of the cell reader (experiment phase 3, docs/cell-reader.md). Pure: the bench analysis
// (tools/eval/cell-reader-confidence.mjs) and the server use the same code.
// The score is the WEAKEST of a few signals in [0, 1], so one bad sign is enough to send the cell to review.
// The constants below were chosen on the tune split (specimen fonts): they do not hold for real handwriting; the real
// threshold belongs to the step 13 calibration (Wilson lower bound, docs/calibration.md) once real labelled cells exist.
import { normalizeValue, validateField, type FieldDef } from '@care-agent/schema';

export interface ReadingInput {
  text: string; // the returned reading
  steps: { p: number }[]; // greedy CTC steps (per character)
  logp: number; // log P of `text`
  logp_free: number; // log P of the best unconstrained reading
  rank?: number; // pattern: > 0 when more probable readings failed the validators
  runner_up?: { logp: number }; // the best other candidate (allowed value, pattern reading or free reading)
}

export interface ReaderSignals {
  min_char_p: number;
  mean_char_p: number; // exp(logp / length): per-character probability of the returned text, all alignments
  constraint: number; // exp(-(logp_free - logp)): 1 when the reading is also the most probable free reading
  margin?: number; // 1 - P(runner-up) / P(reading), 0 when the runner-up is as probable or more
  validators_passed: boolean;
}

export function readerSignals(r: ReadingInput, field: FieldDef): ReaderSignals {
  const value = normalizeValue(field, r.text);
  const typed = !(field.type === 'number' && typeof value === 'string'); // a number field read as text
  return {
    min_char_p: r.steps.length ? Math.min(...r.steps.map((s) => s.p)) : 0,
    mean_char_p: r.text ? Math.exp(r.logp / Math.max(1, [...r.text].length)) : 0,
    constraint: Math.exp(-Math.max(0, r.logp_free - r.logp)),
    ...(r.runner_up && { margin: Math.max(0, 1 - Math.exp(r.runner_up.logp - r.logp)) }),
    validators_passed: typed && (value === null || !validateField(field, value).length),
  };
}

/** Confidence in [0, 1]: the weakest signal. */
export function readerScore(s: ReaderSignals): number {
  if (!s.validators_passed) return 0;
  return Math.min(s.min_char_p, s.mean_char_p, s.constraint, s.margin ?? 1);
}

/** A reading the status rules would keep KNOWN stays KNOWN only with a score at or above the threshold. */
export const readerStatus = (status: 'KNOWN' | string, score: number, threshold: number): { status: string; reason?: 'low_reader_confidence' } =>
  status === 'KNOWN' && score < threshold ? { status: 'NEEDS_REVIEW', reason: 'low_reader_confidence' } : { status };
