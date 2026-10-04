import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editDistance, findCandidates, normalizeFacility, normalizeFiche, propose, type KnownPatient, type SessionKey } from './linking';

const patient = (id: string, fiche: string, facility: string, attrs: KnownPatient['attrs'] = {}): KnownPatient => ({ id, fiche_number: fiche, facility, attrs, visits: 1, last_visit: '2026-10-01T09:00:00.000Z' });
const session = (fiche: string | null, facility: string | null, attrs: SessionKey['attrs'] = {}, source: SessionKey['source'] = 'cover'): SessionKey => ({ fiche, facility, attrs, source });
const P1 = patient('PAT-000001', '2026-823-001', 'CSCA Al Wifaq', { age: 28, ddr: '12/03/2026', gestation: 2, parite: 1, province: 'Kénitra' });

test('normalizeFiche: separators, case, run-together digits; O/I confusions and odd shapes are low confidence', () => {
  assert.deepEqual(normalizeFiche(' 2026-823-001 '), { key: '2026-823-001', low_confidence: false });
  assert.deepEqual(normalizeFiche('2026/823 001'), { key: '2026-823-001', low_confidence: false });
  assert.deepEqual(normalizeFiche('2026–823–001'), { key: '2026-823-001', low_confidence: false });
  assert.deepEqual(normalizeFiche('2026823001'), { key: '2026-823-001', low_confidence: false });
  assert.deepEqual(normalizeFiche('2O26-823-OO1'), { key: '2026-823-001', low_confidence: true }); // letters read for zeros
  assert.deepEqual(normalizeFiche('2026-B23-001'), { key: '2026-B23-001', low_confidence: true }); // not a fiche shape
  assert.equal(normalizeFiche('2026-823').low_confidence, true);
});

test('normalizeFacility and editDistance', () => {
  assert.equal(normalizeFacility('  CSCA  Al-Wifaq '), 'csca al wifaq');
  assert.equal(normalizeFacility('Centre de Santé Hay Salam'), normalizeFacility('centre de sante hay salam'));
  assert.equal(editDistance('2026-823-001', '2026-823-007'), 1);
  assert.equal(editDistance('abc', 'a'), 2);
});

test('exact key (case, separators, accents ignored) with consistent attributes: one candidate, proposed', () => {
  const p = propose('s1', session('2026 823 001', 'csca al-wifaq', { age: 28, ddr: '15/03/2026', gestation: 2, parite: 1, province: 'Kenitra' }), [P1, patient('PAT-000002', '2026-711-003', 'DR Tahannaout Sud')]);
  assert.equal(p.question, 'propose');
  assert.equal(p.candidates.length, 1);
  const [c] = p.candidates;
  assert.deepEqual([c.patient_id, c.kind, c.consistent], ['PAT-000001', 'exact', true]);
  assert.ok(c.score >= 0.9);
  assert.equal(c.reasons[0], 'Même numéro de fiche et même établissement.');
  assert.ok(c.reasons.includes('Âge concordant (28 ans).'));
  assert.deepEqual(c.summary, { fiche_number: '2026-823-001', facility: 'CSCA Al Wifaq', age: 28, ddr: '12/03/2026', gestation: 2, parite: 1, visits: 1, last_visit: '2026-10-01T09:00:00.000Z' });
  assert.deepEqual(p.current, { age: 28, ddr: '15/03/2026', gestation: 2, parite: 1 }); // the session side of the comparison (no province)
  assert.match(p.text_fr, /PAT-000001/);
});

test('exact key but a contradicting attribute: not proposed, the 4-button question with the reason', () => {
  const p = propose('s1', session('2026-823-001', 'CSCA Al Wifaq', { age: 35 }), [P1]);
  assert.equal(p.question, 'choose');
  const [c] = p.candidates;
  assert.equal(c.consistent, false);
  assert.ok(c.score < 0.9);
  assert.ok(c.reasons.some((r) => r.startsWith('Âge différent')));
  for (const [attrs, word] of [[{ ddr: '01/09/2026' }, 'DDR'], [{ gestation: 4 }, 'Gestité'], [{ parite: 3 }, 'Parité'], [{ province: 'Rabat' }, 'Province']] as const) {
    const q = propose('s1', session('2026-823-001', 'CSCA Al Wifaq', attrs), [P1]);
    assert.equal(q.question, 'choose', word);
    assert.ok(q.candidates[0].reasons.some((r) => r.startsWith(`${word} différente`)), word);
  }
});

