import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FieldDef } from '@care-agent/schema';
import { beamSearch, ctcLogLik, readField, templateFor, type Frames } from './ctc';

const CLASSES = ['', ...'0123456789/.-—,abcdegiklmnoANPRSsxé', ' '];

/** One frame per entry: {char: p}, the rest of the mass on the blank; '_' = a blank frame. */
function frames(spec: (Record<string, number> | '_')[]): Frames {
  const C = CLASSES.length;
  const data = new Float32Array(spec.length * C);
  spec.forEach((s, t) => {
    const row = data.subarray(t * C, (t + 1) * C);
    let used = 0;
    if (s !== '_') for (const [c, p] of Object.entries(s)) { row[CLASSES.indexOf(c)] = p; used += p; }
    row[0] = Math.max(1e-6, 1 - used);
  });
  return { T: spec.length, C, data, classes: CLASSES };
}
const spell = (s: string, p = 0.95) => [...s].flatMap((c) => [{ [c]: p }, '_' as const]);
const field = (f: Partial<FieldDef>): FieldDef => ({ id: 'x', label_fr: 'x', label_en: 'x', type: 'short_text', category: 'short_text', validators: [], zone: 'z', ...f }) as FieldDef;

test('free beam search reads clear frames', () => {
  assert.equal(beamSearch(frames(spell('12/05/2025')))?.text, '12/05/2025');
});

test('a date pattern turns a slash read as 1 back into a slash', () => {
  const f = frames([...spell('05'), { '1': 0.5, '/': 0.4 }, '_', ...spell('06/2025')]);
  const date = field({ type: 'date', validators: ['date'] });
  assert.equal(readField(f, date).free, '05106/2025');
  const r = readField(f, date);
  assert.equal(r.text, '05/06/2025');
  assert.equal(r.method, 'pattern');
  assert.ok(r.logp_free >= r.logp, 'the constrained reading cannot be more likely than the free one');
});

test('a number pattern keeps the unit and refuses letters elsewhere', () => {
  const kg = field({ type: 'number', unit: 'g', validators: ['range:400:6000'] });
  assert.equal(readField(frames(spell('3626 g')), kg).text, '3626 g');
  assert.equal(readField(frames([...spell('3'), { s: 0.6, '6': 0.3 }, '_', ...spell('26')]), kg).text, '3626');
});

test('blood pressure and the written dash', () => {
  const bp = field({ validators: ['bp'] });
  assert.equal(readField(frames([...spell('120'), { '1': 0.55, '/': 0.4 }, '_', ...spell('62')]), bp).text, '120/62');
  assert.equal(readField(frames(spell('—')), field({ type: 'date', validators: ['date'] })).text, '—');
});

test('patterns: no letters in a date, unit optional in a number', () => {
  const t = templateFor(field({ type: 'date', validators: ['date'] }))!;
  assert.ok(t.every((alt) => alt.every((k) => !/[a-z]/i.test(k.chars))));
  assert.equal(templateFor(field({ type: 'short_text' })), undefined);
});

test('ctcLogLik: certain frames give ~0, an impossible target -Infinity', () => {
  const f = frames(spell('Neg', 0.999));
  assert.ok(ctcLogLik(f, 'Neg') > -0.05);
  assert.equal(ctcLogLik(f, 'Pos'), -Infinity);
  assert.equal(ctcLogLik(f, 'Q'), -Infinity); // not a class
});

test('an enum takes the allowed value the recogniser scores best, with the runner-up', () => {
  const f = frames([{ N: 0.9 }, '_', { e: 0.3, o: 0.2 }, '_', { g: 0.8 }, '_']);
  const r = readField(f, field({ type: 'enum', allowed_values: ['Neg', 'Pos'] }));
  assert.equal(r.text, 'Neg');
  assert.equal(r.method, 'enum');
  assert.ok(r.runner_up && r.runner_up.logp < r.logp);
});

test('free text: a dotted line is not writing, a word is kept', () => {
  assert.equal(readField(frames(spell('....')), field({ type: 'free_text' })).text, '');
  assert.equal(readField(frames(spell('RAS')), field({ type: 'free_text' })).text, 'RAS');
});

test('a pattern reading that fails the validators gives way to the next probable one', () => {
  // the "1" of the month is faint: "20/0/2026" (month 00) is the most probable string, "20/01/2026" the valid one
  const f = frames([...spell('20/0'), { '1': 0.3 }, '_', ...spell('/2026')]);
  const r = readField(f, field({ type: 'date', validators: ['date'] }));
  assert.equal(r.text, '20/01/2026');
  assert.ok(r.rank! > 0);
});

test('the greedy reading is kept when it fits the pattern, even if CTC sums favour a merged one', () => {
  // two "1" with a faint blank between them: greedy reads "02/11/2025"; summed over alignments "02/1/2025" can win
  const f = frames([...spell('02/'), { '1': 0.86 }, { '1': 0.23 }, { '1': 0.63 }, '_', ...spell('/2025')]);
  const r = readField(f, field({ type: 'date', validators: ['date'] }));
  assert.equal(r.text, '02/11/2025');
  assert.ok(r.runner_up, 'the merged reading is the runner-up');
});
