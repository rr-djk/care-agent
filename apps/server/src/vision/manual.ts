import type { ExtractedField, PageSchema } from '@care-agent/schema';
import { toExtractedField, type CellBox, type CellResult } from './analyze';
import { cellHasInk, checkboxInkRatio, inkRatio, type PageImage } from './ink';

/**
 * Ink-only reading, no model (AI unavailable or ANALYZER=ink): checkboxes from the ink (KNOWN true/false), text cells
 * without ink NOT_PROVIDED, text cells with ink UNKNOWN with reason "manual": the midwife types them.
 */
export function inkOnlyFields(page: PageImage, schema: PageSchema, cellBoxes: Map<string, CellBox>): ExtractedField[] {
  return schema.zones.flatMap((z) => z.cells).map((id) => {
    const box = cellBoxes.get(id);
    if (!box) throw new Error(`no cell box for ${id}`);
    const checkbox = schema.fields.find((f) => f.id === id)!.type === 'checkbox';
    const ink = (checkbox ? checkboxInkRatio : inkRatio)(page, box.bbox_frac);
    const inked = cellHasInk(ink, checkbox ? 'checkbox' : 'text', schema.layout);
    const base = { field_id: id, ink, failed_validators: [] };
    const cell: CellResult = checkbox
      ? { ...base, verbatim: null, status: 'KNOWN', value: inked }
      : inked
        ? { ...base, verbatim: null, status: 'UNKNOWN', value: null, reason: 'manual' }
        : { ...base, verbatim: '', status: 'NOT_PROVIDED', value: null };
    return { ...toExtractedField(cell, schema.page_types[0]), reason: cell.reason };
  });
}
