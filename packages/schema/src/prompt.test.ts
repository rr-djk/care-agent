import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPageSchema } from './node';
import { buildZonePrompt, parseZoneAnswer } from './prompt';

const fixture = (zone: string) => readFileSync(new URL(`../test-fixtures/prompt-${zone}.txt`, import.meta.url), 'utf8');
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

test('table zone prompt matches the committed snapshot and stays short', () => {
  const p = buildZonePrompt(loadPageSchema('pregnancy'), 'p03.visits.r2c1');
  assert.equal(p.prompt + '\n', fixture('p03.visits.r2c1'));
  assert.ok(words(p.prompt) < 110, `${words(p.prompt)} words`);
  assert.equal(p.cellIds.length, 21);
  assert.deepEqual(p.format, {
    type: 'object',
    properties: { cells: { type: 'array', minItems: 21, maxItems: 21, items: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
    required: ['cells'],
  });
});

test('ink-guided prompt lists only the asked cells, row by row', () => {
  const schema = loadPageSchema('pregnancy');
  const zone = schema.zones.find((z) => z.id === 'p03.visits.r2c1')!;
  const cells = zone.cells.filter((_, i) => i % 3 === 0); // column T1 V1
  const p = buildZonePrompt(schema, 'p03.visits.r2c1', { cells: [...cells].reverse() }); // zone order wins
  assert.equal(p.prompt + '\n', fixture('p03.visits.r2c1.guided'));
  assert.deepEqual(p.cellIds, cells);
  assert.equal(cells.length, 7);
  assert.equal((p.format as any).properties.cells.minItems, 7);
  assert.equal((p.format as any).properties.cells.maxItems, 7);
  assert.throws(() => buildZonePrompt(schema, 'p03.visits.r2c1', { cells: ['p03.ddr'] }));
});

test('form zone prompt matches the committed snapshot and stays short', () => {
  const p = buildZonePrompt(loadPageSchema('delivery'), 'p04.newborn');
  assert.equal(p.prompt + '\n', fixture('p04.newborn'));
  assert.ok(words(p.prompt) < 110, `${words(p.prompt)} words`);
  assert.equal(p.cellIds.length, 8);
});

test('every zone of every layout builds a prompt (13-cell form zones are the longest)', () => {
  for (const l of ['cover', 'identification', 'pregnancy', 'delivery', 'postpartum_mother', 'postpartum_newborn'] as const) {
    const s = loadPageSchema(l);
    for (const z of s.zones) assert.ok(words(buildZonePrompt(s, z.id).prompt) < 140, z.id);
  }
});

test('unknown zone throws', () => {
  assert.throws(() => buildZonePrompt(loadPageSchema('delivery'), 'nope'));
});

test('parseZoneAnswer: strings, "" and null are accepted and keyed by cell id', () => {
  const r = parseZoneAnswer('{"cells":["17/08/2025","",null]}', ['a', 'b', 'c']);
  assert.ok(r.ok);
  assert.deepEqual([...r.cells], [['a', '17/08/2025'], ['b', ''], ['c', null]]);
});

test('parseZoneAnswer: wrong length, bad shape and bad JSON are typed errors', () => {
  const code = (raw: string, n: number) => {
    const r = parseZoneAnswer(raw, Array.from({ length: n }, (_, i) => `c${i}`));
    return r.ok ? 'ok' : r.error.code;
  };
  assert.equal(code('{"cells":["a","b"]}', 3), 'wrong_length');
  assert.equal(code('{"cells":["a","b","c","d"]}', 3), 'wrong_length');
  assert.equal(code('{"cells":[1,2,3]}', 3), 'invalid_shape');
  assert.equal(code('{"x":[]}', 0), 'invalid_shape');
  assert.equal(code('not json', 3), 'invalid_json');
});
