import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FieldDef } from './field';
import { PAGE_LAYOUTS } from './pageSchema';
import { loadPageSchema } from './node';
import { normalizeValue, validateField, validatePage, type Normalized } from './values';

const gt: Record<string, { layout: string; slots: { key: string; kind: string; value: string | boolean }[] }> = JSON.parse(
  readFileSync(new URL('../../../tools/eval/data/ground_truth.json', import.meta.url), 'utf8'),
);

const f = (type: FieldDef['type'], extra: Partial<FieldDef> = {}): FieldDef =>
  ({ id: 'x', label_fr: 'x', label_en: 'x', type, category: 'short_text', validators: [], zone: 'z', ...extra });

test('dates: d/m/yy, d-m-yyyy, d.m.yyyy become dd/mm/yyyy', () => {
  const d = f('date');
  assert.equal(normalizeValue(d, '7/1/26'), '07/01/2026');
  assert.equal(normalizeValue(d, '17-08-2025'), '17/08/2025');
  assert.equal(normalizeValue(d, '5.6.2025'), '05/06/2025');
  assert.equal(normalizeValue(d, 'demain'), 'demain');
});

test('numbers: decimal comma, unit suffix stripped, foreign suffix kept as text', () => {
  assert.equal(normalizeValue(f('number', { unit: 'kg' }), '58,8 kg'), 58.8);
  assert.equal(normalizeValue(f('number', { unit: 'g/dL' }), '11.8 g/dL'), 11.8);
  assert.equal(normalizeValue(f('number', { unit: 'SA' }), '12 sa'), 12);
  assert.equal(normalizeValue(f('number', { unit: 'kg' }), '58'), 58);
  assert.equal(normalizeValue(f('number', { unit: 'kg' }), '58 cm'), '58 cm');
});

test('empty, null and dashes are null; checkboxes are booleans', () => {
  assert.equal(normalizeValue(f('number'), ''), null);
  assert.equal(normalizeValue(f('short_text'), null), null);
  assert.equal(normalizeValue(f('short_text'), '—'), null);
  assert.equal(normalizeValue(f('checkbox'), 'x'), true);
  assert.equal(normalizeValue(f('checkbox'), ''), false);
});

test('blood pressure keeps its slash form', () => {
  assert.equal(normalizeValue(f('short_text', { validators: ['bp'] }), '104 / 74'), '104/74');
});

test('enums match case- and accent-insensitively, including a dropped accent', () => {
  const e = f('enum', { allowed_values: ['Normales', 'Pâles', 'Non immune'] });
  assert.equal(normalizeValue(e, 'normales'), 'Normales');
  assert.equal(normalizeValue(e, 'PALES'), 'Pâles');
  assert.equal(normalizeValue(e, 'P les'), 'Pâles');
  assert.equal(normalizeValue(e, 'non  immune'), 'Non immune');
  assert.equal(normalizeValue(e, 'autre'), 'autre');
});

test('validators: range, bp, date', () => {
  const r = f('number', { validators: ['range:30:200'] });
  assert.deepEqual(validateField(r, 58.8), []);
  assert.deepEqual(validateField(r, 20), ['range:30:200']);
  assert.deepEqual(validateField(r, '58 cm'), ['range:30:200']);
  assert.deepEqual(validateField(r, null), []);
  const bp = f('short_text', { validators: ['bp'] });
  assert.deepEqual(validateField(bp, '104/74'), []);
  for (const v of ['60/40', '260/80', '120/160', '90/90', '120-80']) assert.deepEqual(validateField(bp, v), ['bp'], v);
  const d = f('date', { validators: ['date'] });
  assert.deepEqual(validateField(d, '29/02/2024'), []);
  for (const v of ['29/02/2025', '31/04/2025', '01/01/1989', '01/01/2031', 'abc']) assert.deepEqual(validateField(d, v), ['date'], v);
  assert.throws(() => validateField(f('number', { validators: ['nope'] }), 1));
});

const pregnancy = loadPageSchema('pregnancy');
const identification = loadPageSchema('identification');
const dates = (ddr: string, dpa: string, dep: string) =>
  ({ 'p03.ddr': ddr, 'p03.date_prevue_d_accouchement': dpa, 'p03.date_de_depassement_de_terme': dep });

test('cross-field rules', () => {
  assert.deepEqual(validatePage(pregnancy, dates('26/04/2025', '31/01/2026', '07/02/2026')), []);
  assert.deepEqual(validatePage(pregnancy, dates('26/04/2025', '31/12/2025', '07/02/2026')).map((r) => r.rule), ['dpa-ddr:266-294', 'depassement-dpa:0-14']);
  assert.deepEqual(validatePage(pregnancy, dates('26/04/2025', '26/04/2025', '27/04/2025')).map((r) => r.rule), ['ddr<dpa', 'dpa-ddr:266-294']);
  assert.deepEqual(validatePage(pregnancy, { 'p03.ddr': '26/04/2025' }), []); // missing values: rule skipped
  assert.deepEqual(validatePage(identification, { 'p02.gestation': 1, 'p02.parite': 3 }).map((r) => r.rule), ['gestation>=parite']);
  assert.deepEqual(validatePage(identification, { 'p02.parite': 1, 'p02.nombre_d_enfants_vivants': 2 }).map((r) => r.rule), ['soft:parite>=enfants_vivants']);
  assert.deepEqual(validatePage(identification, { 'p02.gestation': 3, 'p02.parite': 2, 'p02.nombre_d_enfants_vivants': 2 }), []);
});

// Runs the ground-truth slots of one page through normalize + validators + cross-field rules.
function failures(layout: (typeof PAGE_LAYOUTS)[number], pageNo: string) {
  const schema = loadPageSchema(layout);
  const byId = new Map(schema.fields.map((x) => [x.id, x]));
  const values: Record<string, Normalized> = {};
  const failed: { id: string; verbatim: string; rule: string }[] = [];
  for (const s of gt[pageNo].slots) {
    const field = byId.get(s.key)!;
    const verbatim = s.kind === 'checkbox' ? (s.value ? 'x' : '') : String(s.value);
    values[s.key] = normalizeValue(field, verbatim);
    for (const rule of validateField(field, values[s.key])) failed.push({ id: s.key, verbatim, rule });
  }
  for (const r of validatePage(schema, values)) failed.push({ id: r.field_ids.join('+'), verbatim: r.field_ids.map((i) => values[i]).join(' / '), rule: r.rule });
  return failed;
}

test('specimen patient 1, page 3: every ground-truth value passes the validators', () => {
  assert.deepEqual(failures('pregnancy', '3'), []);
});

test('all specimen ground-truth values of pages 2, 3, 4 (10 patients): validator summary', () => {
  const failed: { page: string; id: string; verbatim: string; rule: string }[] = [];
  let values = 0;
  for (const [no, page] of Object.entries(gt)) {
    const layout = PAGE_LAYOUTS.find((l) => l === page.layout);
    if (!layout) continue;
    values += page.slots.length;
    failed.push(...failures(layout, no).map((x) => ({ page: no, ...x })));
  }
  const byRule: Record<string, number> = {};
  for (const x of failed) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1;
  console.log(`GT validation: ${values} values, ${failed.length} failures`, byRule);
  for (const x of failed) console.log(`  page ${x.page} ${x.id} = "${x.verbatim}" -> ${x.rule}`);
  assert.deepEqual(failed, []);
});
