import type { Difference, ExtractedField, LinkDecision, LinkProposal, LinkResult, PageProgress, PatientRecord, ReviewItem, ReviewQueue, Session, Status, StreamEvent } from '@care-agent/schema';
import { errorText, hasKey, t, type Key, type Params } from './i18n';

export const PAGE_TYPES = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Name of a page type in the current language. */
export const pageLabel = (type: number | undefined) => (type && type >= 1 && type <= 8 ? t(`page.${type}` as Key) : t('page.unknown'));

/** Status name in the current language. */
export const statusLabel = (status: Status) => t(`status.${status}` as Key);

// Order of the flagged fields in a page summary.
const FLAGGED: Status[] = ['NEEDS_REVIEW', 'ILLEGIBLE', 'UNKNOWN'];

export { errorText };

/** Key of the text of an error code (unknown codes get the generic text). */
const errorKey = (code: string): Key => (hasKey(`error.${code}`) ? (`error.${code}` as Key) : 'error.unknown');

/**
 * A text message: `key` (+ `params`) for what the app says, rendered in the current language by msgText; `text` for what
 * the server wrote (chat replies, field explanations), shown as received. A `pageType` param also fills `{label}`.
 */
export type TextMsg = { id: number; from: 'bot' | 'user'; kind: 'text'; key?: Key; params?: Params; text?: string; hint?: Key; streaming?: boolean };

export type Msg =
  | TextMsg
  | { id: number; from: 'bot'; kind: 'summary'; pageId: string }
  | { id: number; from: 'bot'; kind: 'item'; item: ReviewItem } // one review question; buttons only while it is the current one
  | { id: number; from: 'bot'; kind: 'page_clear'; pageId: string } // "Tout est vérifié pour la page N" + Confirmer la page
  | { id: number; from: 'bot'; kind: 'manual_offer'; pageId: string } // the AI failed: « Saisie manuelle »
  | { id: number; from: 'bot'; kind: 'finish_offer' } // every page is confirmed: « Dernière page : choisir le dossier »
  | { id: number; from: 'bot'; kind: 'link'; proposal: LinkProposal } // the link question; buttons only while it is the current one
  | { id: number; from: 'bot'; kind: 'link_done'; result: LinkResult } // « Dossier PAT-000012 mis à jour (3 visites) » + Voir le dossier
  | { id: number; from: 'bot'; kind: 'differences' }; // re-digitization: one choice per field (the live list is in `State.differences`)

export interface PageView {
  id: string;
  pageType?: number;
  fields: ExtractedField[] | null; // null until page_read
  flagged: string[]; // field ids announced by field_flagged
  failed: boolean;
  failCode?: string; // error code of the failed analysis
  validated: boolean;
  cleared: boolean; // "tout est vérifié" already announced
  superseded: boolean; // replaced by a retake
}

/** Local queue entry as the UI needs it (the stored page, without its meta). */
export interface QueueEntry {
  state: 'CAPTURED' | 'UPLOADED' | 'SYNC_FAILED';
  attempts: number;
  error?: string;
}

export interface State {
  session: Session | null;
  messages: Msg[];
  pages: Record<string, PageView>;
  order: string[]; // page ids in capture order
  review: ReviewQueue | null; // last queue loaded from the server
  shown: string | null; // key of the last review item put in the chat
  seen: Record<string, true>; // identities of the analysis events already applied (a reconnect replays the stored ones)
  // patient linking: offered once every page is confirmed, then asked (proposal), then decided (result)
  link: { offered: boolean; proposal: LinkProposal | null; result: LinkResult | null };
  differences: Difference[]; // re-digitization choices of the decided link
}

export const initialState: State = {
  session: null,
  messages: [],
  pages: {},
  order: [],
  review: null,
  shown: null,
  seen: {},
  link: { offered: false, proposal: null, result: null },
  differences: [],
};

export type Action =
  | { type: 'session_started'; session: Session }
  | { type: 'say'; from: 'bot' | 'user'; text: string } // as written (the midwife's message, a server explanation)
  | { type: 'say'; from: 'bot'; key: Key; params?: Params } // the app's own words, in the current language
  | { type: 'session_restored'; session: Session; pages: { id: string; pageType?: number; replaces?: string }[] }
  | { type: 'page_added'; pageId: string; pageType: number; replaces?: string }
  | { type: 'review_loaded'; queue: ReviewQueue }
  | { type: 'event'; event: StreamEvent }
  | { type: 'field_updated'; pageId: string; field: ExtractedField }
  | { type: 'page_confirmed'; pageId: string }
  | { type: 'link_proposal'; proposal: LinkProposal }
  | { type: 'link_decided'; result: LinkResult }
  | { type: 'differences_updated'; differences: Difference[] }
  | { type: 'reset' };

