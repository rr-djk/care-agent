// VITE_FIXTURES=1: canned API for building and testing the UI without the server or the model.
// Demo: the 1st page has one doubt and one illegible field; the 2nd fails (AI unavailable) and goes to manual entry;
// a retake gives a clean page. Rules are canned (the real ones live on the server).
import type { Aggregates, Difference, ExtractedField, LinkDecision, LinkProposal, LinkResult, PatientRecord, RecordPage, ReviewItem, ReviewQueue, Session, Status } from '@care-agent/schema';
import type { Auth, FieldEdit, FieldResult } from './api';
import { ApiError } from './errors';
import { fieldDef, fieldLabel } from './schemas';

const field = (field_id: string, value: ExtractedField['value'], status: Status, reason?: string): ExtractedField => ({
  field_id,
  value,
  status,
  confidence_signals: { validators_passed: status !== 'NEEDS_REVIEW', quality: 0.9 },
  source_page: 3,
  reason,
});

const READ = [
  field('p03.ddr', '12/03/2026', 'KNOWN'),
  field('p03.taille', '1582', 'NEEDS_REVIEW'),
  field('p03.groupage_a', true, 'KNOWN'),
  field('p03.groupage_b', false, 'KNOWN'),
  field('p03.date_de_depassement_de_terme', '28/12/2026', 'KNOWN'),
  field('p03.rendez_vous.v1_t1', '02/04/2026', 'KNOWN'),
  field('p03.glucosurie.v1_t1', null, 'ILLEGIBLE'),
];
const MANUAL = [
  field('p03.ddr', null, 'UNKNOWN', 'manual'),
  field('p03.taille', null, 'UNKNOWN', 'manual'),
  field('p03.groupage_a', false, 'KNOWN'),
  field('p03.groupage_b', true, 'KNOWN'),
  field('p03.rendez_vous.v1_t1', null, 'NOT_PROVIDED'),
  field('p03.glucosurie.v1_t1', null, 'UNKNOWN', 'manual'),
];
const CLEAN = READ.map((f) => (f.status === 'KNOWN' ? f : { ...f, value: f.field_id === 'p03.taille' ? '158' : 'Neg', status: 'KNOWN' as const }));

interface FixturePage {
  id: string;
  type: number;
  fields: ExtractedField[];
  state: RecordPage['state'];
  superseded: boolean;
  reviewed: Set<string>; // flagged fields already handled (progress count)
}
let pages: FixturePage[] = [];
let uploads = 0;
let sessionId = '';
let emit: (event: object) => void = () => {};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (code: string, text: string, field_ids?: string[]): never => {
  throw new ApiError(code, text, field_ids);
};
const find = (id: string) => pages.find((p) => p.id === id) ?? fail('not_found', 'page not found');
const isPending = (f: ExtractedField) => f.status === 'NEEDS_REVIEW' || f.status === 'UNKNOWN' || (f.status === 'ILLEGIBLE' && f.reason !== 'left_illegible');
const OPEN = ['NEEDS_REVIEW', 'MANUAL_REVIEW_REQUIRED'];

function item(page: FixturePage, f: ExtractedField): ReviewItem {
  const label = fieldLabel(f.field_id);
  const has = f.value !== null && f.value !== '';
  const [kind, reason_code, text_fr] =
    f.status === 'ILLEGIBLE'
      ? (['illegible', 'illegible', `${label} est illisible pour moi. Quelle est la valeur ?`] as const)
      : f.status === 'UNKNOWN'
        ? (['manual', 'manual', `Il y a de l'écriture pour ${label}. Quelle est la valeur ?`] as const)
        : f.reason === 'corrected'
          ? (['doubt', 'unusual_value', `Vous avez saisi « ${f.value} » pour ${label}, mais la valeur semble inhabituelle. Pouvez-vous vérifier ?`] as const)
          : (['doubt', 'unusual_value', `J'ai lu « ${f.value} » pour ${label}, mais la valeur semble inhabituelle. Pouvez-vous vérifier ?`] as const);
  return { page_id: page.id, field_id: f.field_id, kind, label_fr: label, value: f.value, reason_code, text_fr, actions: [...(has ? ['confirm' as const] : []), 'correct', 'retake', 'leave_illegible'] };
}

