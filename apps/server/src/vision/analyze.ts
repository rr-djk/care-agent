import {
  buildZonePrompt,
  normalizeValue,
  parseZoneAnswer,
  validateField,
  validatePage,
  type BBoxFrac,
  type ExtractedField,
  type FieldDef,
  type Normalized,
  type PageLayout,
  type PageSchema,
  type Status,
} from '@care-agent/schema';
import { loadPageSchema } from '@care-agent/schema/node';
import { cacheKey, type Cache } from './cache';
import { cropZone } from './crop';
import { cellHasInk, checkboxInkRatio, inkRatio, type PageImage } from './ink';
import type { ModelFn, ModelTimings } from './model';
import { SequentialQueue } from './queue';

export interface CellBox {
  kind: 'text' | 'checkbox';
  bbox_frac: BBoxFrac;
}

export interface AnalyzeDeps {
  model: ModelFn;
  modelName: string; // part of the cache key
  cache?: Cache;
  cellBoxes: Map<string, CellBox>;
  // Debug hook (CLI --save-crops): exactly what the model saw and answered, cache hits included.
  onModelCall?: (call: { zone_id: string; prompt: string; crop: Buffer; content: string }) => void | Promise<void>;
}

export interface CellResult {
  field_id: string;
  verbatim: string | null; // null = the model found it illegible
  ink?: number; // ink ratio inside the cell
  agreement?: number; // 1 when the model and the ink agree on emptiness, else 0; undefined without ink reading
  status: Status;
  value: Normalized;
  failed_validators: string[];
  checkbox?: { model: boolean; ink?: boolean }; // both readings; the final value is the ink one when available
  reason?: string; // set when the status is UNKNOWN
}

export interface ZoneResult {
  zone_id: string;
  cells: CellResult[];
  skipped: boolean; // no text cell with ink: the model was not called
  cache_hit: boolean;
  crop_id?: string; // cache key of the model call
  timings: ModelTimings; // summed over attempts; zeros when skipped
  wall_s: number;
}

// --- status ------------------------------------------------------------------------------------------------------

export interface StatusInput {
  verbatim: string | null;
  empty: boolean; // the reading is empty (nothing written)
  valid: boolean; // normalization and validators passed
  hasInk: boolean;
  applicable?: boolean; // undefined: not evaluable on this page
}

/** Text cells only: checkboxes are never read by the model (their value is the ink reading, status KNOWN). */
export function cellStatus(i: StatusInput): Status {
  if (i.verbatim === null) return 'ILLEGIBLE';
  if (i.hasInk === i.empty) return 'NEEDS_REVIEW'; // ink and model disagree on emptiness
  if (i.empty) return i.applicable === false ? 'NOT_APPLICABLE' : 'NOT_PROVIDED';
  return i.valid ? 'KNOWN' : 'NEEDS_REVIEW';
}

/** "<field id> = <value>" against the values read so far; undefined when the parent has no value yet. */
export function isApplicable(field: FieldDef, values: Record<string, Normalized>): boolean | undefined {
  const m = field.applicability ? /^(.+?) = (.+)$/.exec(field.applicability) : null;
  if (!m || values[m[1]] == null) return undefined;
  return String(values[m[1]]).toLowerCase() === m[2].toLowerCase();
}

/** Normalization keeps a reading that does not fit the field type as a string: that is a failure too. */
function fitsType(field: FieldDef, v: Normalized): boolean {
  if (v === null) return true;
  if (field.type === 'number') return typeof v === 'number';
  if (field.type === 'date') return typeof v === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(v);
  if (field.type === 'enum') return field.allowed_values?.includes(String(v)) ?? true;
  return true;
}

// --- zone ---------------------------------------------------------------------------------------------------------

const ZERO: ModelTimings = { prompt_tokens: 0, prefill_s: 0, output_tokens: 0, gen_s: 0 };
const addTimings = (a: ModelTimings, b: ModelTimings): ModelTimings => ({
  prompt_tokens: a.prompt_tokens + b.prompt_tokens,
  prefill_s: a.prefill_s + b.prefill_s,
  output_tokens: a.output_tokens + b.output_tokens,
  gen_s: a.gen_s + b.gen_s,
});

/**
 * Reads one zone. `known` = normalized values of the fields read so far on the page (for applicability).
 * Ink first: checkboxes are never sent to the model (value = ink reading, which matched the ground truth on every
 * ticked and empty box, see `npm run ink-eval`); text cells without ink are "" without asking; only inked text cells go
 * to the model, listed one by one (ink-guided prompt) and mapped back by index.
 * Model errors (unreachable, http, timeout) propagate as ModelError; an unusable answer after one retry gives UNKNOWN cells.
 */
