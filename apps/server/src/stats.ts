// Anonymized aggregates for the supervisor's dashboard (bonus: epidemiological use of the data). Counts per band over the
// readings of validated, linked pages; a count under MIN_CELL is hidden. Nothing here carries a patient id, a session id or a
// date. Not decision support: the bands are numeric ranges, no verdict (no "hypertension" label).
import { existsSync, readFileSync } from 'node:fs';
import { MIN_CELL, type Aggregates, type StatBin, type StatBlock } from '@care-agent/schema';
import type { Db } from './db';

type Reading = { field_id: string; value: string };

const bands = (values: number[], edges: number[], labels: string[]): number[] => {
  const counts = labels.map(() => 0);
  for (const v of values) counts[edges.filter((e) => v >= e).length]++;
  return counts;
};
const bins = (labels: string[], counts: number[]): StatBin[] =>
  labels.map((label_fr, i) => ({ label_fr, count: counts[i] >= MIN_CELL || counts[i] === 0 ? counts[i] : null }));

const SYS_LABELS = ['< 120', '120 à 139', '140 à 159', '≥ 160'];
const TEMP_LABELS = ['< 36,0', '36,0 à 37,4', '37,5 à 37,9', '≥ 38,0'];
const RESULT_LABELS = ['Négatif', 'Positif'];

const systolic = (v: string) => {
  const m = /^(\d{2,3})\/(\d{2,3})$/.exec(v);
  return m ? Number(m[1]) : null;
};
const num = (v: string) => (Number.isFinite(Number(v.replace(',', '.'))) && v.trim() ? Number(v.replace(',', '.')) : null);
const base = (id: string) => id.replace(/\.(v\d_t\d|m\d_t\d)$/, '');
const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);

function block(id: StatBlock['id'], title_fr: string, labels: string[], counts: number[], note_fr?: string): StatBlock {
  return { id, title_fr, ...(note_fr && { note_fr }), n: counts.reduce((a, b) => a + b, 0), bins: bins(labels, counts) };
}
const results = (xs: string[]) => [xs.filter((v) => v === 'Neg').length, xs.filter((v) => v === 'Pos').length];

/** Aggregates of KNOWN readings by form field (ids of the page schemas: p03.ta, p05.ta, p05.t_deg, p06.temperature, labs). */
export function aggregate(readings: Reading[]): StatBlock[] {
  const of = (...ids: string[]) => readings.filter((r) => ids.includes(base(r.field_id))).map((r) => r.value);
  const sys = nums(of('p03.ta', 'p05.ta').map(systolic));
  const temp = nums(of('p05.t_deg', 'p06.temperature').map(num));
  return [
    block('bp_systolic', 'Tension artérielle systolique (mmHg)', SYS_LABELS, bands(sys, [120, 140, 160], SYS_LABELS)),
    block('temperature', 'Température (°C)', TEMP_LABELS, bands(temp, [36, 37.5, 38], TEMP_LABELS), 'Mères (post-partum) et nouveau-nés.'),
    block('hiv', 'Sérologie VIH', RESULT_LABELS, results(of('p03.serologie_vih'))),
    block('syphilis', 'Syphilis (TPHA/VDRL)', RESULT_LABELS, results(of('p03.syphilis_tpha_vdrl'))),
    block('hepatitis', 'Hépatite B (Ag HBs)', RESULT_LABELS, results(of('p03.ag_hbs')), "Le registre papier porte l'Ag HBs, pas l'hépatite C."),
  ];
}

/** Readings of the pages that went through a link decision (PATIENT_MATCHED and later), retaken pages left out. */
export function recordAggregates(db: Db): Aggregates {
  const rows = db
    .prepare(
      `SELECT f.field_id, f.json FROM fields f JOIN pages p ON p.id = f.page_id
       WHERE p.state IN ('PATIENT_MATCHED', 'REGISTERED', 'SYNCED') AND p.flags NOT LIKE '%SUPERSEDED%'`,
    )
    .all() as { field_id: string; json: string }[];
  const readings: Reading[] = [];
  for (const r of rows) {
    const f = JSON.parse(r.json) as { status: string; value: unknown };
    if (f.status === 'KNOWN' && typeof f.value === 'string') readings.push({ field_id: r.field_id, value: f.value });
  }
  return { source: 'records', source_fr: 'Dossiers validés et reliés', blocks: aggregate(readings) };
}

// --- reference dataset (synthetic CSV of the challenge, read-only) ----------------------------------------------------

const REF_COLUMNS = { sys: 'mean systolic bp (mmhg)', hiv: 'hiv test result', syphilis: 'syphilis test result', hcv: 'hepatitis c test result' };

/** Aggregates of the synthetic reference CSV (one row per woman; 1 = positive, empty = not tested). Null when the file is missing. */
export function referenceAggregates(csvPath: string): Aggregates | null {
  if (!existsSync(csvPath)) return null;
  const [head, ...lines] = readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const cols = head.split(',');
  const at = (name: string) => cols.indexOf(name);
  const rows = lines.map((l) => l.split(','));
  const col = (name: string) => (at(name) >= 0 ? rows.map((r) => r[at(name)] ?? '') : []);
  const test = (name: string) => {
    const v = col(name).filter((x) => x === '0' || x === '1');
    return [v.filter((x) => x === '0').length, v.filter((x) => x === '1').length];
  };
  const sys = nums(col(REF_COLUMNS.sys).map(num));
  return {
    source: 'reference',
    source_fr: 'Jeu synthétique de référence (200 femmes, non issu de photos)',
    blocks: [
      block('bp_systolic', 'Tension artérielle systolique moyenne (mmHg)', SYS_LABELS, bands(sys, [120, 140, 160], SYS_LABELS)),
      block('hiv', 'Sérologie VIH', RESULT_LABELS, test(REF_COLUMNS.hiv)),
      block('syphilis', 'Syphilis', RESULT_LABELS, test(REF_COLUMNS.syphilis)),
      block('hepatitis', 'Hépatite C', RESULT_LABELS, test(REF_COLUMNS.hcv)),
    ],
  };
}
