// Reading predictions-<ts>.jsonl (written by `make predict`, one record per page / variant / real photo) and turning them
// into rows of "field, truth, correct?" for calibrate, quality-curve and report.
import { readFile } from 'node:fs/promises';
import { isCorrect } from './run.mjs';
import { FLAGGED } from './stats.mjs';

export async function readRecords(files) {
  const records = [];
  for (const file of [files].flat()) {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) if (line.trim()) records.push(JSON.parse(line));
  }
  return records;
}

/** What `make eval` compares: the checkbox boolean, else the verbatim reading ('' when none). */
export const predictedValue = (f) => (typeof f.value === 'boolean' ? f.value : (f.verbatim ?? ''));

/** {page_no: {field_id: value}} of the clean pages (variants and photos are not part of the plain evaluation). */
export function toValues(records) {
  const out = {};
  for (const r of records) if (r.variant === 'clean') out[r.page_no] = Object.fromEntries(r.fields.map((f) => [f.field_id, predictedValue(f)]));
  return out;
}

/** The slot of the record in the ground truth (pages) or in the hand labels (real photos; '?' labels are skipped). */
function slotsOf(record, gt, realLabels) {
  if (record.photo) return realLabels?.photos?.[`${record.photo}.jpg`]?.fields.filter((s) => s.value !== '?' && s.value !== null).map((s) => ({ key: s.key, kind: s.kind, value: s.value })) ?? [];
  return gt[record.page_no]?.slots ?? [];
}

/**
 * One row per field of every record: `{record, field, slot, ok, empty, flagged, category, quality}`. `empty` = the truth is
 * blank (a non-empty cell is the interesting accuracy). A field the record does not hold counts as an empty reading.
 */
export function fieldRows(records, gt, realLabels) {
  const rows = [];
  for (const record of records) {
    const byId = new Map(record.fields.map((f) => [f.field_id, f]));
    for (const slot of slotsOf(record, gt, realLabels)) {
      const field = byId.get(slot.key);
      if (!field) continue;
      rows.push({
        record,
        field,
        slot,
        ok: isCorrect(slot, predictedValue(field)),
        empty: slot.value === '' || slot.value === false,
        flagged: FLAGGED.includes(field.status),
        category: field.category,
        quality: field.signals.quality,
      });
    }
  }
  return rows;
}
