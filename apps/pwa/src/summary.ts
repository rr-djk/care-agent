// The page summary, organized like the paper page: the fields to check first, then one section per part of the form
// (the zones of the page schema): a list of values for the form parts, a grid (rows x visits) for the tables, the
// pregnancy table split by trimester. Pure: the component only draws it.
import type { ExtractedField, PageSchema } from '@care-agent/schema';
import { getLang, t, type Lang } from './i18n';
import { columnPart, fieldDef, rowLabel, schemaFor } from './schemas';
import { groupFields } from './state';

/** Section titles by zone (the trailing table band/column of a zone id is left out: p03.visits.r2c1 -> p03.visits.r2). */
const TITLES: Record<string, Record<Lang, string>> = {
  'p01.identity': { fr: 'Identification de la fiche', en: 'Form identification' },
  'p01.facility': { fr: 'Établissement', en: 'Facility' },
  'p01.risk': { fr: 'Grossesse à risque', en: 'Pregnancy risk' },
  'p02.identity': { fr: 'La patiente', en: 'The patient' },
  'p02.antecedents': { fr: 'Antécédents familiaux', en: 'Family history' },
  'p02.obstetric': { fr: 'Antécédents obstétricaux', en: 'Obstetric history' },
  'p02.deliveries.r1': { fr: 'Accouchements antérieurs', en: 'Previous deliveries' },
  'p02.deliveries.r2': { fr: 'Complications des accouchements', en: 'Delivery complications' },
  'p02.history': { fr: 'Gestité, parité, vaccinations', en: 'Gravidity, parity, vaccinations' },
  'p03.header': { fr: 'Grossesse', en: 'Pregnancy' },
  'p03.visits.r1': { fr: 'Visites et examen général', en: 'Visits and general exam' },
  'p03.visits.r2': { fr: 'Examen obstétrical', en: 'Obstetric exam' },
  'p03.visits.r3': { fr: 'Biologie et sérologies', en: 'Lab tests and serologies' },
  'p03.visits.r4': { fr: 'Bilan sanguin et traitement', en: 'Blood tests and treatment' },
  'p04.place': { fr: "Lieu de l'accouchement", en: 'Place of delivery' },
  'p04.mode': { fr: 'Accouchement', en: 'Delivery' },
  'p04.complications': { fr: 'Complications', en: 'Complications' },
  'p04.newborn': { fr: 'Nouveau-né', en: 'Newborn' },
  'p05.header': { fr: 'Consultation', en: 'Visit' },
  'p05.vitals': { fr: 'Constantes', en: 'Vital signs' },
  'p05.state': { fr: 'État de la mère', en: "Mother's condition" },
  'p05.exam': { fr: 'Examen', en: 'Examination' },
  'p05.complications': { fr: 'Complications', en: 'Complications' },
  'p05.followup': { fr: 'Traitement', en: 'Treatment' },
  'p05.contraception': { fr: 'Contraception', en: 'Contraception' },
  'p06.measures': { fr: 'Mesures', en: 'Measurements' },
  'p06.signs': { fr: 'Signes', en: 'Signs' },
  'p06.lesions': { fr: 'Lésions', en: 'Lesions' },
  'p06.vaccines': { fr: 'Vaccins et suppléments', en: 'Vaccines and supplements' },
  'p06.decision': { fr: 'Décision', en: 'Decision' },
};

const sectionId = (zoneId: string) => zoneId.replace(/c\d+$/, '');
export const sectionTitle = (id: string, lang: Lang = getLang()) => TITLES[id]?.[lang] ?? id;

export const isEmpty = (f: ExtractedField | undefined) => !f || f.value === null || f.value === '' || f.value === false;
const flaggedStatus = (f: ExtractedField) => f.status === 'NEEDS_REVIEW' || f.status === 'UNKNOWN' || (f.status === 'ILLEGIBLE' && f.reason !== 'left_illegible');

/** Value as shown: checkbox ticked / not, "—" when nothing is written. */
export function showValue(f: Pick<ExtractedField, 'value'> | undefined): string {
  if (!f || f.value === null || f.value === '') return '—';
  if (typeof f.value === 'boolean') return f.value ? t('summary.checked') : t('summary.unchecked');
  return f.value;
}

