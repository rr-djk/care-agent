// VITE_FIXTURES=1: canned API for building and testing the UI without the server or the model.
import type { ExtractedField, RecordPage, Session, Status } from '@care-agent/schema';
import type { Auth } from './api';
import { ApiError } from './errors';

const field = (field_id: string, value: ExtractedField['value'], status: Status): ExtractedField => ({
  field_id,
  value,
  status,
  confidence_signals: { validators_passed: status === 'KNOWN', quality: 0.9 },
  source_page: 3,
});

const FIELDS = [
  field('p03.ddr', '12/03/2026', 'KNOWN'),
  field('p03.taille', '1582', 'NEEDS_REVIEW'),
  field('p03.groupage_a', true, 'KNOWN'),
  field('p03.groupage_b', null, 'ILLEGIBLE'),
  field('p03.groupage_o', false, 'KNOWN'),
  field('p03.rh_plus', null, 'UNKNOWN'),
  field('p03.date_prevue_d_accouchement', '19/12/2026', 'NEEDS_REVIEW'),
  field('p03.rendez_vous.v1_t1', '02/04/2026', 'KNOWN'),
];

let fields: ExtractedField[] = FIELDS;
let emit: (event: object) => void = () => {};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (code: string, text: string, field_ids?: string[]): never => {
  throw new ApiError(code, text, field_ids);
};

export const api = {
  async login(user_id: string, pin: string): Promise<Auth> {
    await delay(200);
    if (pin !== '123456') fail('invalid_credentials', 'invalid credentials');
    return { token: 'fixture', role: 'midwife', userId: user_id };
  },
  async createSession(fiche_number?: string, facility?: string): Promise<Session> {
    return { id: 'fixture-session', midwife_id: 'sf-01', fiche_number, facility, started_at: new Date().toISOString(), page_ids: [] };
  },
  async uploadPage(meta: RecordPage, _image: File): Promise<RecordPage> {
    fields = FIELDS;
    emit({ type: 'page_received', page_id: meta.id });
    setTimeout(() => {
      emit({ type: 'page_read', page_id: meta.id, fields });
      for (const f of fields.filter((f) => f.status === 'NEEDS_REVIEW' || f.status === 'ILLEGIBLE')) {
        emit({ type: 'field_flagged', page_id: meta.id, field_id: f.field_id, reason: 'fixture' });
      }
      emit({ type: 'record_ready', record_id: meta.session_id });
    }, 1500);
    return { ...meta, state: 'PENDING_AI' };
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
  async patchField(_pageId: string, fieldId: string, value: string | boolean | null): Promise<ExtractedField> {
    fields = fields.map((f) => (f.field_id === fieldId ? { ...f, value, status: 'KNOWN' as const } : f));
    return fields.find((f) => f.field_id === fieldId)!;
  },
  async confirmPage(pageId: string): Promise<RecordPage> {
    const open = fields.filter((f) => f.status === 'NEEDS_REVIEW').map((f) => f.field_id);
    if (open.length) fail('fields_need_review', 'fields still need review', open);
    return { id: pageId, state: 'VALIDATED' } as RecordPage;
  },
};
