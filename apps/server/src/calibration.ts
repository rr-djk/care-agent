// Per-category confidence calibration (step 13, docs/calibration.md). The table is fitted offline by
// tools/eval/calibrate.mjs on the CALIBRATE split; the server only loads it, checks it belongs to this pipeline, and applies it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { buildZonePrompt, PAGE_LAYOUTS, REAL_LAYOUTS, type ExtractedField, type PageSchema } from '@care-agent/schema';
import { loadPageSchema } from '@care-agent/schema/node';
import { loadCellBoxes } from './cli/pages';
import { LOW_CATEGORY_CONFIDENCE } from './review';
import { readerIdentity } from './vision/cellReader';
import { PAD_PX } from './vision/crop';
import { INK_PARAMS } from './vision/ink';
import { modelConfig } from './vision/model';

/** Quality factor of a page the midwife kept despite a gate WARNING (the LOW_QUALITY flag); an OK page is 1. */
export const LOW_QUALITY_FACTOR = 0.5;
export const qualityFactor = (outcome: 'OK' | 'WARNING' | 'REJECT') => (outcome === 'OK' ? 1 : LOW_QUALITY_FACTOR);

/**
 * Identity of everything that decides what a reading looks like: model tag, the zone prompts as the model gets them (template
 * text + labels), the page schemas (zones, fields, masks), the cell boxes, the ink thresholds and the crop padding.
 * The table stores it; any change of one of these invalidates the table. Used by the server AND tools/eval/calibrate.mjs.
 */
export function pipelineHash(): string {
  const h = createHash('sha256');
  h.update(JSON.stringify({ model: modelConfig().model, ink: INK_PARAMS, crop_pad_px: PAD_PX }));
  for (const layout of [...PAGE_LAYOUTS, ...REAL_LAYOUTS]) {
    const schema = loadPageSchema(layout);
    h.update(JSON.stringify(schema));
    h.update(JSON.stringify([...loadCellBoxes(layout)]));
    for (const z of schema.zones) h.update(buildZonePrompt(schema, z.id, { cells: z.cells }).prompt);
  }
  // READER=cell|hybrid: the reader, its model file, threshold and crop; nothing for READER=gemma (hash unchanged)
  const reader = readerIdentity();
  if (reader) h.update(JSON.stringify({ reader }));
  return h.digest('hex');
}

const Interval = { low: z.number().nullable(), high: z.number().nullable() };
export const CategoryEntry = z.object({
  // KNOWN fields of the reference bin (best quality, merged until n >= min_n): what the server uses. null = not enough examples.
  n: z.number().int(),
  correct: z.number().int(),
  accuracy: z.number().nullable(),
  ...Interval,
  demote: z.boolean(), // lower Wilson bound below the target: KNOWN fields of this category go to review
  bins: z.array(z.object({ quality_min: z.number(), quality_max: z.number(), n: z.number().int(), correct: z.number().int(), accuracy: z.number().nullable(), ...Interval })),
  doubt: z.object({ wrong: z.number().int(), flagged: z.number().int(), recall: z.number().nullable(), ...Interval }), // diagnostics only
});
export type CategoryEntry = z.infer<typeof CategoryEntry>;

export const CalibrationTable = z.object({
  pipeline_hash: z.string(),
  created_at: z.string(),
  target: z.number(),
  min_n: z.number().int(),
  categories: z.record(z.string(), CategoryEntry),
});
export type CalibrationTable = z.infer<typeof CalibrationTable>;

/**
 * The table at `file`, or undefined: missing file (not calibrated yet), unreadable file, or a table fitted on another
 * pipeline (refused and ignored, with a log line: the numbers would not describe these readings).
 */
export function loadCalibration(file: string, hash = pipelineHash(), log: (msg: string) => void = console.warn): CalibrationTable | undefined {
  if (!existsSync(file)) {
    log(`calibration: no table at ${file}: fields are not calibrated (make calibrate)`);
    return undefined;
  }
  const parsed = CalibrationTable.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    log(`calibration: table at ${file} is unreadable and ignored`);
    return undefined;
  }
  if (parsed.data.pipeline_hash !== hash) {
    log(`calibration: table ignored, pipeline_hash ${parsed.data.pipeline_hash.slice(0, 12)} != current ${hash.slice(0, 12)} (model, prompt, zones or ink thresholds changed: rerun make calibrate)`);
    return undefined;
  }
  return parsed.data;
}

/**
 * Fills `calibrated` (category accuracy x quality factor) and its interval on KNOWN fields, and demotes them to
 * NEEDS_REVIEW (`low_category_confidence`) when their category's lower bound is under the target. Categories without
 * enough examples are left alone (no evidence either way).
 */
export function applyCalibration(table: CalibrationTable | undefined, schema: PageSchema, fields: ExtractedField[]): ExtractedField[] {
  if (!table) return fields;
  const category = new Map(schema.fields.map((d) => [d.id, d.category]));
  return fields.map((f) => {
    const c = f.status === 'KNOWN' ? table.categories[category.get(f.field_id) ?? ''] : undefined;
    if (!c || c.accuracy === null || c.low === null || c.high === null) return f;
    const q = f.confidence_signals.quality;
    const calibrated = { calibrated: c.accuracy * q, calibration: { low: c.low * q, high: c.high * q, n: c.n } };
    return c.demote ? { ...f, ...calibrated, status: 'NEEDS_REVIEW', reason: LOW_CATEGORY_CONFIDENCE } : { ...f, ...calibrated };
  });
}
