import type { ExtractedField, PageProgress, ReviewItem, ReviewQueue, Session, Status, StreamEvent } from '@care-agent/schema';

export const PAGE_TYPES = [
  { type: 1, label: 'Couverture' },
  { type: 2, label: 'Identification' },
  { type: 3, label: 'Grossesse' },
  { type: 4, label: 'Accouchement' },
  { type: 5, label: 'Post-partum mère' },
  { type: 6, label: 'Post-partum nouveau-né' },
  { type: 7, label: 'Post-partum mère tardif' },
  { type: 8, label: 'Nouveau-né tardif' },
] as const;

export const pageLabel = (type: number | undefined) => PAGE_TYPES.find((p) => p.type === type)?.label ?? 'Page';

export const STATUS_FR: Record<Status, string> = {
  KNOWN: 'lu',
  NEEDS_REVIEW: 'à vérifier',
  ILLEGIBLE: 'illisible',
  UNKNOWN: 'non lu',
  NOT_PROVIDED: 'non renseigné',
  NOT_APPLICABLE: 'non applicable',
};

// Order of the flagged fields in a page summary.
const FLAGGED: Status[] = ['NEEDS_REVIEW', 'ILLEGIBLE', 'UNKNOWN'];

const ERRORS: Record<string, string> = {
  page_type_required: 'Choisissez le type de page avant de la photographier.',
  page_type_unsupported: "Ce type de page n'est pas encore pris en charge.",
  model_unreachable: "Le modèle d'analyse est injoignable. Réessayez plus tard.",
  model_http: "Le modèle d'analyse a renvoyé une erreur.",
  model_timeout: "L'analyse a pris trop de temps.",
  analysis_failed: "L'analyse de cette page a échoué.",
  bad_event: "Message illisible reçu du serveur.",
  invalid_credentials: 'Identifiant ou code PIN incorrect.',
  unauthorized: 'Session expirée, reconnectez-vous.',
  session_not_found: 'Session introuvable, démarrez une nouvelle session.',
  sha256_mismatch: "La photo a été corrompue pendant l'envoi, reprenez-la.",
  page_not_editable: "Cette page n'est plus modifiable.",
  illegal_transition: "Cette page ne peut pas être confirmée dans son état actuel.",
  network: 'Serveur injoignable. Vérifiez la connexion.',
  chat_failed: "Je n'ai pas pu traiter ce message.",
  page_not_failed: "Cette page n'est pas en échec.",
  manual_unavailable: "La saisie manuelle n'est pas disponible.",
  bad_request: "Cette demande n'a pas pu être traitée.",
  http_error: 'Le serveur a répondu par une erreur.',
  invalid_meta: 'Les informations de la page sont invalides.',
  not_found: 'Page ou ressource introuvable sur le serveur.',
  forbidden: "Ce compte n'a pas le droit d'envoyer cette page.",
  session_id_taken: 'Cette session appartient à un autre compte.',
  local_data_missing: "L'image n'est plus sur l'appareil.",
  wrong_pin: 'Code PIN incorrect.',
  no_token: 'Vous êtes déconnecté : connectez-vous en ligne.',
  device_pin_mismatch: "Ce code PIN diffère de celui de cet appareil, qui garde des pages non envoyées. Utilisez l'ancien code.",
};

export const errorText = (code: string) => ERRORS[code] ?? 'Une erreur est survenue.';

export type Msg =
  | { id: number; from: 'bot' | 'user'; kind: 'text'; text: string; hint?: string; streaming?: boolean }
  | { id: number; from: 'bot'; kind: 'summary'; pageId: string }
  | { id: number; from: 'bot'; kind: 'item'; item: ReviewItem } // one review question; buttons only while it is the current one
  | { id: number; from: 'bot'; kind: 'page_clear'; pageId: string } // "Tout est vérifié pour la page N" + Confirmer la page
  | { id: number; from: 'bot'; kind: 'manual_offer'; pageId: string }; // the AI failed: « Saisie manuelle »

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
}

export const initialState: State = { session: null, messages: [], pages: {}, order: [], review: null, shown: null, seen: {} };

export type Action =
  | { type: 'session_started'; session: Session }
  | { type: 'say'; from: 'bot' | 'user'; text: string; hint?: string }
  | { type: 'session_restored'; session: Session; pages: { id: string; pageType?: number; replaces?: string }[] }
  | { type: 'page_added'; pageId: string; pageType: number; replaces?: string }
  | { type: 'review_loaded'; queue: ReviewQueue }
  | { type: 'event'; event: StreamEvent }
  | { type: 'field_updated'; pageId: string; field: ExtractedField }
  | { type: 'page_confirmed'; pageId: string }
  | { type: 'reset' };

type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

