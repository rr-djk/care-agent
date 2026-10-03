import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtractedField } from '@care-agent/schema';
import { applyPage, buildValues, findConflicts, usable, valueKey, type Choice, type ValuePage } from './record';

const f = (field_id: string, value: ExtractedField['value'], status: ExtractedField['status'] = 'KNOWN'): ExtractedField => ({
  field_id,
  value,
  status,
  confidence_signals: { validators_passed: true, quality: 1 },
  source_page: 3,
});
const page = (id: string, fields: ExtractedField[], page_type = 3): ValuePage => ({ id, page_type, captured_at: `2026-10-0${id.slice(1)}T10:00:00Z`, fields });
const NONE = new Map<string, Choice>();
const retained = (pages: ValuePage[], choices: Map<string, Choice> = NONE) => {
  const v = buildValues(pages, choices);
  return Object.fromEntries([...v].filter(([, r]) => usable(r.field)).map(([k, r]) => [k.split(':')[1], [r.field.value, r.page_id]]));
};

test('first page: its non-empty KNOWN values are retained, empty ones are not', () => {
  assert.deepEqual(retained([page('p1', [f('ddr', '12/03/2026'), f('taille', null, 'NOT_PROVIDED'), f('oui', false), f('x', '9', 'ILLEGIBLE')])]), { ddr: ['12/03/2026', 'p1'] });
});

test('a value for a field that was empty is added without any choice', () => {
  const pages = [page('p1', [f('ddr', '12/03/2026'), f('poids', null, 'NOT_PROVIDED')]), page('p2', [f('ddr', '12/03/2026'), f('poids', '70')])];
  assert.deepEqual(findConflicts(buildValues([pages[0]], NONE), pages[1]), []);
  assert.deepEqual(retained(pages), { ddr: ['12/03/2026', 'p1'], poids: ['70', 'p2'] }); // same value: the older source stays
});

test('new page empty or unreliable: conflict with default "old"; a different usable value: default "new"', () => {
  const old = buildValues([page('p1', [f('ddr', '12/03/2026'), f('poids', '70'), f('bcf', '140'), f('oui', true)])], NONE);
  const next = page('p2', [f('ddr', null, 'NOT_PROVIDED'), f('poids', '72'), f('bcf', '150', 'NEEDS_REVIEW'), f('oui', false)]);
  const c = findConflicts(old, next);
  assert.deepEqual(c.map((x) => [x.field_id, x.default]), [['ddr', 'old'], ['poids', 'new'], ['bcf', 'old'], ['oui', 'old']]);
  assert.deepEqual(c.map((x) => x.old.page_id), ['p1', 'p1', 'p1', 'p1']);
});

test('choices settle the conflicts; both pages stay as sources', () => {
  const pages = [page('p1', [f('ddr', '12/03/2026'), f('poids', '70')]), page('p2', [f('ddr', null, 'NOT_PROVIDED'), f('poids', '72')])];
  assert.deepEqual(retained(pages, new Map<string, Choice>([['p2|ddr', 'old'], ['p2|poids', 'new']])), { ddr: ['12/03/2026', 'p1'], poids: ['72', 'p2'] });
  assert.deepEqual(retained(pages, new Map<string, Choice>([['p2|ddr', 'new'], ['p2|poids', 'old']])), { poids: ['70', 'p1'] }); // "take the new one" may clear a value
  assert.deepEqual(retained(pages), { ddr: ['12/03/2026', 'p1'], poids: ['70', 'p1'] }); // no choice recorded: nothing is overwritten
});

test('page types are separate: page 7 reuses the field ids of page 5', () => {
  const v = buildValues([page('p1', [f('poids', '3200')], 5), page('p2', [f('poids', '3100')], 7)], NONE);
  assert.deepEqual([v.get(valueKey({ page_type: 5 }, 'poids'))?.field.value, v.get(valueKey({ page_type: 7 }, 'poids'))?.field.value], ['3200', '3100']);
});

test('applyPage compares values ignoring case, accents and spaces', () => {
  const v = buildValues([page('p1', [f('ex', 'Normaux')])], NONE);
  assert.deepEqual(findConflicts(v, page('p2', [f('ex', ' normaux ')])), []);
  applyPage(v, page('p2', [f('ex', 'Anormaux')]), new Map<string, Choice>([['ex', 'new']]));
  assert.equal(v.get(valueKey({ page_type: 3 }, 'ex'))?.page_id, 'p2');
});

test('the fiche number written with spaces or dashes is not a difference', () => {
  const v = buildValues([page('p1', [f('p01.n_deg_de_la_fiche', '2026-711-003')], 1)], NONE);
  assert.deepEqual(findConflicts(v, page('p2', [f('p01.n_deg_de_la_fiche', '2026 711 003')], 1)), []);
  assert.equal(findConflicts(v, page('p3', [f('p01.n_deg_de_la_fiche', '2026-711-008')], 1)).length, 1);
});
