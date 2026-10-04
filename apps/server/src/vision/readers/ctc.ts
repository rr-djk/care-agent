// CTC decoding for the per-cell reader (experiment, docs/cell-reader.md), pure functions over the recogniser's
// per-frame probabilities. Field-type constraints (phase 2): a reading of a date, number or blood-pressure field may
// only be a string of the field's pattern (prefix beam search over the pattern), an enum is the allowed value the
// recogniser scores best (CTC forward probability of each candidate), free text is read as is.
import { normalizeValue, validateField, type FieldDef } from '@care-agent/schema';
import type { ReadingStep } from './common';

/** frames[t * C + k] = p(class k at frame t); class 0 = blank. */
export interface Frames {
  T: number;
  C: number;
  data: Float32Array;
  classes: string[]; // class index -> character ('' for the blank)
}

// --- patterns -----------------------------------------------------------------------------------------------------

/** One position class repeated min..max times; a pattern is a sequence, a template a list of alternative patterns. */
export interface Tok {
  chars: string;
  min: number;
  max: number;
}
export type Template = Tok[][];

const D = '0123456789';
const DASH = '-—';
const tok = (chars: string, min = 1, max = min): Tok => ({ chars, min, max });
const word = (s: string, caseless = true): Tok[] => [...s].map((c) => tok(caseless && c.toLowerCase() !== c.toUpperCase() ? c.toLowerCase() + c.toUpperCase() : c));

/** Pattern of a date / number / blood-pressure field, from the page schema; undefined = no pattern (free reading or enum). */
export function templateFor(field: FieldDef): Template | undefined {
  const dash = [[tok(DASH)]]; // "—" = nothing written, on every typed field
  if (field.type === 'date') return [[tok(D, 1, 2), tok('/.-'), tok(D, 1, 2), tok('/.-'), tok(D, 2, 4)], ...dash];
  if (field.validators.includes('bp')) return [[tok(D, 2, 3), tok('/'), tok(D, 2, 3)], ...dash];
  if (field.type === 'number') {
    const cores = [[tok(D, 1, 4)], [tok(D, 1, 4), tok('.,'), tok(D, 1, 3)]];
    const unit = field.unit ? word(field.unit.replace('°', '')) : [];
    const units = unit.length ? [[], unit, [tok(' '), ...unit]] : [[]];
    return [...cores.flatMap((c) => units.map((u) => [...c, ...u])), ...dash];
  }
  return undefined;
}

/** NFA over a template: a state = [alternative, token index, count of chars in that token]. */
type State = readonly [number, number, number];
const key = (s: State) => `${s[0]}:${s[1]}:${s[2]}`;

function step(tpl: Template, states: State[], ch: string): State[] {
  const out = new Map<string, State>();
  const push = (s: State) => out.set(key(s), s);
  for (const [a, i, n] of states) {
    const alt = tpl[a];
    // stay in token i (i = -1: before the first token)
    if (i >= 0 && i < alt.length && n < alt[i].max && alt[i].chars.includes(ch)) push([a, i, n + 1]);
    // move on to a later token, skipping tokens whose min is 0
    if (i >= 0 && i < alt.length && n < alt[i].min) continue;
    for (let j = i + 1; j < alt.length; j++) {
      if (alt[j].chars.includes(ch)) push([a, j, 1]);
      if (alt[j].min > 0) break;
    }
  }
  return [...out.values()];
}

const accepts = (tpl: Template, states: State[]) =>
  states.some(([a, i, n]) => {
    const alt = tpl[a];
    if (i >= alt.length) return true;
    return (i < 0 || n >= alt[i].min) && alt.slice(i + 1).every((t) => t.min === 0);
  });

const startStates = (tpl: Template): State[] => tpl.map((_, a) => [a, -1, 0] as const);

/** Whether a whole string is one of the template's patterns. */
export function matches(tpl: Template, text: string): boolean {
  let states = startStates(tpl);
  for (const ch of text) {
    states = step(tpl, states, ch);
    if (!states.length) return false;
  }
  return text !== '' && accepts(tpl, states);
}

