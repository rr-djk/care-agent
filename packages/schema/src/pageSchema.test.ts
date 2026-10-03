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
      // "mari_famille" is the husband's family history (medical), not an identifier
      const w = [...words(f.id.replace(/mari_famille$/, '')), ...words(f.label_fr.replace(/mari \/ famille/, '')), ...words(f.label_en)];
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

test('page 3 visit columns 2 and 3 carry the row-label strip, column 1 does not', () => {
  const s = loadPageSchema('pregnancy');
  for (const z of s.zones.filter((x) => x.id.startsWith('p03.visits.'))) {
    assert.equal(z.label_strip !== undefined, !z.id.endsWith('c1'), z.id);
  }
});
