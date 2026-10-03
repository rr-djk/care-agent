import type { ExtractedField, RecordPage, ReviewQueue, Role, Session } from '@care-agent/schema';
import { ApiError } from './errors';
import * as fixtures from './fixtures';

const STORAGE_KEY = 'care-agent.auth';

/** PATCH body: confirm the read value, correct it, or keep it illegible. */
export type FieldEdit = { confirm: true } | { value: string | boolean | null } | { status: 'ILLEGIBLE' };
/** The updated field; `text_fr` says what the agent did not accept (failed rule, masked identifier). */
export type FieldResult = ExtractedField & { text_fr?: string };

export interface Auth {
  token: string;
  role: Role;
  userId: string;
}

// Bearer token: in memory, mirrored in sessionStorage so a reload keeps the login (cleared when the tab closes).
let auth: Auth | null = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');

export const getAuth = () => auth;

export function setAuth(next: Auth | null) {
  auth = next;
  if (next) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  else sessionStorage.removeItem(STORAGE_KEY);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (auth) headers.set('Authorization', `Bearer ${auth.token}`);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new ApiError('network', 'server unreachable');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.code ?? 'http_error', body.text ?? `HTTP ${res.status}`, body.field_ids);
  }
  return res;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const live = {
  async login(user_id: string, pin: string): Promise<Auth> {
    const { token, role } = await (await request('/login', json({ user_id, pin }))).json();
    return { token, role, userId: user_id };
  },
  async createSession(fiche_number?: string, facility?: string): Promise<Session> {
    return (await request('/sessions', json({ fiche_number: fiche_number || undefined, facility: facility || undefined }))).json();
  },
  async uploadPage(meta: RecordPage, image: File): Promise<RecordPage> {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('image', image);
    return (await request('/pages', { method: 'POST', body: form })).json();
  },
  /** NDJSON analysis stream of the session; never ends by itself, abort with the signal. */
  async openAnalysis(sessionId: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    return (await request(`/sessions/${sessionId}/analysis`, { signal })).body!;
  },
  async patchField(pageId: string, fieldId: string, edit: FieldEdit): Promise<FieldResult> {
    const init = { ...json(edit), method: 'PATCH' };
    return (await request(`/pages/${pageId}/fields/${encodeURIComponent(fieldId)}`, init)).json();
  },
  async getReview(sessionId: string): Promise<ReviewQueue> {
    return (await request(`/sessions/${sessionId}/review`)).json();
  },
  /** Switches a failed page to manual entry; the page_read event follows on the analysis stream. */
  async startManual(pageId: string): Promise<void> {
    await request(`/pages/${pageId}/manual`, { method: 'POST' });
  },
  /** NDJSON chat stream (token, ping, done, error) about the current review item. */
  async chat(body: { session_id: string; page_id?: string; field_id?: string; message: string }): Promise<ReadableStream<Uint8Array>> {
    return (await request('/chat', json(body))).body!;
  },
  async confirmPage(pageId: string): Promise<RecordPage> {
    return (await request(`/pages/${pageId}/confirm`, { method: 'POST' })).json();
  },
};

export const api: typeof live = import.meta.env.VITE_FIXTURES ? fixtures.api : live;
