import { LAYOUT, PAGE_LAYOUTS, Status, normalizeValue, validateField, type ExtractedField, type FieldDef, type PageSchema, type RecordPage } from '@care-agent/schema';
import { loadPageSchema } from '@care-agent/schema/node';
import type { AuthUser } from './auth';
import type { Db } from './db';
import { ApiError } from './errors';
import { maskIdentifiers } from './privacy';
import { CORRECTED, LEFT_ILLEGIBLE } from './review';
import { fitsType } from './vision/analyze';

export const EDITABLE = ['NEEDS_REVIEW', 'MANUAL_REVIEW_REQUIRED'];

/** What the midwife (button or chat) does to one field. */
export type FieldEdit = { confirm: true } | { value: string | boolean | null; status?: Status };

/** The updated field; `text_fr` says in French what the agent did not accept or changed (masked identifier, failed rule). */
export type EditResult = ExtractedField & { text_fr?: string };

/** Page schema of a stored page; undefined for page types without one (pages 5 to 8 have no schema yet). */
export function pageSchemaFor(pageType?: number): PageSchema | undefined {
  const layout = PAGE_LAYOUTS.find((l) => l === LAYOUT[pageType as keyof typeof LAYOUT]);
  return layout ? loadPageSchema(layout) : undefined;
}

/** PATCH body -> edit: `{confirm:true}`, `{status:'ILLEGIBLE'}` or `{value, status?}`; undefined when malformed. */
export function parseEdit(body: { confirm?: unknown; status?: unknown; value?: unknown }): FieldEdit | undefined {
  if (body.confirm === true) return { confirm: true };
  const status = Status.safeParse(body.status ?? 'KNOWN');
  if (!status.success) return undefined;
  if (status.data === 'ILLEGIBLE') return { value: null, status: 'ILLEGIBLE' };
  const v = body.value;
  return v === null || typeof v === 'string' || typeof v === 'boolean' ? { value: v, status: status.data } : undefined;
}

function explain(def: FieldDef, failed: string[]): string {
  const unit = def.unit ? ` ${def.unit}` : '';
  return failed
    .map((id) => {
      const range = /^range:(-?[\d.]+):(-?[\d.]+)$/.exec(id);
      if (range) return `attendu : entre ${range[1]} et ${range[2]}${unit}`;
      if (id === 'bp') return 'attendu : tension au format 120/80';
      if (id === 'date' || id === 'type:date') return 'attendu : date jj/mm/aaaa valide';
      if (id === 'type:number') return `attendu : un nombre${unit}`;
      if (id === 'type:enum') return `attendu : ${def.allowed_values?.join(', ')}`;
      return 'valeur invalide';
    })
    .join(' ; ');
}

const shown = (v: ExtractedField['value']) => (v === null ? '—' : String(v));

/**
 * Applies a field edit and audits it. Shared by PATCH /api/pages/:id/fields/:fieldId and the chat, so a typed answer
 * and a button do exactly the same. A corrected value is normalized and validated: if it still fails a validator the
 * field stays NEEDS_REVIEW (the agent never silently accepts it) and `text_fr` says why.
 */
export function applyFieldEdit(db: Db, user: AuthUser, page: RecordPage, fieldId: string, edit: FieldEdit): EditResult {
  if (!EDITABLE.includes(page.state)) throw new ApiError(409, 'page_not_editable', `page is ${page.state}`);
  const row = db.prepare('SELECT json FROM fields WHERE page_id = ? AND field_id = ?').get(page.id, fieldId) as { json: string } | undefined;
  if (!row) throw new ApiError(404, 'not_found', 'field not found');
  const old: ExtractedField = JSON.parse(row.json);
  const def = pageSchemaFor(page.page_type)?.fields.find((f) => f.id === fieldId);
  const { reason: _old, ...base } = old; // the old reason (manual, corrected...) does not survive an edit
  const notes: string[] = [];
  let updated: ExtractedField;

  if ('confirm' in edit) {
    if (old.value === null || old.value === '') throw new ApiError(400, 'bad_request', 'nothing to confirm: the field has no value');
    updated = { ...base, status: 'KNOWN' };
  } else {
    let value = edit.value;
    if (typeof value === 'string') {
      const m = maskIdentifiers(value);
      if (m.masked) notes.push('Un identifiant personnel a été masqué.');
      value = m.text;
    }
    if (edit.status === 'ILLEGIBLE') {
      updated = { ...base, value: null, status: 'ILLEGIBLE', reason: LEFT_ILLEGIBLE }; // explicit: stays illegible
    } else if (edit.status && edit.status !== 'KNOWN') {
      updated = { ...base, value, status: edit.status };
    } else if (def && (typeof value === 'string' || value === null)) {
      const n = normalizeValue(def, value);
      if (n === null) {
        updated = { ...base, value: null, status: 'NOT_PROVIDED', confidence_signals: { ...old.confidence_signals, validators_passed: true } };
      } else {
        const failed = validateField(def, n);
        if (!failed.length && !fitsType(def, n)) failed.push(`type:${def.type}`);
        const stored = typeof n === 'number' ? String(n) : n;
        updated = { ...base, value: stored, status: failed.length ? 'NEEDS_REVIEW' : 'KNOWN', confidence_signals: { ...old.confidence_signals, validators_passed: !failed.length } };
        if (failed.length) {
          updated.reason = CORRECTED;
          notes.unshift(`« ${shown(stored)} » ne convient pas pour ${def.label_fr} (${explain(def, failed)}). Le champ reste à vérifier.`);
        }
      }
    } else {
      updated = { ...base, value, status: 'KNOWN' };
    }
  }

  db.transaction(() => {
    db.prepare('UPDATE fields SET json = ? WHERE page_id = ? AND field_id = ?').run(JSON.stringify(updated), page.id, fieldId);
    db.prepare('INSERT INTO audit (page_id, field_id, actor_id, role, old_json, new_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      page.id,
      fieldId,
      user.id,
      user.role,
      JSON.stringify({ value: old.value, status: old.status }),
      JSON.stringify({ value: updated.value, status: updated.status }),
      new Date().toISOString(),
    );
  })();
  return notes.length ? { ...updated, text_fr: notes.join(' ') } : updated;
}

/** Field ids of a page that were flagged (NEEDS_REVIEW, ILLEGIBLE, UNKNOWN) before an edit: the "already reviewed" count. */
export function reviewedFields(db: Db, pageId: string): Set<string> {
  const rows = db.prepare('SELECT field_id, old_json FROM audit WHERE page_id = ?').all(pageId) as { field_id: string; old_json: string }[];
  const flagged = ['NEEDS_REVIEW', 'ILLEGIBLE', 'UNKNOWN'];
  return new Set(rows.filter((r) => flagged.includes(JSON.parse(r.old_json).status)).map((r) => r.field_id));
}