export async function analyzeZone(
  page: PageImage,
  schema: PageSchema,
  zoneId: string,
  deps: AnalyzeDeps,
  known: Record<string, Normalized> = {},
): Promise<ZoneResult> {
  const t0 = Date.now();
  const zone = schema.zones.find((z) => z.id === zoneId);
  if (!zone) throw new Error(`unknown zone "${zoneId}" in layout ${schema.layout}`);
  const fields = zone.cells.map((id) => schema.fields.find((f) => f.id === id)!);
  const ink = new Map<string, number>();
  for (const f of fields) {
    const box = deps.cellBoxes.get(f.id);
    if (!box) throw new Error(`no cell box for ${f.id}`);
    ink.set(f.id, (f.type === 'checkbox' ? checkboxInkRatio : inkRatio)(page, box.bbox_frac));
  }
  const hasInk = (f: FieldDef) => cellHasInk(ink.get(f.id)!, f.type === 'checkbox' ? 'checkbox' : 'text', schema.layout);
  const asked = fields.filter((f) => f.type !== 'checkbox' && hasInk(f)).map((f) => f.id);

  let answer = new Map<string, string | null>();
  let timings = ZERO;
  let cacheHit = false;
  let cropId: string | undefined;
  let failure: string | undefined;

  if (asked.length) {
    const { prompt, format, cellIds } = buildZonePrompt(schema, zoneId, { cells: asked });
    const crop = await cropZone(page, zone, schema.masks);
    // temperature 0 would repeat the same bad answer: the retry asks differently (and gets its own cache key)
    const prompts = [prompt, `${prompt}\nReply with valid JSON only: exactly ${cellIds.length} cells.`];
    failure = 'no attempt';
    for (const p of prompts) {
      const key = cacheKey(crop, p, format, deps.modelName);
      const cached = await deps.cache?.get(key);
      const response = cached ?? (await deps.model({ prompt: p, image: crop, format }));
      await deps.onModelCall?.({ zone_id: zoneId, prompt: p, crop, content: response.content });
      timings = addTimings(timings, response.timings);
      const parsed = parseZoneAnswer(response.content, cellIds);
      if (!parsed.ok) {
        failure = parsed.error.text;
        continue;
      }
      if (!cached) await deps.cache?.set(key, response);
      failure = undefined;
      cacheHit = !!cached;
      cropId = key;
      answer = parsed.cells;
      break;
    }
  }

  const cells: CellResult[] = [];
  if (failure) {
    for (const f of fields) {
      const base = { field_id: f.id, ink: ink.get(f.id), failed_validators: [] };
      // checkboxes do not depend on the model; the other cells (asked or not) are unknown when the zone failed
      cells.push(f.type === 'checkbox' ? { ...base, verbatim: null, status: 'KNOWN', value: hasInk(f) } : { ...base, verbatim: null, status: 'UNKNOWN', value: null, reason: failure });
    }
  } else {
    // pass 1: readings and validation; pass 2: statuses (applicability may depend on a cell of this zone)
    const read = fields.map((f) => {
      const checkbox = f.type === 'checkbox';
      const verbatim = checkbox ? null : answer.get(f.id) ?? '';
      const value = checkbox ? hasInk(f) : normalizeValue(f, verbatim);
      const failed = validateField(f, value);
      if (!failed.length && !fitsType(f, value)) failed.push(`type:${f.type}`);
      return { f, checkbox, verbatim, value, failed };
    });
    const values = { ...known };
    for (const r of read) if (r.value !== null && !r.failed.length) values[r.f.id] = r.value;
    for (const r of read) {
      const common = { field_id: r.f.id, ink: ink.get(r.f.id), value: r.value, failed_validators: r.failed };
      if (r.checkbox) {
        cells.push({ ...common, verbatim: null, status: 'KNOWN' });
        continue;
      }
      const empty = r.value === null;
      cells.push({
        ...common,
        verbatim: r.verbatim,
        agreement: +(hasInk(r.f) === !empty),
        status: cellStatus({ verbatim: r.verbatim, empty, valid: !r.failed.length, hasInk: hasInk(r.f), applicable: isApplicable(r.f, values) }),
      });
    }
  }
  return { zone_id: zoneId, cells, skipped: asked.length === 0, cache_hit: cacheHit, crop_id: cropId, timings, wall_s: (Date.now() - t0) / 1000 };
}

// --- page ---------------------------------------------------------------------------------------------------------

export interface PageAnalysis {
  layout: PageLayout;
  fields: ExtractedField[];
  cells: CellResult[];
  zones: Omit<ZoneResult, 'cells'>[];
}

const queue = new SequentialQueue(); // one model call at a time, across pages too

function toExtractedField(c: CellResult, sourcePage: number, evidence?: string): ExtractedField {
  return {
    field_id: c.field_id,
    value: typeof c.value === 'number' ? String(c.value) : c.value,
    verbatim: c.verbatim,
    status: c.status,
    confidence_signals: {
      agreement: c.agreement,
      validators_passed: !c.failed_validators.length,
      quality: 1, // specimens are clean scans
    },
    source_page: sourcePage,
    evidence,
  };
}

export async function analyzePage(
  page: PageImage,
  layout: PageLayout,
  deps: AnalyzeDeps,
  opts: { zones?: string[]; onProgress?: (zone: ZoneResult, done: number, total: number) => void } = {},
): Promise<PageAnalysis> {
  const schema = loadPageSchema(layout);
  const ids = opts.zones ?? schema.zones.map((z) => z.id);
  let known: Record<string, Normalized> = {};
  const results: ZoneResult[] = [];
  for (const id of ids) {
    const zone = await queue.run(() => analyzeZone(page, schema, id, deps, known));
    for (const c of zone.cells) if (c.value !== null && !c.failed_validators.length) known = { ...known, [c.field_id]: c.value };
    results.push(zone);
    opts.onProgress?.(zone, results.length, ids.length);
  }
  const cells = results.flatMap((z) => z.cells);
  const bad = new Set(validatePage(schema, known).flatMap((r) => r.field_ids));
  for (const c of cells) if (bad.has(c.field_id) && c.status === 'KNOWN') c.status = 'NEEDS_REVIEW';
  return {
    layout,
    cells,
    fields: results.flatMap((z) => z.cells.map((c) => toExtractedField(c, schema.page_types[0], z.crop_id))),
    zones: results.map(({ cells: _cells, ...z }) => z),
  };
}
