import type { ExtractedField, RecordPage, ReviewQueue, Role, Session } from '@care-agent/schema';
import { ApiError } from './errors';
import * as fixtures from './fixtures';
import { netBlocked, setReachable } from './offline/network';

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

// Bearer token: in memory only. The encrypted copy lives in the device vault (offline/store.ts), unlocked with the PIN.
let auth: Auth | null = null;

export const getAuth = () => auth;

export function setAuth(next: Auth | null) {
  auth = next;
}

const REQUEST_TIMEOUT_MS = 30_000; // headers must arrive in time (the NDJSON stream only needs its headers)

async function request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  if (netBlocked()) throw new ApiError('network', 'offline mode'); // simulation or browser offline: no network call at all
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (auth) headers.set('Authorization', `Bearer ${auth.token}`);
  const ac = new AbortController();
  const stop = () => ac.abort();
  rest.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...rest, headers, signal: ac.signal });
  } catch (e) {
    if (rest.signal?.aborted) throw e;
    setReachable(false);
    throw new ApiError('network', 'server unreachable');
  } finally {
    clearTimeout(timer);
  }
  setReachable(res.status < 500); // a 5xx from the dev proxy means the server is down
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.code ?? 'http_error', body.text ?? `HTTP ${res.status}`, body.field_ids, res.status);
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
  /** Idempotent by `session.id` (created on the phone, possibly offline). */
  async createSession(session: Session): Promise<Session> {
    const { id, fiche_number, facility } = session;
    return (await request('/sessions', json({ id, fiche_number, facility }))).json();
  },
  /** Cheap reachability probe for the sync engine. */
  async health(): Promise<void> {
    await request('/health', { timeoutMs: 3_000 });
  },
  async uploadPage(meta: RecordPage, image: Blob): Promise<RecordPage> {
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