function review(): ReviewQueue {
  const queue: ReviewQueue = { items: [], progress: { total: 0, done: 0, pages: [] } };
  for (const p of pages.filter((p) => !p.superseded)) {
    const open = OPEN.includes(p.state) ? p.fields.filter(isPending) : [];
    queue.items.push(...open.map((f) => item(p, f)));
    const total = open.length + p.fields.filter((f) => !isPending(f) && p.reviewed.has(f.field_id)).length;
    queue.progress.pages.push({ page_id: p.id, page_type: p.type, state: p.state, total, done: total - open.length });
    queue.progress.total += total;
    queue.progress.done += total - open.length;
  }
  return queue;
}

/** Canned rule: Taille must be 120-200 cm, everything else is accepted. */
function edit(pageId: string, fieldId: string, e: FieldEdit): FieldResult {
  const page = find(pageId);
  const old = page.fields.find((f) => f.field_id === fieldId) ?? fail('not_found', 'field not found');
  page.reviewed.add(fieldId);
  let next: FieldResult;
  if ('confirm' in e) next = { ...old, status: 'KNOWN', reason: undefined };
  else if ('status' in e) next = { ...old, value: null, status: 'ILLEGIBLE', reason: 'left_illegible' };
  else if (fieldId === 'p03.taille' && !(Number.parseFloat(String(e.value)) >= 120 && Number.parseFloat(String(e.value)) <= 200)) {
    next = { ...old, value: String(e.value), status: 'NEEDS_REVIEW', reason: 'corrected', text_fr: `« ${e.value} » ne convient pas pour Taille (attendu : entre 120 et 200 cm). Le champ reste à vérifier.` };
  } else next = { ...old, value: e.value, status: 'KNOWN', reason: undefined };
  const { text_fr: _t, ...stored } = next;
  page.fields = page.fields.map((f) => (f.field_id === fieldId ? stored : f));
  return next;
}