export interface ListSection {
  kind: 'list';
  id: string;
  title: string;
  values: ExtractedField[]; // written text cells and flagged cells, in form order
  ticked: ExtractedField[]; // checkboxes that are ticked
  flagged: number;
}

export interface TableSegment {
  label: string; // the trimester for the pregnancy table, '' otherwise
  columns: string[];
  rows: { label: string; cells: (ExtractedField | undefined)[] }[];
}

export interface TableSection {
  kind: 'table';
  id: string;
  title: string;
  segments: TableSegment[];
  flagged: number;
  filled: number; // cells with a value
}

export type Section = ListSection | TableSection;

export interface PageSummaryModel {
  flagged: ExtractedField[]; // to check, in the order of the review queue
  sections: Section[];
  read: number; // text cells with a value
  review: number;
  empty: number; // cells left blank on paper
  checked: number; // ticked boxes
}

/** "T1 V1" -> trimester 1, column "V1" (the compact header of the pregnancy table). */
const trimester = (col: string) => /^T(\d) (.+)$/.exec(col);

function table(zones: PageSchema['zones'], byId: Map<string, ExtractedField>, lang: Lang): TableSegment[] {
  return zones.map((z) => {
    const rows = z.rows ?? [];
    const cols = z.columns ?? [];
    const cell = (r: number, c: number) => z.cells[r * cols.length + c];
    const tri = cols.map(trimester);
    const pregnancy = tri.every((m) => m !== null);
    const n = pregnancy ? Number(tri[0]![1]) : 0;
    return {
      label: pregnancy ? (n === 1 ? t('summary.trim1') : t('summary.trim', { n })) : '',
      columns: cols.map((col, c) => (pregnancy ? tri[c]![2] : capitalize(columnPart(cell(0, c), lang)) || col)),
      rows: rows.map((_, r) => ({ label: rowLabel(cell(r, 0), lang), cells: cols.map((_, c) => byId.get(cell(r, c))) })),
    };
  });
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The summary of one page, from its fields and its page schema. */
export function buildSummary(pageType: number | undefined, fields: ExtractedField[], lang: Lang = getLang()): PageSummaryModel {
  const byId = new Map(fields.map((f) => [f.field_id, f]));
  const schema = schemaFor(pageType);
  const { flagged } = groupFields(fields.filter(flaggedStatus));
  const isCheckbox = (f: ExtractedField) => fieldDef(f.field_id)?.type === 'checkbox';
  const counts = {
    read: fields.filter((f) => !isCheckbox(f) && !isEmpty(f)).length,
    review: flagged.length,
    empty: fields.filter((f) => !isCheckbox(f) && isEmpty(f) && !flaggedStatus(f)).length,
    checked: fields.filter((f) => isCheckbox(f) && f.value === true).length,
  };
  if (!schema) return { flagged, sections: [], ...counts };

  const groups = new Map<string, PageSchema['zones']>();
  for (const z of schema.zones) groups.set(sectionId(z.id), [...(groups.get(sectionId(z.id)) ?? []), z]);
  const sections: Section[] = [...groups].map(([id, zones]): Section => {
    const ids = zones.flatMap((z) => z.cells);
    const own = ids.map((c) => byId.get(c)).filter((f): f is ExtractedField => !!f);
    const nFlagged = own.filter(flaggedStatus).length;
    if (zones[0].rows) {
      return { kind: 'table', id, title: sectionTitle(id, lang), segments: table(zones, byId, lang), flagged: nFlagged, filled: own.filter((f) => !isEmpty(f)).length };
    }
    return {
      kind: 'list',
      id,
      title: sectionTitle(id, lang),
      values: own.filter((f) => !isCheckbox(f) && (!isEmpty(f) || flaggedStatus(f))),
      ticked: own.filter((f) => isCheckbox(f) && f.value === true),
      flagged: nFlagged,
    };
  });
  return { flagged, sections, ...counts };
}