/** Characters that may follow the states (any token reachable next). */
function nextChars(tpl: Template, states: State[]): Set<string> {
  const out = new Set<string>();
  for (const [a, i, n] of states) {
    const alt = tpl[a];
    if (i >= 0 && i < alt.length && n < alt[i].max) for (const c of alt[i].chars) out.add(c);
    if (i >= 0 && i < alt.length && n < alt[i].min) continue;
    for (let j = i + 1; j < alt.length; j++) {
      for (const c of alt[j].chars) out.add(c);
      if (alt[j].min > 0) break;
    }
  }
  return out;
}

// --- decoding -----------------------------------------------------------------------------------------------------

/** Greedy CTC: best class per frame, repeats collapsed, blanks dropped; a character's p = its best frame. */
export function greedy(f: Frames, allowed?: string): { text: string; steps: ReadingStep[]; seq_logprob: number } {
  const ok = allowed === undefined ? null : f.classes.map((ch, i) => i === 0 || allowed.includes(ch));
  const steps: ReadingStep[] = [];
  let prev = -1;
  for (let t = 0; t < f.T; t++) {
    let b1 = 0, p1 = -1, b2 = 0, p2 = -1;
    for (let k = 0; k < f.C; k++) {
      if (ok && !ok[k]) continue;
      const p = f.data[t * f.C + k];
      if (p > p1) [b2, p2, b1, p1] = [b1, p1, k, p];
      else if (p > p2) [b2, p2] = [k, p];
    }
    if (b1 !== 0 && b1 !== prev) steps.push({ text: f.classes[b1], p: p1, alt: f.classes[b2] || '∅', p_alt: p2 });
    else if (b1 !== 0 && p1 > steps[steps.length - 1].p) steps[steps.length - 1].p = p1;
    prev = b1;
  }
  return { text: steps.map((s) => s.text).join('').trim(), steps, seq_logprob: steps.reduce((a, s) => a + Math.log(Math.max(s.p, 1e-12)), 0) };
}

const LOG0 = -Infinity;
const lse = (a: number, b: number) => (a === LOG0 ? b : b === LOG0 ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b))));

export interface Decoded {
  text: string;
  logp: number; // log of the total CTC probability of `text` (all alignments) as kept by the beam
}

/** Best reading of `beamSearchAll` (undefined when no prefix survives). */
export const beamSearch = (f: Frames, tpl?: Template, width = 16, minP = 1e-4): Decoded | undefined => beamSearchAll(f, tpl, width, minP)[0];

/**
 * CTC prefix beam search, final beams most probable first. With a template, a prefix may only grow by characters the
 * pattern allows, and only prefixes the pattern accepts are returned (empty when none survives). Without one: plain search.
 */
export function beamSearchAll(f: Frames, tpl?: Template, width = 16, minP = 1e-4): Decoded[] {
  const index = new Map(f.classes.map((c, k) => [c, k] as const));
  type Beam = { text: string; last: number; pb: number; pnb: number; states: State[] };
  const init: State[] = tpl ? startStates(tpl) : [];
  let beams = new Map<string, Beam>([['', { text: '', last: -1, pb: 0, pnb: LOG0, states: init }]]);
  for (let t = 0; t < f.T; t++) {
    const row = f.data.subarray(t * f.C, (t + 1) * f.C);
    const likely = new Set<number>(); // classes worth extending with at this frame (computed once, not per beam)
    for (let k = 1; k < f.C; k++) if (row[k] >= minP) likely.add(k);
    const next = new Map<string, Beam>();
    const get = (text: string, last: number, states: State[]) => {
      let b = next.get(text);
      if (!b) next.set(text, (b = { text, last, pb: LOG0, pnb: LOG0, states }));
      return b;
    };
    for (const b of beams.values()) {
      const total = lse(b.pb, b.pnb);
      // blank: the prefix stays
      const blank = get(b.text, b.last, b.states);
      blank.pb = lse(blank.pb, total + Math.log(row[0]));
      // repeat of the last character without a blank in between: the prefix stays
      if (b.last > 0) {
        const same = get(b.text, b.last, b.states);
        same.pnb = lse(same.pnb, b.pnb + Math.log(row[b.last]));
      }
      const allowed = tpl ? nextChars(tpl, b.states) : null;
      const ks = allowed ? [...allowed].map((c) => index.get(c)).filter((k): k is number => k !== undefined && likely.has(k)) : likely;
      for (const k of ks) {
        const p = row[k];
        const states = tpl ? step(tpl, b.states, f.classes[k]) : [];
        if (tpl && !states.length) continue;
        const ext = get(b.text + f.classes[k], k, states);
        // a repeated character needs a blank in between
        ext.pnb = lse(ext.pnb, (k === b.last ? b.pb : total) + Math.log(p));
      }
    }
    beams = new Map([...next.entries()].sort((x, y) => lse(y[1].pb, y[1].pnb) - lse(x[1].pb, x[1].pnb)).slice(0, width));
  }
  return [...beams.values()]
    .filter((b) => !tpl || (b.text !== '' && accepts(tpl, b.states)))
    .map((b) => ({ text: b.text, logp: lse(b.pb, b.pnb) }))
    .sort((x, y) => y.logp - x.logp);
}

