import 'fake-indexeddb/auto';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordPage } from '@care-agent/schema';
import { setAuth } from '../api';
import { setKey } from './crypto';
import { setReachable, setSimulated } from './network';
import { addPage, createLocalSession, listPages, listSessions, wipe, getBlob } from './store';
import { backoffMs, createSync } from './sync';

const USER = 'sf-01';
const SESSION = randomUUID();
const bytesOf = (n: number) => new TextEncoder().encode(`original image bytes ${n}`);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The server behind a fake fetch: stores sessions and pages by id (idempotent), with failure injection per request. */
class FakeServer {
  sessions = new Map<string, unknown>();
  pages = new Map<string, RecordPage>();
  order: string[] = []; // page ids as first received
  calls: string[] = [];
  down = false; // network cut: every request fails
  /** Called with the request path; returns what to do to this request. */
  inject: (path: string, body?: FormData | string) => 'cut-before' | 'cut-after' | 'abort' | 'sha-mismatch' | undefined = () => undefined;

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const path = url.replace('/api', '');
    this.calls.push(path);
    if (this.down) throw new TypeError('fetch failed');
    const body = init.body as FormData | string | undefined;
    const fault = this.inject(path, body);
    if (fault === 'cut-before') throw new TypeError('fetch failed');
    if (fault === 'abort') throw new DOMException('aborted', 'AbortError');
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/health') return reply(200, { status: 'ok', model: null });
    if (new Headers(init.headers).get('Authorization') !== 'Bearer tok') return reply(401, { code: 'unauthorized', text: 'x' });
    if (path === '/sessions') {
      const { id } = JSON.parse(body as string);
      if (!this.sessions.has(id)) this.sessions.set(id, JSON.parse(body as string));
      return reply(200, { id, midwife_id: USER, started_at: 't', page_ids: [] });
    }
    // /pages
    const form = body as FormData;
    const meta = JSON.parse(form.get('meta') as string) as RecordPage;
    const image = new Uint8Array(await (form.get('image') as Blob).arrayBuffer());
    if (!this.sessions.has(meta.session_id)) return reply(404, { code: 'session_not_found', text: 'x' });
    if (this.pages.has(meta.id)) {
      if (fault === 'cut-after') throw new TypeError('fetch failed');
      return reply(200, this.pages.get(meta.id));
    }
    if (sha(image) !== meta.sha256 || fault === 'sha-mismatch') return reply(409, { code: 'sha256_mismatch', text: 'x' });
    const stored = { ...meta, state: 'PENDING_AI' as const };
    this.pages.set(meta.id, stored);
    this.order.push(meta.id);
    if (fault === 'cut-after') throw new TypeError('fetch failed'); // stored, but the phone never got the answer
    return reply(200, stored);
  };
}

let server: FakeServer;
let clock: number;
const sync = () => {
  const s = createSync({ now: () => clock, rand: () => 0.5 });
  s.bind(USER);
  return s;
};

const capture = async (n: number): Promise<RecordPage> => {
  const bytes = bytesOf(n);
  const meta: RecordPage = { id: randomUUID(), session_id: SESSION, page_type: 3, captured_at: `2026-10-03T10:0${n}:00.000Z`, midwife_id: USER, sha256: sha(bytes), state: 'CAPTURED', flags: [] };
  await addPage(USER, meta, bytes, 'image/png');
  return meta;
};
const pages = () => listPages(USER);

beforeEach(async () => {
  await wipe();
  setKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  setAuth({ token: 'tok', role: 'midwife', userId: USER });
  setSimulated(false);
  setReachable(true);
  server = new FakeServer();
  clock = 1_000_000;
  vi.stubGlobal('fetch', server.fetch);
  await createLocalSession(USER, { id: SESSION, midwife_id: USER, started_at: 't', page_ids: [] }); // created offline, not on the server yet
});
afterEach(() => vi.unstubAllGlobals());

describe('backoff', () => {
  it('doubles from 1 s, is capped at 60 s, with jitter between half and the full delay', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 12].map((n) => backoffMs(n, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect([1, 2, 3, 7].map((n) => backoffMs(n, () => 0))).toEqual([500, 1000, 2000, 30000]);
  });
});