type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

const push = (s: State, msg: NewMsg): State => ({ ...s, messages: [...s.messages, { ...msg, id: s.messages.length } as Msg] });

/** The text of a text message in the current language. */
export function msgText(m: Pick<TextMsg, 'key' | 'params' | 'text'>): string {
  if (!m.key) return m.text ?? '';
  const params = m.params && 'pageType' in m.params ? { ...m.params, label: pageLabel(Number(m.params.pageType)) } : m.params;
  return t(m.key, params);
}

const newPage = (id: string, pageType?: number): PageView => ({ id, pageType, fields: null, flagged: [], failed: false, validated: false, cleared: false, superseded: false });

const patchPage = (s: State, id: string, patch: (p: PageView) => Partial<PageView>): State => {
  const page = s.pages[id] ?? newPage(id);
  return { ...s, pages: { ...s.pages, [id]: { ...page, ...patch(page) } } };
};

/** Flagged fields first (NEEDS_REVIEW, ILLEGIBLE, UNKNOWN; schema order inside a status), then the KNOWN ones. */
export function groupFields(fields: ExtractedField[]) {
  const flagged = FLAGGED.flatMap((status) => fields.filter((f) => f.status === status));
  return { flagged, known: fields.filter((f) => f.status === 'KNOWN') };
}

export function countByStatus(fields: ExtractedField[]) {
  const counts: Partial<Record<Status, number>> = {};
  for (const f of fields) counts[f.status] = (counts[f.status] ?? 0) + 1;
  return counts;
}

/** Identity of an analysis event: page_id + type (+ field or code). `record_ready` repeats legitimately, so it also carries the number of settled pages. */
function eventKey(s: State, e: StreamEvent): string | null {
  switch (e.type) {
    case 'page_received':
    case 'page_read':
      return `${e.type}|${e.page_id}`;
    case 'field_flagged':
      return `${e.type}|${e.page_id}|${e.field_id}`;
    case 'error':
      return e.page_id ? `${e.type}|${e.page_id}|${e.code}` : null; // chat errors have no page
    case 'record_ready':
      return `${e.type}|${e.record_id}|${Object.values(s.pages).filter((p) => p.fields !== null || p.failed).length}`;
    default:
      return null; // token, done, ping: chat stream, never replayed
  }
}

function onEvent(s: State, e: StreamEvent): State {
  const key = eventKey(s, e);
  if (key) {
    if (s.seen[key]) return s; // replay after a reconnect: already shown
    s = { ...s, seen: { ...s.seen, [key]: true } };
  }
  switch (e.type) {
    case 'page_received':
      return push(patchPage(s, e.page_id, () => ({})), { from: 'bot', kind: 'text', key: 'msg.page_received', hint: 'msg.page_received_hint' });
    case 'page_read':
      return push(patchPage(s, e.page_id, () => ({ fields: e.fields, failed: false })), { from: 'bot', kind: 'summary', pageId: e.page_id });
    case 'field_flagged':
      return patchPage(s, e.page_id, (p) => ({ flagged: [...p.flagged, e.field_id] }));
    case 'error': {
      const failed = push(e.page_id ? patchPage(s, e.page_id, () => ({ failed: true, failCode: e.code })) : s, { from: 'bot', kind: 'text', key: errorKey(e.code) });
      return e.page_id && e.code.startsWith('model_') ? push(failed, { from: 'bot', kind: 'manual_offer', pageId: e.page_id }) : failed;
    }
    case 'token': {
      const last = s.messages.at(-1);
      if (last?.kind === 'text' && last.streaming) return { ...s, messages: [...s.messages.slice(0, -1), { ...last, text: (last.text ?? '') + e.text }] };
      return push(s, { from: 'bot', kind: 'text', text: e.text, streaming: true });
    }
    case 'done': {
      const last = s.messages.at(-1);
      return last?.kind === 'text' && last.streaming ? { ...s, messages: [...s.messages.slice(0, -1), { ...last, streaming: false }] } : s;
    }
    case 'record_ready':
      return push(s, { from: 'bot', kind: 'text', key: 'msg.all_read' });
    default:
      return s; // pings
  }
}

export const itemKey = (i: ReviewItem) => `${i.page_id}|${i.field_id}|${i.reason_code}|${JSON.stringify(i.value)}`;

/** The item the bot is asking about: the head of the queue. */
export const currentItem = (s: State): ReviewItem | undefined => s.review?.items[0];

/** The chat message of the current item (the only one that shows buttons). */
export function activeItemMsg(s: State): number | undefined {
  const head = currentItem(s);
  const last = [...s.messages].reverse().find((m) => m.kind === 'item');
  return head && last?.kind === 'item' && itemKey(last.item) === itemKey(head) ? last.id : undefined;
}

