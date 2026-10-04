// A patient record as the profile screen shows it: key indicators with their source, the latest measurements, the visit
// history and every retained value grouped by page. Pure (the component only draws it); no identifier exists in a record.
import type { PatientRecord, PatientSummary } from '@care-agent/schema';

type Value = PatientRecord['values'][number];

export interface Indicator {
  key: 'term' | 'ddr' | 'dpa' | 'blood' | 'gp' | 'age';
  value: string;
  source?: { page_type?: number; date: string }; // none for a computed value
}

const byId = (r: PatientRecord) => new Map(r.values.map((v) => [v.field_id, v]));
const day = (ddmmyyyy: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
};

/** Completed weeks of amenorrhea since the LMP (dd/mm/yyyy), or null when unknown or outside 0..45 weeks. */
export function weeksSince(ddr: string | undefined, now = Date.now()): number | null {
  const d = ddr ? day(ddr) : null;
  if (d === null) return null;
  const weeks = Math.floor((now - d) / (7 * 86_400_000));
  return weeks >= 0 && weeks <= 45 ? weeks : null;
}

/** Postpartum once a delivery or postpartum page is in the record. */
export const isPostpartum = (r: PatientRecord) => r.values.some((v) => (v.page_type ?? 0) >= 4);

/** The blood group from the ticked boxes of page 3 (A/B/O/AB and Rh), or null. */
export function bloodGroup(r: PatientRecord): Value | null {
  const v = byId(r);
  const group = (['a', 'b', 'o', 'ab'] as const).find((g) => v.get(`p03.groupage_${g}`)?.value === true);
  if (!group) return null;
  const rh = v.get('p03.rh_plus')?.value === true ? ' Rh +' : v.get('p03.rh_minus')?.value === true ? ' Rh −' : '';
  const src = v.get(`p03.groupage_${group}`)!;
  return { ...src, value: `${group.toUpperCase()}${rh}` };
}

export function indicators(r: PatientRecord, now = Date.now()): Indicator[] {
  const v = byId(r);
  const out: Indicator[] = [];
  const from = (x: Value) => ({ page_type: x.page_type, date: x.source_date });
  const ddr = v.get('p03.ddr');
  const sa = !isPostpartum(r) && typeof ddr?.value === 'string' ? weeksSince(ddr.value, now) : null;
  if (sa !== null) out.push({ key: 'term', value: String(sa) });
  for (const [key, id] of [['ddr', 'p03.ddr'], ['dpa', 'p03.date_prevue_d_accouchement']] as const) {
    const x = v.get(id);
    if (x && typeof x.value === 'string') out.push({ key, value: x.value, source: from(x) });
  }
  const blood = bloodGroup(r);
  if (blood) out.push({ key: 'blood', value: String(blood.value), source: from(blood) });
  const g = v.get('p02.gestation');
  const p = v.get('p02.parite');
  if (g || p) out.push({ key: 'gp', value: `G${g?.value ?? '?'} P${p?.value ?? '?'}`, source: from((g ?? p)!) });
  const age = v.get('p02.age');
  if (age) out.push({ key: 'age', value: String(age.value), source: from(age) });
  return out;
}

/** Order of a visit column of the pregnancy table: v1_t1 < v2_t1 < … < m9_t3 (trimester, then visit or month). */
export function columnOrder(fieldId: string): number {
  const m = /\.(?:v|m)(\d)_t(\d)$/.exec(fieldId);
  return m ? Number(m[2]) * 10 + Number(m[1]) : -1;
}

// The measurements of the profile: a row of the pregnancy table, or a single field of the postpartum page.
const MEASURES = [
  { key: 'ta', rows: ['p03.ta'], single: ['p05.ta'] },
  { key: 'weight', rows: ['p03.poids_kg'], single: ['p05.poids'] },
  { key: 'hb', rows: ['p03.hemoglobine'], single: [] },
  { key: 'temp', rows: [], single: ['p05.t_deg'] },
  { key: 'gluco', rows: ['p03.glucosurie'], single: [] },
  { key: 'albu', rows: ['p03.albuminurie'], single: [] },
] as const;

export interface Measure {
  key: (typeof MEASURES)[number]['key'];
  field_id: string;
  value: string;
  date: string;
}

/**
 * The latest value of each measurement: the most recent source date, then the latest visit column of the pregnancy
 * table (a postpartum value is later than any pregnancy one).
 */
export function latestMeasures(r: PatientRecord): Measure[] {
  const out: Measure[] = [];
  for (const m of MEASURES) {
    const hits = r.values.filter(
      (v) => typeof v.value === 'string' && v.value !== '' && ((m.rows as readonly string[]).some((row) => v.field_id.startsWith(`${row}.`)) || (m.single as readonly string[]).includes(v.field_id)),
    );
    const best = hits.sort((a, b) => b.source_date.localeCompare(a.source_date) || (b.page_type ?? 0) - (a.page_type ?? 0) || columnOrder(b.field_id) - columnOrder(a.field_id))[0];
    if (best) out.push({ key: m.key, field_id: best.field_id, value: String(best.value), date: best.source_date });
  }
  return out;
}

/** Every retained value grouped by page type (record order inside a page). */
export function valuesByPage(r: PatientRecord): [number, Value[]][] {
  const groups = new Map<number, Value[]>();
  for (const v of r.values) groups.set(v.page_type ?? 0, [...(groups.get(v.page_type ?? 0) ?? []), v]);
  return [...groups].sort((a, b) => a[0] - b[0]);
}

/** A patient list line matches a search: fiche number, PAT id or facility, case and separators ignored. */
export function matchesSearch(p: Pick<PatientSummary, 'id' | 'fiche_number' | 'facility'>, query: string): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s\-_/.]+/g, '');
  const q = norm(query);
  return !q || [p.id, p.fiche_number, p.facility].some((s) => norm(s).includes(q));
}