/** log P(target | frames) summed over all CTC alignments (forward algorithm); -Infinity if a character is not a class. */
export function ctcLogLik(f: Frames, target: string): number {
  const index = new Map(f.classes.map((c, k) => [c, k] as const));
  const ids = [...target].map((c) => index.get(c));
  if (ids.some((k) => k === undefined)) return LOG0;
  const L = 2 * ids.length + 1;
  const lab = (s: number) => (s % 2 === 0 ? 0 : ids[(s - 1) >> 1]!);
  let alpha = new Array<number>(L).fill(LOG0);
  alpha[0] = Math.log(f.data[0]);
  if (L > 1) alpha[1] = Math.log(f.data[lab(1)]);
  for (let t = 1; t < f.T; t++) {
    const next = new Array<number>(L).fill(LOG0);
    for (let s = 0; s < L; s++) {
      let a = alpha[s];
      if (s > 0) a = lse(a, alpha[s - 1]);
      if (s > 1 && lab(s) !== 0 && lab(s) !== lab(s - 2)) a = lse(a, alpha[s - 2]);
      next[s] = a + Math.log(f.data[t * f.C + lab(s)]);
    }
    alpha = next;
  }
  return L > 1 ? lse(alpha[L - 1], alpha[L - 2]) : alpha[0];
}

// --- per field ----------------------------------------------------------------------------------------------------

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const noAccents = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');
const dropAccented = (s: string) => s.replace(/[^\x00-\x7f]/g, ''); // some handwriting fonts have no "é"

/** What a reading means, for grouping candidates: its normalized value with case, accents and spaces folded. */
const meaning = (field: FieldDef, t: string) =>
  String(normalizeValue(field, t.trim()) ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '');

/**
 * Probability of the MEANING of `text` among all candidate readings: candidates that mean the same value ("160 Cm",
 * "160 cm", "160cm") are added up, readings that mean something else ("1/04" vs "11/04") compete. In [0, 1].
 */
export function meaningPosterior(field: FieldDef, candidates: Decoded[], text: string): number {
  return meanings(field, candidates).get(meaning(field, text))?.p ?? 0;
}

/** Candidates grouped by meaning: probability (sums to 1) and the most probable spelling of each meaning. */
export function meanings(field: FieldDef, candidates: Decoded[]): Map<string, { p: number; text: string }> {
  const byText = new Map<string, number>();
  for (const c of candidates) {
    const t = c.text.trim();
    if (c.logp > (byText.get(t) ?? LOG0)) byText.set(t, c.logp);
  }
  const groups = new Map<string, { logp: number; text: string; best: number }>();
  for (const [t, lp] of byText) {
    const k = meaning(field, t);
    const g = groups.get(k);
    if (!g) groups.set(k, { logp: lp, text: t, best: lp });
    else groups.set(k, { logp: lse(g.logp, lp), text: lp > g.best ? t : g.text, best: Math.max(g.best, lp) });
  }
  const total = [...groups.values()].reduce((a, g) => lse(a, g.logp), LOG0);
  return new Map([...groups].map(([k, g]) => [k, { p: total === LOG0 ? 0 : Math.exp(g.logp - total), text: g.text }]));
}

