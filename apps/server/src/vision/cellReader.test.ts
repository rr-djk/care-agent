import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildZonePrompt, PAGE_LAYOUTS, REAL_LAYOUTS } from '@care-agent/schema';
import { loadPageSchema } from '@care-agent/schema/node';
import { pipelineHash } from '../calibration';
import { loadCellBoxes } from '../cli/pages';
import { reviewItem } from '../review';
import { analyzeZone, toExtractedField, type AnalyzeDeps } from './analyze';
import { readerMode, READER_THRESHOLD, type CellReader } from './cellReader';
import { PAD_PX } from './crop';
import { INK_PARAMS, type PageImage } from './ink';
import { modelConfig, ModelError, type ModelFn } from './model';

const schema = loadPageSchema('pregnancy');
const HEADER = schema.zones[0].cells; // ddr, taille, 5 checkboxes, dpa, depassement, rh_plus
const W = 400;
const H = 600;
const isCheckbox = (id: string) => schema.fields.find((f) => f.id === id)!.type === 'checkbox';
const cellBoxes: AnalyzeDeps['cellBoxes'] = new Map(
  HEADER.map((id, i) => [id, { kind: isCheckbox(id) ? 'checkbox' : 'text', bbox_frac: [0.1, 0.05 + i * 0.09, isCheckbox(id) ? 0.155 : 0.5, 0.05 + i * 0.09 + (isCheckbox(id) ? 22 : 40) / H] }] as const),
) as AnalyzeDeps['cellBoxes'];
/** White page; each listed text cell gets a 10x10 blob of `rgb` in its centre (ink for the detector). */
function pageWith(inked: string[], rgb: [number, number, number] = [0, 0, 0]): PageImage {
  const data = Buffer.alloc(W * H * 3, 255);
  for (const id of inked) {
    const [x0, y0, x1, y1] = cellBoxes.get(id)!.bbox_frac;
    const [cx, cy] = [Math.round(((x0 + x1) / 2) * W), Math.round(((y0 + y1) / 2) * H)];
    for (let y = cy - 5; y < cy + 5; y++) for (let x = cx - 5; x < cx + 5; x++) data.set(rgb, (y * W + x) * 3);
  }
  return { data, width: W, height: H };
}
/** Scripted reader: text and score per field id; keeps every crop it was given. */
function fakeReader(readings: Record<string, { text: string; score: number }>) {
  const crops: { id: string; crop: PageImage }[] = [];
  const reader: CellReader = {
    async read(crop, field) {
      crops.push({ id: field.id, crop });
      return readings[field.id] ?? { text: '', score: 0 };
    },
  };
  return { reader, crops };
}
const noModel: ModelFn = async () => {
  throw new Error('the model must not be called');
};
const byId = (cells: { field_id: string }[], id: string) => cells.find((c) => c.field_id === id)! as any;

test('READER: gemma by default, cell and hybrid on request, a typo is an error', () => {
  assert.equal(readerMode(undefined), 'gemma');
  assert.equal(readerMode(''), 'gemma');
  assert.equal(readerMode('gemma'), 'gemma');
  assert.equal(readerMode('cell'), 'cell');
  assert.equal(readerMode('hybrid'), 'hybrid');
  assert.throws(() => readerMode('paddle'), /READER must be/);
});

