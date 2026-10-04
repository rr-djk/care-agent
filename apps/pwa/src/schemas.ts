import type { FieldDef, PageSchema } from '@care-agent/schema';
import { getLang, type Lang } from './i18n';

// Page schemas are bundled for their labels (the node-only loader is not usable in the browser).
const schemas = import.meta.glob<PageSchema>('../../../packages/schema/pages/*.json', { eager: true, import: 'default' });

const defs = new Map<string, FieldDef>(Object.values(schemas).flatMap((s) => s.fields.map((f) => [f.id, f] as const)));

export const fieldDef = (id: string): FieldDef | undefined => defs.get(id);

/** Label of a field in the current language (French and English labels come with the page schemas). */
export const fieldLabel = (id: string, lang: Lang = getLang()) => {
  const d = defs.get(id);
  return d ? (lang === 'en' ? d.label_en : d.label_fr) : id;
};

/** The label without its column part: "TA — 1er trim. visite 1" -> "TA" (a table row name). */
export const rowLabel = (id: string, lang: Lang = getLang()) => fieldLabel(id, lang).split(' — ')[0];

/** The column part of a table label: "Date — accouchement 1" -> "accouchement 1". */
export const columnPart = (id: string, lang: Lang = getLang()) => fieldLabel(id, lang).split(' — ')[1] ?? '';

/** The page schema that reads a page type (pages 7 and 8 share the layouts of 5 and 6). */
export const schemaFor = (pageType: number | undefined): PageSchema | undefined =>
  pageType === undefined ? undefined : Object.values(schemas).find((s) => s.page_types.includes(pageType) && !s.layout.startsWith('real_'));