test('near matches: fiche one edit away, facility name one edit away, same facility with close LMP and age', () => {
  const near = findCandidates(session('2026-823-007', 'CSCA Al Wifaq'), [P1]);
  assert.deepEqual(near.map((c) => c.kind), ['near_fiche']);
  assert.ok(near[0].score < 0.9);
  const facility = findCandidates(session('2026-823-001', 'CSCA Al Wifak'), [P1]);
  assert.deepEqual(facility.map((c) => c.kind), ['near_facility']);
  const attrs = findCandidates(session('2026-999-777', 'CSCA Al Wifaq', { age: 29, ddr: '18/03/2026' }), [P1]);
  assert.deepEqual(attrs.map((c) => c.kind), ['near_attributes']);
  assert.deepEqual(findCandidates(session('2026-999-777', 'CSCA Al Wifaq', { age: 31, ddr: '18/03/2026' }), [P1]), []); // age too far
  assert.deepEqual(findCandidates(session('2026-999-777', 'CSCA Al Wifaq', { age: 28, ddr: '30/03/2026' }), [P1]), []); // LMP too far
  assert.deepEqual(findCandidates(session('2026-999-777', 'Autre centre', { age: 28, ddr: '12/03/2026' }), [P1]), []); // another facility
  assert.equal(propose('s1', session('2026-823-007', 'CSCA Al Wifaq'), [P1]).question, 'choose'); // a near match is never proposed alone
});

test('same fiche in another facility is another patient: no candidate, propose to create', () => {
  const p = propose('s1', session('2026-823-001', 'DR Tahannaout Sud'), [P1]);
  assert.equal(p.question, 'create');
  assert.deepEqual(p.candidates, []);
});

test('several candidates: best first, at most two, 4-button question', () => {
  const twin = patient('PAT-000002', '2026-823-001', 'CSCA Al Wifaq'); // a duplicate already in the registry
  const third = patient('PAT-000003', '2026-823-002', 'CSCA Al Wifaq');
  const p = propose('s1', session('2026-823-001', 'CSCA Al Wifaq'), [third, twin, P1]);
  assert.equal(p.question, 'choose');
  assert.deepEqual(p.candidates.map((c) => c.patient_id), ['PAT-000001', 'PAT-000002']);
});

test('low-confidence fiche: confirm first, no candidates yet; a typed or confirmed value is trusted', () => {
  const p = propose('s1', session('2O26-823-OO1', 'CSCA Al Wifaq'), [P1]);
  assert.deepEqual([p.question, p.fiche.low_confidence, p.candidates], ['confirm_fiche', true, []]);
  assert.equal(p.text_fr, "J'ai lu 2O26-823-OO1, est-ce correct ?");
  const typed = propose('s1', session('2O26-823-OO1', 'CSCA Al Wifaq', {}, 'typed'), [P1]);
  assert.equal(typed.question, 'propose'); // the midwife confirmed it; the key is normalized for matching
  assert.equal(typed.fiche.low_confidence, false);
});

test('a code alone (no facility): matched on the code, near on one edit, never on attributes; a patient without facility matches any', () => {
  const p = propose('s1', session('2026-823-001', null, {}, 'typed'), [P1]);
  assert.equal(p.question, 'propose');
  assert.equal(p.candidates[0].reasons[0], 'Même numéro de fiche (aucun établissement indiqué).');
  assert.deepEqual(findCandidates(session('2026-823-007', null), [P1]).map((c) => c.kind), ['near_fiche']);
  assert.deepEqual(findCandidates(session('2026-999-777', null, { age: 28, ddr: '12/03/2026' }), [P1]), []); // attributes need a facility
  const noFacility = patient('PAT-000009', '2026-555-001', '');
  assert.deepEqual(findCandidates(session('2026-555-001', 'CSCA Al Wifaq'), [noFacility]).map((c) => c.kind), ['exact']);
  assert.match(propose('s1', session('2026-111-004', null, {}, 'typed'), []).text_fr, /^Aucun dossier ne correspond à la fiche 2026-111-004\. /);
});

test('missing fiche: ask to type it; nothing known: propose to create', () => {
  assert.equal(propose('s1', session(null, 'CSCA Al Wifaq', {}, 'none'), [P1]).question, 'need_key');
  const none = propose('s1', session('2026-111-004', 'CSCA Al Wifaq'), []);
  assert.deepEqual([none.question, none.candidates], ['create', []]);
});
