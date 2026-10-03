import type { FieldDef } from './field';
import type { PageSchema } from './pageSchema';

export type Normalized = string | number | boolean | null;

// --- normalizers -------------------------------------------------------------------------------------------

const fold = (s: string) => s.normalize('NFD').toLowerCase().replace(/œ/g, 'oe').replace(/\p{M}/gu, '').replace(/\s+/g, '');
// Some handwriting fonts have no "é": the image shows "Coll ge". Same fallback as tools/eval/run.mjs.
const dropAccented = (s: string) => s.toLowerCase().replace(/[^\x00-\x7f]/g, '').replace(/\s+/g, '');

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Verbatim reading -> typed value. null = nothing readable/written (empty, illegible, dash).
 * A reading that does not fit the field type is returned as the trimmed string, so a validator can reject it.
 */
export function normalizeValue(field: FieldDef, verbatim: string | null): Normalized {
  if (field.type === 'checkbox') return !!verbatim?.trim();
  const v = (verbatim ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  if (/^[-–—]*$/.test(v)) return null; // "" or a dash: nothing written

  switch (field.type) {
    case 'date': {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(v);
      if (!m) return v;
      return `${pad(+m[1])}/${pad(+m[2])}/${m[3].length === 2 ? `20${m[3]}` : m[3]}`;
    }
    case 'number': {
      const m = /^(\d+(?:[.,]\d+)?)\s*(\D*)$/.exec(v);
      // handwriting often lacks the degree sign: "37.1 C" is "37.1 °C"
      const bare = (u?: string) => u?.trim().toLowerCase().replace('°', '');
      const unit = bare(m?.[2]);
      if (!m || (unit && unit !== bare(field.unit))) return v;
      return Number(m[1].replace(',', '.'));
    }
    case 'enum': {
      const hit = field.allowed_values?.find((a) => fold(a) === fold(v) || dropAccented(a) === dropAccented(v));
      return hit ?? v;
    }
    default:
      return field.validators.includes('bp') ? v.replace(/\s*\/\s*/, '/') : v;
  }
}

// --- validators --------------------------------------------------------------------------------------------

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** dd/mm/yyyy -> UTC day number; null if not a real calendar date in 1990..2030. */
function dayNumber(v: unknown): number | null {
  const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
  if (!m) return null;
  const [d, mo, y] = [+m[1], +m[2], +m[3]];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (y < 1990 || y > 2030 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86_400_000;
}

function validBp(v: unknown): boolean {
  const m = typeof v === 'string' ? /^(\d{2,3})\/(\d{2,3})$/.exec(v) : null;
  if (!m) return false;
  const [sys, dia] = [+m[1], +m[2]];
  return sys >= 70 && sys <= 250 && dia >= 40 && dia <= 150 && dia < sys;
}

/** Validator ids: `range:<min>:<max>`, `bp`, `date`. An unknown id throws (a typo must not pass silently). */
function check(id: string, v: Normalized): boolean {
  const range = /^range:(-?[\d.]+):(-?[\d.]+)$/.exec(id);
  if (range) return typeof v === 'number' && v >= +range[1] && v <= +range[2];
  if (id === 'bp') return validBp(v);
  if (id === 'date') return dayNumber(v) !== null;
  throw new Error(`unknown validator "${id}"`);
}

/** Ids of the field's validators that fail on `normalized`. An empty value (null) has nothing to validate. */
export function validateField(field: FieldDef, normalized: Normalized): string[] {
  if (normalized === null) return [];
  return field.validators.filter((id) => !check(id, normalized));
}

// Cross-field rules by field id. A rule is skipped unless all its fields have a value.
// "soft:" rules can be legitimately broken (twins: more living children than births).
type Rule = { rule: string; ids: string[]; ok: (v: unknown[]) => boolean };
const num = (v: unknown): v is number => typeof v === 'number';
const days = (a: unknown, b: unknown) => (dayNumber(b) ?? NaN) - (dayNumber(a) ?? NaN); // b - a
const RULES: Rule[] = [
  { rule: 'gestation>=parite', ids: ['p02.gestation', 'p02.parite'], ok: ([g, p]) => !num(g) || !num(p) || g >= p },
  {
    rule: 'soft:parite>=enfants_vivants',
    ids: ['p02.parite', 'p02.nombre_d_enfants_vivants'],
    ok: ([p, l]) => !num(p) || !num(l) || p >= l,
  },
  { rule: 'ddr<dpa', ids: ['p03.ddr', 'p03.date_prevue_d_accouchement'], ok: ([a, b]) => !(days(a, b) <= 0) },
  {
    rule: 'dpa-ddr:266-294',
    ids: ['p03.ddr', 'p03.date_prevue_d_accouchement'],
    ok: ([a, b]) => !Number.isFinite(days(a, b)) || (days(a, b) >= 266 && days(a, b) <= 294),
  },
  {
    rule: 'depassement-dpa:0-14',
    ids: ['p03.date_prevue_d_accouchement', 'p03.date_de_depassement_de_terme'],
    ok: ([a, b]) => !Number.isFinite(days(a, b)) || (days(a, b) >= 0 && days(a, b) <= 14),
  },
];

/** Cross-field failures of one page; `values` = normalized values by field id. */
export function validatePage(schema: PageSchema, values: Record<string, Normalized>): { field_ids: string[]; rule: string }[] {
  const ids = new Set(schema.fields.map((f) => f.id));
  return RULES.filter((r) => r.ids.every((id) => ids.has(id) && values[id] != null && values[id] !== '') && !r.ok(r.ids.map((id) => values[id])))
    .map((r) => ({ field_ids: r.ids, rule: r.rule }));
}