const OPEN = ['NEEDS_REVIEW', 'MANUAL_REVIEW_REQUIRED'];

/** New queue: announce each page with nothing left to check, then ask the next question (once per distinct item). */
function onReview(s: State, queue: ReviewQueue): State {
  let next: State = { ...s, review: queue };
  for (const p of queue.progress.pages) {
    const pending = p.total - p.done;
    const cleared = next.pages[p.page_id]?.cleared ?? false;
    if (!OPEN.includes(p.state) || (pending > 0) === !cleared) continue; // already in the right state
    next = patchPage(next, p.page_id, () => ({ cleared: pending === 0 }));
    if (pending === 0) next = push(next, { from: 'bot', kind: 'page_clear', pageId: p.page_id });
  }
  const head = queue.items[0];
  if (head && itemKey(head) !== next.shown) next = { ...push(next, { from: 'bot', kind: 'item', item: head }), shown: itemKey(head) };
  else if (!head) next = { ...next, shown: null };
  return offerLink(next);
}

/** Every page of the session is confirmed: offer to choose the patient record (once; again if a page is added meanwhile). */
export function readyToLink(s: State): boolean {
  const pages = s.review?.progress.pages ?? [];
  const mine = s.order.filter((id) => !s.pages[id]?.superseded);
  return !s.link.proposal && !s.link.result && pages.length > 0 && pages.every((p) => p.state === 'VALIDATED') && mine.every((id) => pages.some((p) => p.page_id === id));
}

function offerLink(s: State): State {
  const ready = readyToLink(s);
  if (ready === s.link.offered) return s;
  const next = { ...s, link: { ...s.link, offered: ready } };
  return ready ? push(next, { from: 'bot', kind: 'finish_offer' }) : next;
}

/** The last message of a kind, if it is still the one with buttons: `offered`/`proposal` set and nothing decided. */
function openMsg(s: State, kind: 'finish_offer' | 'link'): number | undefined {
  if (s.link.result || (kind === 'finish_offer' ? !s.link.offered || s.link.proposal : !s.link.proposal)) return undefined;
  return [...s.messages].reverse().find((m) => m.kind === kind)?.id;
}
export const activeOfferMsg = (s: State) => openMsg(s, 'finish_offer');
export const activeLinkMsg = (s: State) => openMsg(s, 'link');

export interface LinkButton {
  id: 'patient' | 'create_new' | 'not_sure' | 'confirm_fiche' | 'retype';
  label: string;
  decision?: LinkDecision; // set for the three decisions; confirm_fiche / retype only act on the fiche number
}

/**
 * The buttons of a link question: one per candidate (the proposed one first and highlighted), « Nouvelle patiente », and
 * « Je ne suis pas sûre ». Confirming a doubtful fiche reading has its yes / no; typing the key has a form, no buttons.
 */
export function linkButtons(p: LinkProposal): LinkButton[] {
  const create: LinkButton = { id: 'create_new', label: t('match.create'), decision: { kind: 'create_new' } };
  const unsure: LinkButton = { id: 'not_sure', label: t('match.not_sure'), decision: { kind: 'not_sure' } };
  switch (p.question) {
    case 'need_key':
      return [];
    case 'confirm_fiche':
      return [{ id: 'confirm_fiche', label: t('match.confirm_yes') }, { id: 'retype', label: t('match.confirm_no') }];
    case 'propose':
      return [{ id: 'patient', label: t('match.pick_propose', { id: p.candidates[0].patient_id }), decision: { kind: 'patient', patient_id: p.candidates[0].patient_id } }, create, unsure];
    case 'create':
      return [create, unsure];
    case 'choose':
      return [...p.candidates.map((c): LinkButton => ({ id: 'patient', label: t('match.pick', { id: c.patient_id }), decision: { kind: 'patient', patient_id: c.patient_id } })), create, unsure];
  }
}

/** What the bot says once the decision is stored. */
export function linkResultText(r: LinkResult): string {
  if (r.status === 'not_sure' || !r.patient) return t('match.done_parked');
  const visits = r.visits ?? 1;
  return visits > 1 ? t('match.done_updated', { id: r.patient.id, n: visits }) : t('match.done_created', { id: r.patient.id });
}

