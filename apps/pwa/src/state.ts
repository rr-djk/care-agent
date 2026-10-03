import type { ExtractedField, Session, Status, StreamEvent } from '@care-agent/schema';

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
};

export const errorText = (code: string) => ERRORS[code] ?? 'Une erreur est survenue.';

export type Msg =
  | { id: number; from: 'bot' | 'user'; kind: 'text'; text: string; hint?: string }
  | { id: number; from: 'bot'; kind: 'summary'; pageId: string };

export interface PageView {
  id: string;
  pageType?: number;
  fields: ExtractedField[] | null; // null until page_read
  flagged: string[]; // field ids announced by field_flagged
  failed: boolean;
  validated: boolean;
}

export interface State {
  session: Session | null;
  messages: Msg[];
  pages: Record<string, PageView>;
}

export const initialState: State = { session: null, messages: [], pages: {} };

export type Action =
  | { type: 'session_started'; session: Session }
  | { type: 'say'; from: 'bot' | 'user'; text: string; hint?: string }
  | { type: 'page_added'; pageId: string; pageType: number }
  | { type: 'event'; event: StreamEvent }
  | { type: 'field_updated'; pageId: string; field: ExtractedField }
  | { type: 'page_confirmed'; pageId: string }
  | { type: 'reset' };

type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

const push = (s: State, msg: NewMsg): State => ({ ...s, messages: [...s.messages, { ...msg, id: s.messages.length } as Msg] });

const newPage = (id: string, pageType?: number): PageView => ({ id, pageType, fields: null, flagged: [], failed: false, validated: false });

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

function onEvent(s: State, e: StreamEvent): State {
  switch (e.type) {
    case 'page_received':
      return push(patchPage(s, e.page_id, () => ({})), {
        from: 'bot',
        kind: 'text',
        text: 'Page reçue, analyse en cours…',
        hint: "Sur ordinateur sans carte graphique, l'analyse prend plusieurs minutes.",
      });
    case 'page_read':
      return push(patchPage(s, e.page_id, () => ({ fields: e.fields })), { from: 'bot', kind: 'summary', pageId: e.page_id });
    case 'field_flagged':
      return patchPage(s, e.page_id, (p) => ({ flagged: [...p.flagged, e.field_id] }));
    case 'error': {
      const text = errorText(e.code);
      return push(e.page_id ? patchPage(s, e.page_id, () => ({ failed: true })) : s, { from: 'bot', kind: 'text', text });
    }
    case 'record_ready':
      return push(s, { from: 'bot', kind: 'text', text: 'Toutes les pages sont analysées.' });
    default:
      return s; // chat tokens and pings: step 8
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'session_started':
      return push({ ...s, session: a.session }, { from: 'bot', kind: 'text', text: 'Session démarrée. Photographiez une page du registre.' });
    case 'say':
      return push(s, { from: a.from, kind: 'text', text: a.text, hint: a.hint });
    case 'page_added':
      return push(patchPage(s, a.pageId, () => ({ pageType: a.pageType })), {
        from: 'user',
        kind: 'text',
        text: `Photo envoyée : page ${a.pageType}, ${pageLabel(a.pageType)}`,
      });
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
  const open = new Set(page.fields?.filter((f) => f.status === 'NEEDS_REVIEW' || f.status === 'ILLEGIBLE').map((f) => f.field_id));
  return page.flagged.filter((id) => open.has(id));
}
