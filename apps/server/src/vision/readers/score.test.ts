import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FieldDef } from '@care-agent/schema';
import { readerScore, readerSignals, readerStatus } from './score';

const field = (f: Partial<FieldDef>): FieldDef => ({ id: 'x', label_fr: 'x', label_en: 'x', type: 'short_text', category: 'short_text', validators: [], zone: 'z', ...f }) as FieldDef;
const date = field({ type: 'date', validators: ['date'] });
const clear = (text: string) => ({ text, steps: [...text].map(() => ({ p: 0.99 })), logp: Math.log(0.99) * text.length, logp_free: Math.log(0.99) * text.length });

test('a clear reading that passes the validators scores high', () => {
  assert.ok(readerScore(readerSignals(clear('12/05/2025'), date)) > 0.95);
});

test('a reading that fails a validator scores 0', () => {
  const s = readerSignals(clear('12/13/2025'), date); // month 13
  assert.equal(s.validators_passed, false);
  assert.equal(readerScore(s), 0);
});

test('the weakest signal decides: a faint character, a costly constraint, a close runner-up', () => {
  const faint = { ...clear('12/05/2025'), steps: [{ p: 0.4 }, ...clear('2/05/2025').steps] };
  assert.ok(readerScore(readerSignals(faint, date)) <= 0.4);
  const forced = { ...clear('3699'), logp_free: clear('3699').logp + 3 }; // the free reading was e^3 times more probable
  assert.ok(readerScore(readerSignals(forced, field({ type: 'number', unit: 'g' }))) < 0.06);
  // "02/11/2025" read with "02/1/2025" almost as probable (a faint blank between the two "1")
  const close = { ...clear('02/11/2025'), runner_up: { logp: clear('02/11/2025').logp - 0.26 } };
  assert.ok(readerScore(readerSignals(close, date)) < 0.25);
});

test('an enum close to its runner-up is doubtful; a runner-up more probable than the reading gives 0', () => {
  const r = { ...clear('Neg'), runner_up: { logp: clear('Neg').logp - 0.1 } };
  assert.ok(readerScore(readerSignals(r, field({ type: 'enum', allowed_values: ['Neg', 'Pos'] }))) < 0.1);
  assert.equal(readerSignals({ ...clear('Neg'), runner_up: { logp: 0 } }, field({ type: 'enum' })).margin, 0);
});

test('status: KNOWN under the threshold goes to review with a reason; other statuses are untouched', () => {
  assert.deepEqual(readerStatus('KNOWN', 0.5, 0.8), { status: 'NEEDS_REVIEW', reason: 'low_reader_confidence' });
  assert.deepEqual(readerStatus('KNOWN', 0.9, 0.8), { status: 'KNOWN' });
  assert.deepEqual(readerStatus('NOT_PROVIDED', 0, 0.8), { status: 'NOT_PROVIDED' });
});

test('with a posterior, the score is the posterior (0 if a validator fails)', () => {
  assert.equal(readerScore(readerSignals({ ...clear('160 Cm'), steps: [{ p: 0.3 }], posterior: 0.97 }, field({ type: 'number', unit: 'cm', validators: ['range:120:200'] }))), 0.97);
  assert.equal(readerScore(readerSignals({ ...clear('12/13/2025'), posterior: 0.99 }, date)), 0);
});
