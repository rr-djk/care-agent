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

test('a missing degree sign does not change the unit', () => {
  const t = f('number', { unit: '°C' });
  assert.equal(normalizeValue(t, '37.1 °C'), 37.1);
  assert.equal(normalizeValue(t, '36,8 C'), 36.8);
  assert.equal(normalizeValue(t, '37.2'), 37.2);
  assert.equal(normalizeValue(t, '37 F'), '37 F');
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

// Postpartum pages (steps 12): plausibility ranges and applicability, pages 7 and 8 share the fields of 5 and 6.
const postpartum = (layout: 'postpartum_mother' | 'postpartum_newborn', id: string) => {
  const field = loadPageSchema(layout).fields.find((x) => x.id === id)!;
  return (reading: string) => validateField(field, normalizeValue(field, reading));
};

test('postpartum mother: temperature, pulse, weight, blood pressure, date', () => {
  const temp = postpartum('postpartum_mother', 'p05.t_deg');
  assert.deepEqual(temp('37.2'), []);
  assert.deepEqual(temp('33'), ['range:34:42']);
  assert.deepEqual(temp('372'), ['range:34:42']);
  const pulse = postpartum('postpartum_mother', 'p05.pouls');
  assert.deepEqual([pulse('83'), pulse('40'), pulse('180')], [[], [], []]);
  assert.deepEqual([pulse('39'), pulse('181')], [['range:40:180'], ['range:40:180']]);
  const weight = postpartum('postpartum_mother', 'p05.poids');
  assert.deepEqual(weight('66 kg'), []);
  assert.deepEqual(weight('6 kg'), ['range:30:200']);
  assert.deepEqual(weight('66 g'), ['range:30:200']); // wrong unit stays text, the range rejects it
  assert.deepEqual(postpartum('postpartum_mother', 'p05.ta')('110/71'), []);
  assert.deepEqual(postpartum('postpartum_mother', 'p05.ta')('11/71'), ['bp']);
  assert.deepEqual(postpartum('postpartum_mother', 'p05.prochain_rendez_vous_le')('31/02/2026'), ['date']);
});

test('postpartum newborn: age in days, temperature, weight in g, height, head circumference', () => {
  const age = postpartum('postpartum_newborn', 'p06.age');
  assert.deepEqual([age('7 jours'), age('43 jours')], [[], []]);
  assert.deepEqual(age('120 jours'), ['range:0:90']);
  assert.deepEqual(postpartum('postpartum_newborn', 'p06.temperature')('36.8 C'), []);
  assert.deepEqual(postpartum('postpartum_newborn', 'p06.temperature')('3.7'), ['range:34:42']);
  const weight = postpartum('postpartum_newborn', 'p06.poids');
  assert.deepEqual(weight('3485 g'), []);
  assert.deepEqual(weight('3.5 g'), ['range:400:8000']);
  assert.deepEqual(weight('9000 g'), ['range:400:8000']);
  assert.deepEqual(postpartum('postpartum_newborn', 'p06.taille')('48 cm'), []);
  assert.deepEqual(postpartum('postpartum_newborn', 'p06.perimetre_cranien')('34 cm'), []);
  assert.deepEqual(postpartum('postpartum_newborn', 'p06.perimetre_cranien')('60 cm'), ['range:20:45']);
});

test('postpartum applicability rules', () => {
  const rule = (layout: 'postpartum_mother' | 'postpartum_newborn', id: string) =>
    loadPageSchema(layout).fields.find((x) => x.id === id)?.applicability;
  assert.equal(rule('postpartum_mother', 'p05.etat_de_la_cicatrice_text'), 'p05.cesarienne = true');
  assert.equal(rule('postpartum_mother', 'p05.autre_a_preciser'), 'p05.desire_utiliser_une_methode = true');
  assert.equal(rule('postpartum_mother', 'p05.si_la_mere_ne_desire_pas_une_methode_contraceptive_pourquoi_text'), 'p05.desire_utiliser_une_methode = false');
  assert.equal(rule('postpartum_newborn', 'p06.preciser_l_etablissement_de_reference'), 'p06.transfert = true');
});