const push = (s: State, msg: NewMsg): State => ({ ...s, messages: [...s.messages, { ...msg, id: s.messages.length } as Msg] });

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
      return push(patchPage(s, e.page_id, () => ({})), {
        from: 'bot',
        kind: 'text',
        text: 'Page reçue, analyse en cours…',
        hint: "Sur ordinateur sans carte graphique, l'analyse prend plusieurs minutes.",
      });
    case 'page_read':
      return push(patchPage(s, e.page_id, () => ({ fields: e.fields, failed: false })), { from: 'bot', kind: 'summary', pageId: e.page_id });
    case 'field_flagged':
      return patchPage(s, e.page_id, (p) => ({ flagged: [...p.flagged, e.field_id] }));
    case 'error': {
      const failed = push(e.page_id ? patchPage(s, e.page_id, () => ({ failed: true, failCode: e.code })) : s, { from: 'bot', kind: 'text', text: errorText(e.code) });
      return e.page_id && e.code.startsWith('model_') ? push(failed, { from: 'bot', kind: 'manual_offer', pageId: e.page_id }) : failed;
    }
    case 'token': {
      const last = s.messages.at(-1);
      if (last?.kind === 'text' && last.streaming) return { ...s, messages: [...s.messages.slice(0, -1), { ...last, text: last.text + e.text }] };
      return push(s, { from: 'bot', kind: 'text', text: e.text, streaming: true });
    }
    case 'done': {
      const last = s.messages.at(-1);
      return last?.kind === 'text' && last.streaming ? { ...s, messages: [...s.messages.slice(0, -1), { ...last, streaming: false }] } : s;
    }
    case 'record_ready':
      return push(s, { from: 'bot', kind: 'text', text: 'Toutes les pages sont analysées.' });
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
  if (head && itemKey(head) !== next.shown) return { ...push(next, { from: 'bot', kind: 'item', item: head }), shown: itemKey(head) };
  return head ? next : { ...next, shown: null };
}

/** Short label of a page in the page list. */
export function pageStateLabel(page: PageView, progress?: PageProgress): string {
  if (page.superseded) return 'remplacée';
  if (page.validated || progress?.state === 'VALIDATED') return 'validée';
  if (page.failed) return 'échec';
  if (page.fields === null) return 'analyse en cours';
  return progress ? `${progress.done}/${progress.total} vérifiés` : 'lue';
}

/**
 * Label of a page that is (or was) in the local queue; null once the server has analysed it (pageStateLabel takes over).
 * `offline`: no connection right now. `sending`: this page is being uploaded.
 */
export function queueLabel(item: QueueEntry, ctx: { offline: boolean; sending: boolean; analysed: boolean }): string | null {
  switch (item.state) {
    case 'SYNC_FAILED':
      return `Échec d'envoi : ${errorText(item.error ?? 'http_error')}`;
    case 'UPLOADED':
      return ctx.analysed ? null : 'Envoyée — analyse en cours';
    case 'CAPTURED':
      if (ctx.sending) return 'Envoi en cours…';
      return ctx.offline || item.attempts > 0 ? 'En attente de traitement IA' : "Enregistrée sur l'appareil (chiffrée)";
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'session_started':
      return push({ ...s, session: a.session }, { from: 'bot', kind: 'text', text: 'Session démarrée. Photographiez une page du registre.' });
    case 'say':
      return push(s, { from: a.from, kind: 'text', text: a.text, hint: a.hint });
    case 'session_restored': {
      if (s.session) return s; // already restored (effects may run twice)
      let next: State = { ...s, session: a.session };
      for (const p of a.pages) next = patchPage({ ...next, order: [...next.order, p.id] }, p.id, () => ({ pageType: p.pageType }));
      for (const p of a.pages) if (p.replaces) next = patchPage(next, p.replaces, () => ({ superseded: true }));
      return push(next, { from: 'bot', kind: 'text', text: 'Session reprise. Les pages en attente seront envoyées dès que la connexion le permet.' });
    }
    case 'page_added': {
      const added = patchPage({ ...s, order: [...s.order, a.pageId] }, a.pageId, () => ({ pageType: a.pageType }));
      return push(a.replaces ? patchPage(added, a.replaces, () => ({ superseded: true })) : added, {
        from: 'user',
        kind: 'text',
        text: `${a.replaces ? 'Nouvelle photo enregistrée' : 'Photo enregistrée'} : page ${a.pageType}, ${pageLabel(a.pageType)}`,
        hint: `Enregistrée sur l'appareil (chiffrée), envoyée dès que la connexion le permet.${a.replaces ? ' Elle remplace la photo précédente.' : ''}`,
      });
    }
    case 'review_loaded':
      return onReview(s, a.queue);
    case 'event':
      return onEvent(s, a.event);
    case 'field_updated':
      return patchPage(s, a.pageId, (p) => ({ fields: p.fields?.map((f) => (f.field_id === a.field.field_id ? a.field : f)) ?? null }));
    case 'page_confirmed':
      return push(patchPage(s, a.pageId, () => ({ validated: true })), { from: 'bot', kind: 'text', text: 'Page confirmée.' });
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