export interface FieldReading {
  text: string;
  posterior: number; // meaningPosterior of `text` (score.ts)
  method: 'free' | 'pattern' | 'enum' | 'pattern-failed';
  rank?: number; // pattern: rank of the returned reading among the pattern's beams (0 = the most probable; > 0 = the
  // more probable ones failed the field's validators)
  logp: number; // log P of the returned text
  logp_free: number; // log P of the most probable unconstrained reading (beam search): logp_free - logp >= 0 is the cost of the choice
  free: string; // the unconstrained reading (greedy)
  runner_up?: { text: string; logp: number }; // the best other candidate: second allowed value (enum), other pattern or free reading
}

/**
 * Reads one cell under its field's type (phase 2). The greedy reading (the most probable single frame path) is kept when
 * it already fits the field: summed over alignments, CTC can prefer "02/1/2025" to the greedy "02/11/2025" (a faint blank
 * between two "1"); the constraint only repairs readings that do not fit. The runner-up feeds the confidence (score.ts).
 */
export function readField(f: Frames, field: FieldDef): FieldReading {
  const frees = beamSearchAll(f);
  const g = greedy(f).text;
  const base = { free: g, logp_free: frees[0]?.logp ?? LOG0 };
  const other = (hits: Decoded[], text: string) => hits.find((h) => h.text.trim() !== text);
  const gr = { text: g, logp: ctcLogLik(f, g) };
  const done = (r: Omit<FieldReading, 'posterior' | 'free' | 'logp_free'>, candidates: Decoded[]): FieldReading =>
    ({ ...base, ...r, posterior: meaningPosterior(field, [...candidates, { text: r.text, logp: r.logp }], r.text) });
  if (field.type === 'enum' && field.allowed_values?.length) {
    // each allowed value in the ways it may be written; its score = the best of its spellings
    const spelled = [...field.allowed_values, '—'].map((v) => {
      const spellings = [...new Set([v, v.toLowerCase(), v.toUpperCase(), capital(v), noAccents(v), capital(noAccents(v)), dropAccented(v), v === '—' ? '-' : v])].filter(Boolean);
      return { text: v, spellings: spellings.map((s) => ({ text: s, logp: ctcLogLik(f, s) })) };
    });
    const scored = spelled.map((v) => ({ text: v.text, logp: Math.max(...v.spellings.map((s) => s.logp)) })).sort((a, b) => b.logp - a.logp);
    return done({ text: scored[0].text, method: 'enum', logp: scored[0].logp, runner_up: scored[1] }, [...frees, gr, ...spelled.flatMap((v) => v.spellings)]);
  }
  const tpl = templateFor(field);
  if (tpl) {
    const hits = beamSearchAll(f, tpl);
    const all = [...frees, gr, ...hits];
    const valid = (t: string) => { const v = normalizeValue(field, t); return v === null || !validateField(field, v).length; };
    if (matches(tpl, g) && valid(g)) return done({ text: g, method: 'pattern', logp: gr.logp, rank: 0, runner_up: other(hits, g) }, all);
    // else the most probable reading of the pattern that also passes the field's validators (month 0, 1 SA...), else the top one
    const rank = Math.max(0, hits.findIndex((h) => valid(h.text)));
    if (hits.length) return done({ text: hits[rank].text, method: 'pattern', logp: hits[rank].logp, rank, runner_up: other(hits, hits[rank].text) }, all);
    return done({ text: g, method: 'pattern-failed', logp: gr.logp, runner_up: other(frees, g) }, all);
  }
  // free text: a dotted line that leaked into the ink count is not writing
  const text = /^[.…·\-—_\s]*$/.test(g) && !/^[-—]$/.test(g) ? '' : g;
  return done({ text, method: 'free', logp: gr.logp, runner_up: other(frees, g) }, [...frees, gr]);
}
