import { ZoneAnswer } from './zone';
import type { PageSchema } from './pageSchema';

// Prompt tokens are expensive on CPU (docs/runtime-notes.md): keep the text short and the answer compact.

export interface ZonePrompt {
  prompt: string;
  format: object; // JSON schema for the Ollama native `format` parameter
  cellIds: string[];
}

/**
 * `opts.cells` (ink-guided): ask only for these cells of the zone, listed one by one in zone order, so the model
 * cannot misplace values in a table; the answer then has exactly that many items.
 */
export function buildZonePrompt(schema: PageSchema, zoneId: string, opts: { cells?: string[] } = {}): ZonePrompt {
  const zone = schema.zones.find((z) => z.id === zoneId);
  if (!zone) throw new Error(`unknown zone "${zoneId}" in layout ${schema.layout}`);
  const asked = opts.cells ? zone.cells.filter((id) => opts.cells!.includes(id)) : zone.cells;
  if (opts.cells && asked.length !== new Set(opts.cells).size) throw new Error(`zone ${zoneId}: unknown cell in ${opts.cells.join(', ')}`);
  const fields = asked.map((id) => {
    const f = schema.fields.find((x) => x.id === id);
    if (!f) throw new Error(`zone ${zoneId}: cell "${id}" is not a field`);
    return f;
  });
  const n = asked.length;
  const head = `Crop of a French maternity record. Answer {"cells":[...]} with exactly ${n} values`;
  const cellLabel = (f: (typeof fields)[number]) => {
    if (!opts.cells || !zone.rows || !zone.columns) return `${f.label_fr}${f.type === 'checkbox' ? ' (checkbox)' : ''}`;
    const at = zone.cells.indexOf(f.id);
    return `${zone.rows[Math.floor(at / zone.columns.length)]} [${zone.columns[at % zone.columns.length]}]`;
  };
  const layout = zone.rows && zone.columns && !opts.cells
    ? `, row-major.\nTable rows: ${zone.rows.join('; ')}\nColumns: ${zone.columns.join('; ')}`
    : ` in this order:\n${fields.map((f, i) => `${i + 1}. ${cellLabel(f)}`).join('\n')}`;
  const checkbox = fields.some((f) => f.type === 'checkbox') ? ' Checkbox: "x" if ticked, else "".' : '';
  const rules = `Copy handwriting verbatim. "" = empty, null only if there is writing you cannot read at all. Never invent a value.${checkbox} Ignore names, ID numbers, phone numbers, addresses.`;

  return {
    prompt: `${head}${layout}\n${rules}`,
    format: {
      type: 'object',
      properties: {
        cells: { type: 'array', minItems: n, maxItems: n, items: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      },
      required: ['cells'],
    },
    cellIds: asked,
  };
}

export type ZoneAnswerError = { code: 'invalid_json' | 'invalid_shape' | 'wrong_length'; text: string };

/** Parses the model output of one zone into cellId -> verbatim ("" empty, null illegible). */
export function parseZoneAnswer(
  raw: string,
  cellIds: string[],
): { ok: true; cells: Map<string, string | null> } | { ok: false; error: ZoneAnswerError } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: 'invalid_json', text: 'model output is not valid JSON' } };
  }
  const parsed = ZoneAnswer.safeParse(json);
  if (!parsed.success) return { ok: false, error: { code: 'invalid_shape', text: parsed.error.message } };
  const { cells } = parsed.data;
  if (cells.length !== cellIds.length) {
    return { ok: false, error: { code: 'wrong_length', text: `expected ${cellIds.length} cells, got ${cells.length}` } };
  }
  return { ok: true, cells: new Map(cellIds.map((id, i) => [id, cells[i]])) };
}
