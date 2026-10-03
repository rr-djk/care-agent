import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPageSchema } from '@care-agent/schema/node';
import type { FieldDef } from '@care-agent/schema';
import {
  analyzePage,
  analyzeZone,
  cellStatus,
  isApplicable,
  type AnalyzeDeps,
  type StatusInput,
} from './analyze';
import type { Cache } from './cache';
import type { PageImage } from './ink';
import { ModelError, type ModelFn, type ModelResponse } from './model';

const schema = loadPageSchema('pregnancy');
const HEADER = schema.zones[0].cells; // 10 cells: ddr, taille, 5 checkboxes, dpa, depassement, rh_plus
const TIMINGS = { prompt_tokens: 10, prefill_s: 1, output_tokens: 5, gen_s: 2 };

// Synthetic 400x600 page: one box per header cell, painted black when the cell is "inked".
const W = 400;
const H = 600;
const isCheckbox = (id: string) => schema.fields.find((f) => f.id === id)!.type === 'checkbox';
const cellBoxes: AnalyzeDeps['cellBoxes'] = new Map(
  HEADER.map((id, i) => [id, { kind: isCheckbox(id) ? 'checkbox' : 'text', bbox_frac: [0.1, 0.05 + i * 0.09, isCheckbox(id) ? 0.155 : 0.5, 0.05 + i * 0.09 + (isCheckbox(id) ? 22 : 40) / H] }] as const),
) as AnalyzeDeps['cellBoxes'];
// A text cell gets a small blob (a full-width stroke would be dropped as a grid line), a checkbox is filled.
const pageWith = (inked: string[]): PageImage => {
  const data = Buffer.alloc(W * H * 3, 255);
  for (const id of inked) {
    const [x0, y0, x1, y1] = cellBoxes.get(id)!.bbox_frac;
    const blob = !isCheckbox(id);
    const [cx, cy] = [Math.round(((x0 + x1) / 2) * W), Math.round(((y0 + y1) / 2) * H)];
    for (let y = blob ? cy - 5 : Math.round(y0 * H); y < (blob ? cy + 5 : Math.round(y1 * H)); y++) {
      data.fill(0, (y * W + (blob ? cx - 5 : Math.round(x0 * W))) * 3, (y * W + (blob ? cx + 5 : Math.round(x1 * W))) * 3);
    }
  }
  return { data, width: W, height: H };
};

const response = (content: string): ModelResponse => ({ content, logprobs: [], timings: TIMINGS });
const cellsOf = (...values: (string | null)[]) => response(JSON.stringify({ cells: values }));
const scripted = (...responses: (ModelResponse | Error)[]) => {
  const calls: string[] = [];
  const model: ModelFn = async (req) => {
    calls.push(req.prompt);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { model, calls };
};
const memoryCache = (): Cache => {
  const store = new Map<string, ModelResponse>();
  return { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) };
};
const deps = (model: ModelFn, extra: Partial<AnalyzeDeps> = {}): AnalyzeDeps => ({ model, modelName: 'test', cellBoxes, ...extra });
const byId = (cells: { field_id: string }[], id: string) => cells.find((c) => c.field_id === id)! as any;
const DDR_TAILLE = pageWith(['p03.ddr', 'p03.taille']);

test('only inked text cells are asked, listed one by one, answers mapped back by index', async () => {
  const page = pageWith(['p03.taille', 'p03.date_de_depassement_de_terme', 'p03.groupage_o']);
  const { model, calls } = scripted(cellsOf('152 cm', '03/12/2025'));
  const z = await analyzeZone(page, schema, 'p03.header', deps(model));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /exactly 2 values/);
  assert.ok(!calls[0].includes('DDR') && !calls[0].includes('Groupage'));
  assert.equal(byId(z.cells, 'p03.taille').value, 152);
  assert.equal(byId(z.cells, 'p03.date_de_depassement_de_terme').value, '03/12/2025');
  assert.equal(byId(z.cells, 'p03.ddr').status, 'NOT_PROVIDED'); // no ink: "" without asking
  assert.equal(byId(z.cells, 'p03.ddr').verbatim, '');
  assert.deepEqual(['p03.groupage_o', 'p03.groupage_a'].map((id) => [byId(z.cells, id).value, byId(z.cells, id).status]), [[true, 'KNOWN'], [false, 'KNOWN']]);
});

test('a zone without inked text cell skips the model, checkboxes still read from ink', async () => {
  const { model, calls } = scripted(cellsOf());
  const z = await analyzeZone(pageWith(['p03.groupage_o']), schema, 'p03.header', deps(model));
  assert.equal(calls.length, 0);
  assert.equal(z.skipped, true);
  assert.equal(byId(z.cells, 'p03.groupage_o').value, true);
  assert.equal(byId(z.cells, 'p03.taille').status, 'NOT_PROVIDED');
});

test('model "" on an inked cell is a disagreement: NEEDS_REVIEW', async () => {
  const { model } = scripted(cellsOf('', '152 cm'));
  const z = await analyzeZone(DDR_TAILLE, schema, 'p03.header', deps(model));
  assert.equal(byId(z.cells, 'p03.ddr').status, 'NEEDS_REVIEW');
  assert.equal(byId(z.cells, 'p03.ddr').agreement, 0);
  assert.equal(byId(z.cells, 'p03.taille').status, 'KNOWN');
  assert.equal(byId(z.cells, 'p03.taille').agreement, 1);
});

