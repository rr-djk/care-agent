import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_LAYOUTS } from './pageSchema';
import { loadPageSchema } from './node';

const gt: Record<string, { layout: string; slots: { key: string }[] }> = JSON.parse(
  readFileSync(new URL('../../../tools/eval/data/ground_truth.json', import.meta.url), 'utf8'),
);

// Same list as schema.test.ts, matched on whole words (ids and labels are words, not schema keys).
const FORBIDDEN = [
  'name', 'nom', 'prenom', 'husband', 'mari', 'spouse', 'conjoint', 'cin',
  'national', 'phone', 'telephone', 'tel', 'address', 'adresse',
];
const words = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z]+/);

for (const layout of PAGE_LAYOUTS) {
  test(`${layout}: zones and fields cover each other exactly`, () => {
    const s = loadPageSchema(layout);
    const ids = s.fields.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate field id');
    const cells = s.zones.flatMap((z) => z.cells);
    assert.deepEqual([...cells].sort(), [...ids].sort(), 'every field belongs to exactly one zone');
    for (const z of s.zones) {
      for (const id of z.cells) assert.equal(s.fields.find((f) => f.id === id)?.zone, z.id, `${id}.zone`);
      if (z.rows || z.columns) assert.equal(z.cells.length, (z.rows?.length ?? 0) * (z.columns?.length ?? 0), `${z.id} table size`);
    }
  });

  test(`${layout}: fields equal the ground-truth keys`, () => {
    const s = loadPageSchema(layout);
    const keys = new Set(Object.values(gt).filter((p) => p.layout === layout).flatMap((p) => p.slots.map((x) => x.key)));
    assert.deepEqual(new Set(s.fields.map((f) => f.id)), keys);
  });

  test(`${layout}: no identifier field`, () => {
    const s = loadPageSchema(layout);
    for (const f of s.fields) {
      // "mari_famille" is the husband's family history (medical), not an identifier; "Nom de l'établissement" is the facility
      const w = [
        ...words(f.id.replace(/mari_famille$|nom_de_l_etablissement_sanitaire$/, '')),
        ...words(f.label_fr.replace(/mari \/ famille|^Nom de l'établissement sanitaire$/, '')),
        ...words(f.label_en),
      ];
      assert.deepEqual(w.filter((x) => FORBIDDEN.includes(x)), [], f.id);
    }
  });

  test(`${layout}: applicability and validators refer to known things`, () => {
    const s = loadPageSchema(layout);
    const ids = new Set(s.fields.map((f) => f.id));
    for (const f of s.fields) {
      if (f.applicability) assert.ok(ids.has(f.applicability.split(' = ')[0]), `${f.id} applicability`);
      for (const v of f.validators) assert.match(v, /^(range:\d+:\d+|bp|date)$/, `${f.id} validator`);
    }
  });
}

test('page 3 visit table zones in columns 2 and 3 carry the row-label strip, column 1 does not', () => {
  const s = loadPageSchema('pregnancy');
  for (const z of s.zones.filter((x) => x.id.startsWith('p03.visits.') && x.rows)) { // single-row zones (Fer, Examen fait par) have no table
    assert.equal(z.label_strip !== undefined, !z.id.endsWith('c1'), z.id);
  }
});

test('postpartum layouts serve page types 5/7 and 6/8, which share their field ids', () => {
  assert.deepEqual(loadPageSchema('postpartum_mother').page_types, [5, 7]);
  assert.deepEqual(loadPageSchema('postpartum_newborn').page_types, [6, 8]);
  // the header of page 7 prints other options than page 5: both sets are cells of the layout
  const ids = loadPageSchema('postpartum_mother').fields.map((f) => f.id);
  assert.ok(ids.includes('p05.entre_le_7eme_et_8eme_jour_apres_l_accouchement') && ids.includes('p05.entre_le_40eme_et_50eme_jour_apres_l_accouchement'));
  for (const l of ['postpartum_mother', 'postpartum_newborn'] as const) {
    assert.ok(gt && Object.values(gt).filter((p) => p.layout === l).length === 20, `${l}: 10 patients x 2 pages`);
  }
});

test('the mother header with the woman name is a mask and no cell', () => {
  const s = loadPageSchema('postpartum_mother');
  assert.equal(s.masks.length, 1);
  assert.ok(s.masks[0][1] < 0.075 && s.masks[0][3] < 0.08, 'mask sits on the "MÈRE — <name>" line above the first cell');
  assert.ok(s.zones.every((z) => z.bbox_frac[1] >= 0.065));
});

test('real_cover (real registry, step 12): loads, no identifier field, no ground truth', () => {
  const s = loadPageSchema('real_cover');
  assert.deepEqual(s.page_types, [1]);
  assert.equal(s.fields.length, 21);
  const cells = s.zones.flatMap((z) => z.cells);
  assert.deepEqual([...cells].sort(), s.fields.map((f) => f.id).sort());
  for (const f of s.fields) {
    const w = [...words(f.id.replace(/nom_de_l_etablissement_sanitaire$/, '')), ...words(f.label_fr.replace(/^Nom de l'établissement sanitaire$/, '')), ...words(f.label_en)];
    assert.deepEqual(w.filter((x) => FORBIDDEN.includes(x)), [], f.id);
  }
});
