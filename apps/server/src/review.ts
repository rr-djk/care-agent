import type { ExtractedField, Flag, LifecycleState, PageSchema, ReviewAction, ReviewItem, ReviewQueue, ReviewReason } from '@care-agent/schema';

/** Marks an ILLEGIBLE field the midwife chose to keep illegible: it leaves the queue. */
export const LEFT_ILLEGIBLE = 'left_illegible';
export const MANUAL = 'manual';
export const CORRECTED = 'corrected'; // the midwife typed a value that still fails a validator
export const LOW_QUALITY = 'low_quality'; // the page carries the LOW_QUALITY flag: its model readings all need a check
export const LOW_CATEGORY_CONFIDENCE = 'low_category_confidence'; // the calibration table demoted this whole category (calibration.ts)
export const LOW_READER_CONFIDENCE = 'low_reader_confidence'; // READER=cell|hybrid: this cell's reading scored under the threshold

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
  if (f.reason === LOW_QUALITY) return 'low_quality';
  if (f.reason === LOW_CATEGORY_CONFIDENCE) return 'low_category_confidence';
  if (f.reason === LOW_READER_CONFIDENCE) return 'low_reader_confidence';
  if (f.confidence_signals.validators_passed === false) return 'unusual_value';
  if (f.confidence_signals.agreement === 0) return 'ink_but_empty'; // ink says written, the model read nothing
  return 'unusual_value'; // e.g. a cross-field rule failed
}

const KIND = { unusual_value: 'doubt', ink_but_empty: 'doubt', illegible: 'illegible', not_read: 'unread', manual: 'manual', low_quality: 'doubt', low_category_confidence: 'doubt', low_reader_confidence: 'doubt' } as const;

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
    case 'low_quality':
      return `La photo de cette page est de qualité douteuse : j'ai lu « ${show(f.value)} » pour ${label}. Pouvez-vous vérifier ?`;
    case 'low_category_confidence':
      return `J'ai lu « ${show(f.value)} » pour ${label}, mais ce type de champ est difficile à lire pour moi. Pouvez-vous vérifier ?`;
    case 'low_reader_confidence':
      return `J'ai lu « ${show(f.value)} » pour ${label}, mais je ne suis pas sûr de ma lecture. Pouvez-vous vérifier ?`;
    case 'manual':
      return `Il y a de l'écriture pour ${label}. Quelle est la valeur ?`;
  }
}

/** Audit/jury line behind the « Détails » toggle: the only place a percentage is written. */
function calibrationDetail(calibrated: number, c: NonNullable<ExtractedField['calibration']>): string {
  const pct = (x: number) => Math.round(100 * x);
  return `confiance estimée ${pct(calibrated)} % [${pct(c.low)}–${pct(c.high)} %] sur ${c.n} exemples`;
}

export function reviewItem(pageId: string, f: ExtractedField, label: string): ReviewItem {
  const code = reasonCode(f);
  const actions: ReviewAction[] = [...(hasValue(f.value) ? (['confirm'] as const) : []), 'correct', 'retake', 'leave_illegible'];
  const detail_fr = f.calibrated !== undefined && f.calibration ? calibrationDetail(f.calibrated, f.calibration) : undefined;
  return { page_id: pageId, field_id: f.field_id, kind: KIND[code], label_fr: label, value: f.value, reason_code: code, text_fr: textFr(f, label, code), actions, ...(detail_fr && { detail_fr }) };
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