describe('sync engine', () => {
  it('(a) network cut before the session exists: page stays CAPTURED with attempts + backoff, then everything arrives', async () => {
    const meta = await capture(1);
    server.down = true;
    const s = sync();
    await s.kick();
    expect(await pages()).toMatchObject([{ state: 'CAPTURED', attempts: 1, nextAttemptAt: clock + 1000 * 0.75 }]);
    expect(server.sessions.size).toBe(0);
    // backoff not elapsed: nothing is tried (the probe fails too while the cut lasts)
    server.down = false;
    clock += 100;
    server.calls.length = 0;
    await s.kick();
    expect(server.calls).toEqual(['/health']);
    // connectivity back (online event = forced): session created, page uploaded, blob deleted
    await s.kick(true);
    expect(server.sessions.size).toBe(1);
    expect([...server.pages.keys()]).toEqual([meta.id]);
    expect(await pages()).toMatchObject([{ state: 'UPLOADED', server: 'PENDING_AI' }]);
    expect(await getBlob(meta.id)).toBeNull();
    expect((await listSessions(USER))[0].synced).toBe(true);
  });

  it('(b) request aborted during the upload (fetch rejects with AbortError, like the 30 s timeout): stays CAPTURED, later retried, exactly one page', async () => {
    const meta = await capture(1);
    server.inject = (path) => (path === '/pages' ? 'abort' : undefined);
    const s = sync();
    await s.kick();
    expect(await pages()).toMatchObject([{ state: 'CAPTURED', attempts: 1 }]);
    expect(server.pages.size).toBe(0);
    server.inject = () => undefined;
    await s.kick(true);
    expect([...server.pages.keys()]).toEqual([meta.id]);
    expect(await pages()).toMatchObject([{ state: 'UPLOADED' }]);
  });

  it('(c) server stored the page but the answer was lost: the replay stores nothing twice and the local item resolves', async () => {
    const meta = await capture(1);
    server.inject = (path) => (path === '/pages' ? 'cut-after' : undefined);
    const s = sync();
    await s.kick();
    expect(server.pages.size).toBe(1); // stored...
    expect(await pages()).toMatchObject([{ state: 'CAPTURED', attempts: 1 }]); // ...but the phone does not know
    server.inject = () => undefined;
    await s.kick(true);
    expect(server.pages.size).toBe(1);
    expect(server.order).toEqual([meta.id]);
    expect(await pages()).toMatchObject([{ state: 'UPLOADED', server: 'PENDING_AI' }]);
    expect(await getBlob(meta.id)).toBeNull();
  });

  it('a 5xx keeps the page queued like a network error', async () => {
    await capture(1);
    vi.stubGlobal('fetch', async () => new Response('bad gateway', { status: 502 }));
    await sync().kick();
    expect(await pages()).toMatchObject([{ state: 'CAPTURED', attempts: 1 }]);
  });

  it('409 sha mismatch: SYNC_FAILED with the code, record and bytes kept; Réessayer requeues and it goes through', async () => {
    const meta = await capture(1);
    server.inject = (path) => (path === '/pages' ? 'sha-mismatch' : undefined);
    const s = sync();
    await s.kick();
    expect(await pages()).toMatchObject([{ state: 'SYNC_FAILED', error: 'sha256_mismatch' }]);
    expect(await getBlob(meta.id)).not.toBeNull(); // never dropped
    server.calls.length = 0;
    await s.kick(true); // a failed page is not retried by itself
    expect(server.calls).toEqual([]);
    server.inject = () => undefined;
    await s.retry(meta.id);
    await s.kick(true);
    expect(await pages()).toMatchObject([{ state: 'UPLOADED', attempts: 0 }]);
    expect(server.pages.size).toBe(1);
  });

  it('a refused page does not block the pages behind it', async () => {
    const first = await capture(1);
    const second = await capture(2);
    server.inject = (path, body) => (path === '/pages' && (body as FormData).get('meta')!.toString().includes(first.id) ? 'sha-mismatch' : undefined);
    await sync().kick();
    expect(await pages()).toMatchObject([{ id: first.id, state: 'SYNC_FAILED' }, { id: second.id, state: 'UPLOADED' }]);
  });

  it('captured while offline (simulation), then online: no network call offline, uploaded in capture order', async () => {
    setSimulated(true);
    const metas = [await capture(1), await capture(2), await capture(3)];
    const s = sync();
    await s.kick();
    expect(server.calls).toEqual([]);
    expect(await pages()).toMatchObject([{ state: 'CAPTURED', attempts: 0 }, { state: 'CAPTURED' }, { state: 'CAPTURED' }]);
    setSimulated(false);
    await s.kick(true);
    expect(server.order).toEqual(metas.map((m) => m.id));
    expect((await pages()).every((p) => p.state === 'UPLOADED')).toBe(true);
    expect(server.calls.filter((c) => c === '/sessions')).toHaveLength(1);
  });

  it('an expired login (401) pauses the queue without failing or dropping the page', async () => {
    await capture(1);
    setAuth({ token: 'stale', role: 'midwife', userId: USER });
    const s = sync();
    const events: string[] = [];
    s.subscribe((e) => events.push(e.type));
    await s.kick();
    expect(events).toContain('auth_expired');
    expect(await pages()).toMatchObject([{ state: 'CAPTURED', attempts: 0 }]);
  });
});
