// Longitudinal record (pure): the retained value of each field of a patient, over all her linked pages.
// Re-digitization rule: a later page never overwrites silently. Where the record already holds a value and the new
// page differs (empty, unreliable or another value), that field is a difference the midwife settles: keep the old value or
// take the new one. Default: take the new value when it is usable (KNOWN, non-empty), else keep the old one.
// A new value for a field that was empty is simply added (nothing is lost, nothing to choose).
import type { ExtractedField } from '@care-agent/schema';
import { normalizeFiche } from './linking';

const FICHE = 'p01.n_deg_de_la_fiche';

export interface ValuePage {
  id: string;
  page_type?: number; // pages 7 and 8 reuse the field ids of 5 and 6: values are kept per page type
  captured_at: string;
  fields: ExtractedField[];
}

export interface Retained {
  field: ExtractedField;
  page_type?: number;
  page_id: string;
  captured_at: string;
}

export type Choice = 'old' | 'new';
export type Values = Map<string, Retained>; // key = valueKey(page, field_id)
export const valueKey = (page: Pick<ValuePage, 'page_type'>, fieldId: string) => `${page.page_type ?? 0}:${fieldId}`;

/** KNOWN with a value (an unticked checkbox is empty). */
export const usable = (f: ExtractedField) => f.status === 'KNOWN' && f.value !== null && f.value !== '' && f.value !== false;

const same = (a: ExtractedField, b: ExtractedField) => {
  // The fiche number compares on its link key, so "2026 711 003" and "2026-711-003" are not a difference.
  if (a.field_id === FICHE) return normalizeFiche(String(a.value)).key === normalizeFiche(String(b.value)).key;
  const fold = (f: ExtractedField) => String(f.value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '');
  return fold(a) === fold(b);
};

export interface Conflict {
  field_id: string;
  old: Retained;
  new: ExtractedField;
  default: Choice;
}

/** Fields of `page` that would overwrite a retained value (usable) with something else. */
export function findConflicts(values: Values, page: ValuePage): Conflict[] {
  const out: Conflict[] = [];
  for (const f of page.fields) {
    const old = values.get(valueKey(page, f.field_id));
    if (old && usable(old.field) && !(usable(f) && same(old.field, f))) {
      out.push({ field_id: f.field_id, old, new: f, default: usable(f) ? 'new' : 'old' });
    }
  }
  return out;
}

/** Applies a page to the retained values; `choices` (by field id) settle its conflicts, the others follow the rule above. */
export function applyPage(values: Values, page: ValuePage, choices: ReadonlyMap<string, Choice>): void {
  for (const f of page.fields) {
    const old = values.get(valueKey(page, f.field_id));
    const choice = choices.get(f.field_id);
    const take = choice ? choice === 'new' : usable(f) && !(old && usable(old.field));
    if (take) values.set(valueKey(page, f.field_id), { field: f, page_type: page.page_type, page_id: page.id, captured_at: page.captured_at });
  }
}

/** Retained values of pages given in record order; `choices` keyed `${page_id}|${field_id}`. */
export function buildValues(pages: ValuePage[], choices: ReadonlyMap<string, Choice>): Values {
  const values: Values = new Map();
  for (const page of pages) {
    const own = new Map<string, Choice>();
    for (const f of page.fields) {
      const c = choices.get(`${page.id}|${f.field_id}`);
      if (c) own.set(f.field_id, c);
    }
    applyPage(values, page, own);
  }
  return values;
}