test('retries once on invalid JSON, then succeeds', async () => {
  const { model, calls } = scripted(response('not json'), cellsOf('07/04/2025', '152 cm'));
  const z = await analyzeZone(DDR_TAILLE, schema, 'p03.header', deps(model));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1]);
  assert.equal(byId(z.cells, 'p03.ddr').status, 'KNOWN');
  assert.equal(byId(z.cells, 'p03.ddr').value, '07/04/2025');
  assert.equal(z.timings.output_tokens, 10); // both attempts counted
});

test('retries on the wrong length; exhausted retry gives UNKNOWN text cells with a reason', async () => {
  const { model, calls } = scripted(cellsOf('a'));
  const z = await analyzeZone(pageWith(['p03.ddr', 'p03.taille', 'p03.groupage_o']), schema, 'p03.header', deps(model));
  assert.equal(calls.length, 2);
  assert.equal(z.cells.length, HEADER.length);
  for (const c of z.cells.filter((c) => !isCheckbox(c.field_id))) {
    assert.equal(c.status, 'UNKNOWN');
    assert.equal(c.value, null);
    assert.match(c.reason!, /expected 2 cells, got 1/);
  }
  assert.equal(byId(z.cells, 'p03.groupage_o').value, true); // ink reading does not depend on the model
});

test('an unreachable runtime is a typed error, not UNKNOWN cells', async () => {
  const { model } = scripted(new ModelError('unreachable', 'down'));
  await assert.rejects(analyzeZone(DDR_TAILLE, schema, 'p03.header', deps(model)), (e: ModelError) => e instanceof ModelError && e.kind === 'unreachable');
});

test('second run is served from the cache', async () => {
  const { model, calls } = scripted(cellsOf('07/04/2025', '152 cm'));
  const d = deps(model, { cache: memoryCache() });
  const first = await analyzeZone(DDR_TAILLE, schema, 'p03.header', d);
  const second = await analyzeZone(DDR_TAILLE, schema, 'p03.header', d);
  assert.equal(calls.length, 1);
  assert.deepEqual([first.cache_hit, second.cache_hit], [false, true]);
});

test('cross-field failure marks both fields NEEDS_REVIEW', async () => {
  // expected delivery date before the last period
  const { model } = scripted(cellsOf('07/04/2025', '01/01/2025'));
  const page = pageWith(['p03.ddr', 'p03.date_prevue_d_accouchement']);
  const r = await analyzePage(page, 'pregnancy', deps(model), { zones: ['p03.header'] });
  assert.equal(byId(r.cells, 'p03.ddr').status, 'NEEDS_REVIEW');
  assert.equal(byId(r.cells, 'p03.date_prevue_d_accouchement').status, 'NEEDS_REVIEW');
  const f = r.fields.find((x) => x.field_id === 'p03.ddr')!;
  assert.deepEqual(f.confidence_signals, { agreement: 1, validators_passed: true, quality: 1 });
});

const base: StatusInput = { verbatim: '12', empty: false, valid: true, hasInk: true };
test('status rules', () => {
  const rows: [string, Partial<StatusInput>, string][] = [
    ['null -> ILLEGIBLE', { verbatim: null, empty: true }, 'ILLEGIBLE'],
    ['empty, no ink -> NOT_PROVIDED', { verbatim: '', empty: true, hasInk: false }, 'NOT_PROVIDED'],
    ['empty, parent evaluable false -> NOT_APPLICABLE', { verbatim: '', empty: true, hasInk: false, applicable: false }, 'NOT_APPLICABLE'],
    ['empty, applicable -> NOT_PROVIDED', { verbatim: '', empty: true, hasInk: false, applicable: true }, 'NOT_PROVIDED'],
    ['validator failure', { valid: false }, 'NEEDS_REVIEW'],
    ['model empty, ink present', { verbatim: '', empty: true, hasInk: true }, 'NEEDS_REVIEW'],
    ['model non-empty, no ink', { hasInk: false }, 'NEEDS_REVIEW'],
    ['model and ink agree', {}, 'KNOWN'],
  ];
  for (const [name, input, expected] of rows) assert.equal(cellStatus({ ...base, ...input }), expected, name);
});

test('applicability "<field id> = <value>"', () => {
  const field = { applicability: 'p03.rh_minus = true' } as FieldDef;
  assert.equal(isApplicable(field, { 'p03.rh_minus': true }), true);
  assert.equal(isApplicable(field, { 'p03.rh_minus': false }), false);
  assert.equal(isApplicable(field, {}), undefined);
  assert.equal(isApplicable({ applicability: 'x = Césarienne' } as FieldDef, { x: 'césarienne' }), true);
  assert.equal(isApplicable({} as FieldDef, {}), undefined);
});

test('postpartum applicability: scar only after a caesarean, method only when one is wanted', () => {
  const fields = loadPageSchema('postpartum_mother').fields;
  const f = (id: string) => fields.find((x) => x.id === id)!;
  assert.equal(isApplicable(f('p05.etat_de_la_cicatrice_text'), { 'p05.cesarienne': false }), false);
  assert.equal(isApplicable(f('p05.etat_de_la_cicatrice_text'), { 'p05.cesarienne': true }), true);
  assert.equal(isApplicable(f('p05.autre_a_preciser'), { 'p05.desire_utiliser_une_methode': false }), false);
  assert.equal(isApplicable(f('p05.si_la_mere_ne_desire_pas_une_methode_contraceptive_pourquoi_text'), { 'p05.desire_utiliser_une_methode': false }), true);
  assert.equal(cellStatus({ verbatim: '', empty: true, valid: true, hasInk: false, applicable: false }), 'NOT_APPLICABLE');
});
