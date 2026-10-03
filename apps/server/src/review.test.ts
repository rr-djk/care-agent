import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtractedField } from '@care-agent/schema';
import { pageSchemaFor } from './fields';
import { buildReview, type ReviewPage } from './review';

const f = (field_id: string, status: ExtractedField['status'], value: ExtractedField['value'], extra: Partial<ExtractedField> = {}, signals: Partial<ExtractedField['confidence_signals']> = {}): ExtractedField => ({
  field_id,
  value,
  status,
  confidence_signals: { validators_passed: true, quality: 1, ...signals },
  source_page: 3,
  ...extra,
});
const page = (id: string, fields: ExtractedField[], over: Partial<ReviewPage> = {}): ReviewPage => ({
  id,
  page_type: 3,
  state: 'NEEDS_REVIEW',
  flags: [],
  fields,
  reviewed: new Set(),
  ...over,
});

const P1 = [
  f('p03.ddr', 'KNOWN', '12/03/2026'),
  f('p03.taille', 'NEEDS_REVIEW', '1582', {}, { validators_passed: false }),
  f('p03.date_prevue_d_accouchement', 'NEEDS_REVIEW', null, {}, { agreement: 0 }),
  f('p03.date_de_depassement_de_terme', 'ILLEGIBLE', null),
  f('p03.rh_plus', 'UNKNOWN', null),
  f('p03.age_probable.v1_t1', 'UNKNOWN', null, { reason: 'manual' }),
  f('p03.poids_kg.v1_t1', 'ILLEGIBLE', null, { reason: 'left_illegible' }), // kept illegible: out of the queue
  f('p03.groupage_a', 'KNOWN', true),
];

test('queue: flagged fields in reading order with kind, reason and an explicit French doubt', () => {
  const q = buildReview([page('p1', P1)], pageSchemaFor);
  assert.deepEqual(q.items.map((i) => [i.field_id, i.kind, i.reason_code]), [
    ['p03.taille', 'doubt', 'unusual_value'],
    ['p03.date_prevue_d_accouchement', 'doubt', 'ink_but_empty'],
    ['p03.date_de_depassement_de_terme', 'illegible', 'illegible'],
    ['p03.rh_plus', 'unread', 'not_read'],
    ['p03.age_probable.v1_t1', 'manual', 'manual'],
  ]);
  const text = (id: string) => q.items.find((i) => i.field_id === id)!.text_fr;
  assert.equal(text('p03.taille'), "J'ai lu « 1582 » pour Taille, mais la valeur semble inhabituelle. Pouvez-vous vérifier ?");
  assert.equal(text('p03.date_prevue_d_accouchement'), "Je vois de l'écriture pour DATE PRÉVUE D'ACCOUCHEMENT mais je n'ai rien pu lire. Quelle est la valeur ?");
  assert.equal(text('p03.date_de_depassement_de_terme'), 'DATE DE DÉPASSEMENT DE TERME est illisible pour moi. Quelle est la valeur ?');
  assert.equal(text('p03.rh_plus'), "Je n'ai pas pu lire Rh+. Quelle est la valeur ?");
});

test('actions: confirm only when there is a value; retake and leave_illegible always', () => {
  const q = buildReview([page('p1', P1)], pageSchemaFor);
  const actions = (id: string) => q.items.find((i) => i.field_id === id)!.actions;
  assert.deepEqual(actions('p03.taille'), ['confirm', 'correct', 'retake', 'leave_illegible']);
  assert.deepEqual(actions('p03.rh_plus'), ['correct', 'retake', 'leave_illegible']);
});

test('a value the midwife typed that still fails says so', () => {
  const typed = f('p03.taille', 'NEEDS_REVIEW', '1700', { reason: 'corrected' }, { validators_passed: false });
  const [item] = buildReview([page('p1', [typed])], pageSchemaFor).items;
  assert.equal(item.text_fr, 'Vous avez saisi « 1700 » pour Taille, mais la valeur semble inhabituelle. Pouvez-vous vérifier ?');
});

test('several pages: capture order, superseded and closed pages skipped, progress per page and per session', () => {
  const two = [f('p03.taille', 'NEEDS_REVIEW', '1582', {}, { validators_passed: false }), f('p03.ddr', 'KNOWN', '12/03/2026')];
  const q = buildReview(
    [
      page('p1', P1, { reviewed: new Set(['p03.ddr', 'p03.groupage_a', 'p03.poids_kg.v1_t1']) }), // 5 open + 3 already reviewed
      page('old', two, { flags: ['SUPERSEDED'] }),
      page('p2', two),
      page('p3', two, { state: 'VALIDATED', reviewed: new Set(['p03.taille']) }),
    ],
    pageSchemaFor,
  );
  assert.deepEqual([...new Set(q.items.map((i) => i.page_id))], ['p1', 'p2']);
  assert.deepEqual(q.progress.pages.map((p) => [p.page_id, p.total, p.done]), [['p1', 8, 3], ['p2', 1, 0], ['p3', 1, 1]]);
  assert.deepEqual([q.progress.total, q.progress.done], [10, 4]);
});

test('an empty queue is a valid answer', () => {
  assert.deepEqual(buildReview([page('p1', [f('p03.ddr', 'KNOWN', '12/03/2026')])], pageSchemaFor).items, []);
});