export const api = {
  async login(user_id: string, pin: string): Promise<Auth> {
    await delay(200);
    if (pin !== '123456') fail('invalid_credentials', 'invalid credentials');
    return { token: 'fixture', role: user_id.startsWith('sup') ? 'supervisor' : 'midwife', userId: user_id }; // sup-01 opens the dashboard
  },
  async createSession(session: Session): Promise<Session> {
    if (session.id !== sessionId) {
      pages = [];
      uploads = 0;
      sessionId = session.id;
    }
    return session;
  },
  async health(): Promise<void> {},
  async uploadPage(meta: RecordPage, _image: Blob): Promise<RecordPage> {
    uploads++;
    const broken = !meta.replaces && uploads % 2 === 0; // every second new page: the AI is unavailable
    const page: FixturePage = { id: meta.id, type: meta.page_type ?? 3, fields: meta.replaces ? CLEAN : READ, state: 'PENDING_AI', superseded: false, reviewed: new Set() };
    const old = meta.replaces ? pages.find((p) => p.id === meta.replaces) : undefined;
    if (old) old.superseded = true;
    pages.push(page);
    emit({ type: 'page_received', page_id: meta.id });
    setTimeout(() => {
      if (broken) {
        page.state = 'PROCESSING_FAILED';
        emit({ type: 'error', code: 'model_unreachable', text: `page ${meta.id} failed`, page_id: meta.id });
      } else {
        page.state = 'NEEDS_REVIEW';
        emit({ type: 'page_read', page_id: meta.id, fields: page.fields });
        for (const f of page.fields.filter((f) => f.status === 'NEEDS_REVIEW' || f.status === 'ILLEGIBLE')) {
          emit({ type: 'field_flagged', page_id: meta.id, field_id: f.field_id, reason: f.status });
        }
      }
      emit({ type: 'record_ready', record_id: meta.session_id });
    }, 1200);
    return { ...meta, state: 'PENDING_AI' }; // same sha256 back, like the server
  },
  async openAnalysis(_sessionId: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) {
        emit = (event) => c.enqueue(enc.encode(`${JSON.stringify(event)}\n`));
        signal.addEventListener('abort', () => c.close());
      },
    });
  },
  async patchField(pageId: string, fieldId: string, e: FieldEdit): Promise<FieldResult> {
    return edit(pageId, fieldId, e);
  },
  async getReview(_sessionId: string): Promise<ReviewQueue> {
    return review();
  },
  async startManual(pageId: string): Promise<void> {
    const page = find(pageId);
    page.fields = MANUAL;
    page.state = 'MANUAL_REVIEW_REQUIRED';
    setTimeout(() => emit({ type: 'page_read', page_id: pageId, fields: MANUAL }), 300);
  },
  async chat(body: { page_id?: string; field_id?: string; message: string }): Promise<ReadableStream<Uint8Array>> {
    const page = pages.find((p) => p.id === body.page_id);
    const f = page?.fields.find((x) => x.field_id === body.field_id);
    const m = body.message.trim().toLowerCase();
    let reply = "Je n'ai pas compris. Tapez la valeur, ou utilisez les boutons.";
    if (page && f) {
      const label = fieldDef(f.field_id)?.label_fr ?? f.field_id;
      if (/^(ok|c.est bon|oui c.est ça)$/.test(m) && f.value) reply = `${label} confirmé : ${edit(page.id, f.field_id, { confirm: true }).value}.`;
      else if (/illisible|je ne sais pas/.test(m)) (edit(page.id, f.field_id, { status: 'ILLEGIBLE' }), (reply = `${label} reste illisible.`));
      else if (/^\d+([.,]\d+)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(m)) {
        const r = edit(page.id, f.field_id, { value: m.replace(',', '.') });
        reply = r.text_fr ?? `C’est noté : ${label} = ${r.value}.`;
      }
    }
    const enc = new TextEncoder();
    const lines = [...(reply.match(/\S+\s*/g) ?? []).map((text) => ({ type: 'token', text })), { type: 'done' }];
    return new ReadableStream({
      async start(c) {
        for (const l of lines) {
          await delay(40);
          c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
        }
        c.close();
      },
    });
  },
  async confirmPage(pageId: string): Promise<RecordPage> {
    const page = find(pageId);
    const open = page.fields.filter((f) => f.status === 'NEEDS_REVIEW').map((f) => f.field_id);
    if (open.length) fail('fields_need_review', 'fields still need review', open);
    page.state = 'VALIDATED';
    return { id: pageId, state: 'VALIDATED' } as RecordPage;
  },
  // Canned linking: the fiche is read as 2026-711-003 at "DR Tahannaout Sud"; the first decision creates PAT-000001.
  async getProposal(sessionId: string): Promise<LinkProposal> {
    return {
      session_id: sessionId,
      fiche: { value: '2026-711-003', source: 'cover', low_confidence: false },
      facility: 'DR Tahannaout Sud',
      question: 'create',
      text_fr: 'Aucun dossier ne correspond à la fiche 2026-711-003 (DR Tahannaout Sud). Créer un nouveau dossier ?',
      candidates: [],
    };
  },
  async setSessionKey(sessionId: string): Promise<LinkProposal> {
    return this.getProposal(sessionId);
  },
  async link(_sessionId: string, decision: LinkDecision): Promise<LinkResult> {
    for (const p of pages) p.state = decision.kind === 'not_sure' ? 'DUPLICATE_SUSPECTED' : 'REGISTERED';
    if (decision.kind === 'not_sure') return { status: 'not_sure', differences: [] };
    return { status: 'linked', patient: { id: 'PAT-000001', fiche_number: '2026-711-003', facility: 'DR Tahannaout Sud', created_at: new Date().toISOString() }, visits: 1, differences: [] };
  },
  async saveChoices(): Promise<Difference[]> {
    return [];
  },
  async acknowledge(): Promise<void> {},
  async getPatient(id: string): Promise<PatientRecord> {
    const now = new Date().toISOString();
    return {
      patient: { id, fiche_number: '2026-711-003', facility: 'DR Tahannaout Sud', created_at: now },
      visits: [{ session_id: sessionId, date: now, pages: pages.map((p) => ({ page_id: p.id, page_type: p.type, captured_at: now, state: p.state })) }],
      values: [{ page_type: 3, field_id: 'p03.ddr', label_fr: 'DDR', value: '12/03/2026', source_page_id: pages[0]?.id ?? '', source_date: now }],
    };
  },
  async getStats(): Promise<Aggregates> {
    const bins = (labels: string[], counts: (number | null)[]) => labels.map((label_fr, k) => ({ label_fr, count: counts[k] }));
    return {
      source: 'records',
      source_fr: 'Dossiers validés et reliés (exemple)',
      blocks: [
        { id: 'bp_systolic', title_fr: 'Tension artérielle systolique (mmHg)', n: 40, bins: bins(['< 120', '120 à 139', '140 à 159', '≥ 160'], [18, 15, 7, null]) },
        { id: 'hiv', title_fr: 'Sérologie VIH', n: 30, bins: bins(['Négatif', 'Positif'], [30, 0]) },
      ],
    };
  },
  async getReferenceStats(): Promise<Aggregates | null> {
    return null;
  },
};