/** Short label of a page in the page list. */
export function pageStateLabel(page: PageView, progress?: PageProgress): string {
  if (page.superseded) return t('pagestate.superseded');
  if (progress?.state === 'DUPLICATE_SUSPECTED') return t('pagestate.duplicate');
  if (progress && ['PATIENT_MATCHED', 'REGISTERED', 'SYNCED'].includes(progress.state)) return t('pagestate.registered');
  if (page.validated || progress?.state === 'VALIDATED') return t('pagestate.validated');
  if (page.failed) return t('pagestate.failed');
  if (page.fields === null) return t('pagestate.reading');
  return progress ? t('pagestate.progress', { done: progress.done, total: progress.total }) : t('pagestate.read');
}

/**
 * Label of a page that is (or was) in the local queue; null once the server has analysed it (pageStateLabel takes over).
 * `offline`: no connection right now. `sending`: this page is being uploaded.
 */
export function queueLabel(item: QueueEntry, ctx: { offline: boolean; sending: boolean; analysed: boolean }): string | null {
  switch (item.state) {
    case 'SYNC_FAILED':
      return t('queue.failed', { reason: errorText(item.error ?? 'http_error') });
    case 'UPLOADED':
      return ctx.analysed ? null : t('queue.sent');
    case 'CAPTURED':
      if (ctx.sending) return t('queue.sending');
      return ctx.offline || item.attempts > 0 ? t('queue.waiting') : t('queue.stored');
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'session_started': // a new session: its own page list, review and link (the conversation and its page views stay)
      return push({ ...initialState, messages: s.messages, pages: s.pages, session: a.session }, { from: 'bot', kind: 'text', key: 'msg.session_started' });
    case 'say':
      return push(s, { from: a.from, kind: 'text', ...('key' in a ? { key: a.key, params: a.params } : { text: a.text }) });
    case 'session_restored': {
      if (s.session) return s; // already restored (effects may run twice)
      let next: State = { ...s, session: a.session };
      for (const p of a.pages) next = patchPage({ ...next, order: [...next.order, p.id] }, p.id, () => ({ pageType: p.pageType }));
      for (const p of a.pages) if (p.replaces) next = patchPage(next, p.replaces, () => ({ superseded: true }));
      return push(next, { from: 'bot', kind: 'text', key: 'msg.session_restored' });
    }
    case 'page_added': {
      const added = patchPage({ ...s, order: [...s.order, a.pageId] }, a.pageId, () => ({ pageType: a.pageType }));
      return push(a.replaces ? patchPage(added, a.replaces, () => ({ superseded: true })) : added, {
        from: 'user',
        kind: 'text',
        key: a.replaces ? 'msg.photo_replaced' : 'msg.photo_saved',
        params: { type: a.pageType, pageType: a.pageType },
        hint: a.replaces ? 'msg.photo_replaced_hint' : 'msg.photo_saved_hint',
      });
    }
    case 'review_loaded':
      return onReview(s, a.queue);
    case 'event':
      return onEvent(s, a.event);
    case 'field_updated':
      return patchPage(s, a.pageId, (p) => ({ fields: p.fields?.map((f) => (f.field_id === a.field.field_id ? a.field : f)) ?? null }));
    case 'page_confirmed':
      return push(patchPage(s, a.pageId, () => ({ validated: true })), { from: 'bot', kind: 'text', key: 'msg.page_confirmed' });
    case 'link_proposal':
      return push({ ...s, link: { ...s.link, proposal: a.proposal } }, { from: 'bot', kind: 'link', proposal: a.proposal });
    case 'link_decided': {
      const done = push({ ...s, link: { ...s.link, result: a.result }, differences: a.result.differences }, { from: 'bot', kind: 'link_done', result: a.result });
      return a.result.differences.length ? push(done, { from: 'bot', kind: 'differences' }) : done;
    }
    case 'differences_updated':
      return { ...s, differences: a.differences };
    case 'reset':
      return initialState;
  }
}

/** Flagged ids (field_flagged) whose field still needs the midwife's attention. */
export function toReview(page: PageView): string[] {
  const open = new Set(
    page.fields
      ?.filter((f) => f.status === 'NEEDS_REVIEW' || f.status === 'UNKNOWN' || (f.status === 'ILLEGIBLE' && f.reason !== 'left_illegible'))
      .map((f) => f.field_id),
  );
  return page.flagged.filter((id) => open.has(id));
}

// Fields shown on a visit line of the record (when that visit's pages are the source of the retained value).
const KEY_FIELDS = ['p01.province', 'p02.age', 'p02.gestation', 'p02.parite', 'p03.ddr', 'p03.date_prevue_d_accouchement', 'p03.taille'];

/** Per visit (record order), the key values retained from that visit's own pages. */
export function keyValuesByVisit(record: PatientRecord): PatientRecord['values'][] {
  return record.visits.map((v) => record.values.filter((x) => KEY_FIELDS.includes(x.field_id) && v.pages.some((p) => p.page_id === x.source_page_id)));
}
