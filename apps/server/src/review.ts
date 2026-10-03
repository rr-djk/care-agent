import type { ExtractedField, Flag, LifecycleState, PageSchema, ReviewAction, ReviewItem, ReviewQueue, ReviewReason } from '@care-agent/schema';

/** Marks an ILLEGIBLE field the midwife chose to keep illegible: it leaves the queue. */
export const LEFT_ILLEGIBLE = 'left_illegible';
export const MANUAL = 'manual';
export const CORRECTED = 'corrected'; // the midwife typed a value that still fails a validator

export interface ReviewPage {
  id: string;
  page_type?: number;
  state: LifecycleState;
  flags: Flag[];
  fields: ExtractedField[]; // stored order = reading order
  reviewed: ReadonlySet<string>; // field ids that were flagged and then edited (audit trail)
}

const OPEN_STATES: LifecycleState[] = ['NEEDS_REVIEW', 'MANUAL_REVIEW_REQUIRED'];

/** A field the midwife still has to look at. */
export const isPending = (f: ExtractedField) =>
  f.status === 'NEEDS_REVIEW' || f.status === 'UNKNOWN' || (f.status === 'ILLEGIBLE' && f.reason !== LEFT_ILLEGIBLE);

const hasValue = (v: ExtractedField['value']) => v !== null && v !== '';

export function reasonCode(f: ExtractedField): ReviewReason {
  if (f.status === 'ILLEGIBLE') return 'illegible';
  if (f.status === 'UNKNOWN') return f.reason === MANUAL ? 'manual' : 'not_read';
  if (f.confidence_signals.validators_passed === false) return 'unusual_value';
  if (f.confidence_signals.agreement === 0) return 'ink_but_empty'; // ink says written, the model read nothing
  return 'unusual_value'; // e.g. a cross-field rule failed
}

const KIND = { unusual_value: 'doubt', ink_but_empty: 'doubt', illegible: 'illegible', not_read: 'unread', manual: 'manual' } as const;

const show = (v: ExtractedField['value']) => (typeof v === 'boolean' ? (v ? 'coché' : 'non coché') : String(v));

function textFr(f: ExtractedField, label: string, code: ReviewReason): string {
  switch (code) {
    case 'unusual_value':
      return f.reason === 'corrected'
        ? `Vous avez saisi « ${show(f.value)} » pour ${label}, mais la valeur semble inhabituelle. Pouvez-vous vérifier ?`
        : `J'ai lu « ${show(f.value)} » pour ${label}, mais la valeur semble inhabituelle. Pouvez-vous vérifier ?`;
    case 'ink_but_empty':
      return `Je vois de l'écriture pour ${label} mais je n'ai rien pu lire. Quelle est la valeur ?`;
    case 'illegible':
      return `${label} est illisible pour moi. Quelle est la valeur ?`;
    case 'not_read':
      return `Je n'ai pas pu lire ${label}. Quelle est la valeur ?`;
    case 'manual':
      return `Il y a de l'écriture pour ${label}. Quelle est la valeur ?`;
  }
}

export function reviewItem(pageId: string, f: ExtractedField, label: string): ReviewItem {
  const code = reasonCode(f);
  const actions: ReviewAction[] = [...(hasValue(f.value) ? (['confirm'] as const) : []), 'correct', 'retake', 'leave_illegible'];
  return { page_id: pageId, field_id: f.field_id, kind: KIND[code], label_fr: label, value: f.value, reason_code: code, text_fr: textFr(f, label, code), actions };
}

/**
 * The review queue of a session: pages in capture order (superseded and closed pages skipped), fields in reading
 * order, only those that still need the midwife. Progress counts open + already reviewed flagged fields.
 */
export function buildReview(pages: ReviewPage[], schemaOf: (pageType?: number) => PageSchema | undefined): ReviewQueue {
  const items: ReviewItem[] = [];
  const progress: ReviewQueue['progress'] = { total: 0, done: 0, pages: [] };
  for (const page of pages) {
    if (page.flags.includes('SUPERSEDED')) continue;
    const labels = new Map(schemaOf(page.page_type)?.fields.map((d) => [d.id, d.label_fr]));
    const pending = OPEN_STATES.includes(page.state) ? page.fields.filter(isPending) : [];
    for (const f of pending) items.push(reviewItem(page.id, f, labels.get(f.field_id) ?? f.field_id));
    const open = new Set(pending.map((f) => f.field_id));
    const total = open.size + [...page.reviewed].filter((id) => !open.has(id)).length;
    progress.pages.push({ page_id: page.id, page_type: page.page_type, state: page.state, total, done: total - open.size });
    progress.total += total;
    progress.done += total - open.size;
  }
  return { items, progress };
}