test('pipeline hash: READER unset or gemma = the formula before the cell reader; cell and hybrid change it', () => {
  // the hash as it was computed before this experiment (calibration.ts on main)
  const legacy = () => {
    const h = createHash('sha256');
    h.update(JSON.stringify({ model: modelConfig().model, ink: INK_PARAMS, crop_pad_px: PAD_PX }));
    for (const layout of [...PAGE_LAYOUTS, ...REAL_LAYOUTS]) {
      const s = loadPageSchema(layout);
      h.update(JSON.stringify(s));
      h.update(JSON.stringify([...loadCellBoxes(layout)]));
      for (const z of s.zones) h.update(buildZonePrompt(s, z.id, { cells: z.cells }).prompt);
    }
    return h.digest('hex');
  };
  const saved = { READER: process.env.READER, MODELS_DIR: process.env.MODELS_DIR };
  try {
    delete process.env.READER;
    assert.equal(pipelineHash(), legacy());
    process.env.READER = 'gemma';
    assert.equal(pipelineHash(), legacy());
    // a stand-in model file: the hash covers its bytes, not its meaning
    const dir = mkdtempSync(join(tmpdir(), 'cell-reader-'));
    process.env.MODELS_DIR = dir;
    const modelDir = join(dir, 'PaddlePaddle', 'latin_PP-OCRv5_mobile_rec_onnx');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'inference.onnx'), 'model bytes');
    process.env.READER = 'cell';
    const cell = pipelineHash();
    process.env.READER = 'hybrid';
    const hybrid = pipelineHash();
    assert.notEqual(cell, legacy());
    assert.notEqual(hybrid, legacy());
    assert.notEqual(cell, hybrid);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('READER=cell: no model call; a KNOWN reading under the threshold goes to review with its reason', async () => {
  const { reader } = fakeReader({ 'p03.ddr': { text: '12/05/2025', score: 0.99 }, 'p03.taille': { text: '152 cm', score: READER_THRESHOLD - 0.1 } });
  const zone = await analyzeZone(pageWith(['p03.ddr', 'p03.taille']), schema, schema.zones[0].id, { model: noModel, modelName: 't', cellBoxes, cellReader: reader, readerMode: 'cell' });
  assert.equal(byId(zone.cells, 'p03.ddr').status, 'KNOWN');
  assert.equal(byId(zone.cells, 'p03.ddr').value, '12/05/2025');
  assert.equal(byId(zone.cells, 'p03.taille').status, 'NEEDS_REVIEW');
  assert.equal(byId(zone.cells, 'p03.taille').review_reason, 'low_reader_confidence');
  assert.equal(zone.timings.prefill_s, 0);
  // stored on the field: the score as a signal, the reason, and a French doubt that shows no percentage
  const stored = toExtractedField(byId(zone.cells, 'p03.taille'), 3);
  assert.equal(stored.reason, 'low_reader_confidence');
  assert.equal(stored.confidence_signals.reader_score, READER_THRESHOLD - 0.1);
  const item = reviewItem('pg', stored, 'Taille');
  assert.equal(item.reason_code, 'low_reader_confidence');
  assert.equal(item.kind, 'doubt');
  assert.match(item.text_fr, /pas sûr de ma lecture/);
  assert.doesNotMatch(item.text_fr, /%/);
  // a field read with a high score carries no reason
  assert.equal(toExtractedField(byId(zone.cells, 'p03.ddr'), 3).reason, undefined);
});

test('READER=cell: "" on an inked cell is NEEDS_REVIEW (ink but empty), not a reader doubt', async () => {
  const { reader } = fakeReader({ 'p03.ddr': { text: '', score: 1 } });
  const zone = await analyzeZone(pageWith(['p03.ddr']), schema, schema.zones[0].id, { model: noModel, modelName: 't', cellBoxes, cellReader: reader, readerMode: 'cell' });
  const ddr = byId(zone.cells, 'p03.ddr');
  assert.equal(ddr.status, 'NEEDS_REVIEW');
  assert.equal(ddr.agreement, 0);
  assert.equal(ddr.review_reason, undefined);
});

test('READER=cell: cells are cut from the masked page (no pixel under a mask reaches the reader)', async () => {
  // the DDR cell lies under an identifier mask and holds red "writing": the reader must never see red
  const masked = { ...schema, masks: [...schema.masks, cellBoxes.get('p03.ddr')!.bbox_frac] };
  const { reader, crops } = fakeReader({ 'p03.ddr': { text: 'x', score: 1 }, 'p03.taille': { text: '152 cm', score: 1 } });
  await analyzeZone(pageWith(['p03.ddr', 'p03.taille'], [255, 0, 0]), masked, schema.zones[0].id, { model: noModel, modelName: 't', cellBoxes, cellReader: reader, readerMode: 'cell' });
  assert.ok(crops.some((c) => c.id === 'p03.ddr'), 'the inked cell was read');
  for (const { crop } of crops.filter((c) => c.id === 'p03.ddr')) {
    for (let i = 0; i < crop.width * crop.height; i++) assert.ok(!(crop.data[3 * i] === 255 && crop.data[3 * i + 1] === 0 && crop.data[3 * i + 2] === 0), 'a masked pixel reached the reader');
  }
  // the unmasked cell keeps its ink: masking is per rectangle, not per page
  assert.ok(crops.find((c) => c.id === 'p03.taille')!.crop.data.some((v, i) => i % 3 === 1 && v === 0));
});

test('READER=hybrid: the model is asked only about doubtful cells; agree -> KNOWN, disagree -> review, model down -> review', async () => {
  const readings = { 'p03.ddr': { text: '12/05/2025', score: 0.99 }, 'p03.taille': { text: '152 cm', score: 0.5 }, 'p03.date_prevue_d_accouchement': { text: '16/02/2026', score: 0.5 } };
  const page = pageWith(['p03.ddr', 'p03.taille', 'p03.date_prevue_d_accouchement']);
  const prompts: string[] = [];
  const model: ModelFn = async (req) => {
    prompts.push(req.prompt);
    return { content: JSON.stringify({ cells: ['152 Cm', '19/02/2026'] }), logprobs: [], timings: { prompt_tokens: 1, prefill_s: 1, output_tokens: 1, gen_s: 1 } };
  };
  const zone = await analyzeZone(page, schema, schema.zones[0].id, { model, modelName: 't', cellBoxes, cellReader: fakeReader(readings).reader, readerMode: 'hybrid' });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /exactly 2 values/); // taille and dpa only, not the confident DDR
  assert.equal(byId(zone.cells, 'p03.ddr').status, 'KNOWN');
  assert.equal(byId(zone.cells, 'p03.taille').status, 'KNOWN'); // "152 Cm" = "152 cm"
  assert.equal(byId(zone.cells, 'p03.date_prevue_d_accouchement').status, 'NEEDS_REVIEW');
  assert.equal(byId(zone.cells, 'p03.date_prevue_d_accouchement').value, '16/02/2026'); // the reader's value, to be checked

  const down: ModelFn = async () => {
    throw new ModelError('unreachable', 'down');
  };
  const offline = await analyzeZone(page, schema, schema.zones[0].id, { model: down, modelName: 't', cellBoxes, cellReader: fakeReader(readings).reader, readerMode: 'hybrid' });
  assert.equal(byId(offline.cells, 'p03.ddr').status, 'KNOWN');
  assert.equal(byId(offline.cells, 'p03.taille').status, 'NEEDS_REVIEW');
  assert.equal(byId(offline.cells, 'p03.taille').review_reason, 'low_reader_confidence');
});

test('a written dash is NOT_PROVIDED, unless the reader doubts it (a faint "1" read as "—")', async () => {
  const run = (score: number) =>
    analyzeZone(pageWith(['p03.ddr']), schema, schema.zones[0].id, { model: noModel, modelName: 't', cellBoxes, cellReader: fakeReader({ 'p03.ddr': { text: '—', score } }).reader, readerMode: 'cell' });
  const sure = byId((await run(0.99)).cells, 'p03.ddr');
  assert.equal(sure.status, 'NOT_PROVIDED');
  assert.equal(sure.verbatim, '—');
  assert.equal(sure.value, null);
  const doubt = byId((await run(0.3)).cells, 'p03.ddr');
  assert.equal(doubt.status, 'NEEDS_REVIEW');
  assert.equal(doubt.review_reason, 'low_reader_confidence');
});

test('READER=gemma: a dash read by the model is NOT_PROVIDED too', async () => {
  const model: ModelFn = async () => ({ content: JSON.stringify({ cells: ['—'] }), logprobs: [], timings: { prompt_tokens: 1, prefill_s: 1, output_tokens: 1, gen_s: 1 } });
  const zone = await analyzeZone(pageWith(['p03.ddr']), schema, schema.zones[0].id, { model, modelName: 't', cellBoxes });
  assert.equal(byId(zone.cells, 'p03.ddr').status, 'NOT_PROVIDED');
});
