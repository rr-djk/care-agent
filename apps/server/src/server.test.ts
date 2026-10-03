import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { parseEvent, type ExtractedField } from '@care-agent/schema';
import { createApp } from './app';
import { seedUsers } from './auth';
import { openDb } from './db';
import { transition } from './lifecycle';
import { openOriginals } from './originals';
import { EventStore } from './stream';
import { createWorker, AnalysisError, type Analyzer } from './worker';

const field = (field_id: string, status: ExtractedField['status'], value: string | null = 'x'): ExtractedField => ({
  field_id,
  value,
  status,
  confidence_signals: { validators_passed: true, quality: 1 },
  source_page: 2,
});
const FIELDS = [field('a', 'KNOWN'), field('b', 'NEEDS_REVIEW'), field('c', 'ILLEGIBLE', null)];
const okAnalyzer: Analyzer = async () => FIELDS;

async function setup(analyzer: Analyzer | null = okAnalyzer) {
  const dataDir = mkdtempSync(join(tmpdir(), 'care-agent-test-'));
  process.env.ORIGINALS_KEY = 'ab'.repeat(32);
  const db = openDb(dataDir);
  const originals = openOriginals(dataDir);
  const events = new EventStore(db);
  const worker = createWorker({ db, originals, events }, analyzer ?? undefined);
  const jobs: Promise<void>[] = [];
  const enqueue = worker.enqueue;
  worker.enqueue = (id) => {
    const job = enqueue(id);
    jobs.push(job);
    return job;
  };
  const app = createApp({ db, originals, events, worker, model: 'fake' });
  const pins = Object.fromEntries(seedUsers(db, dataDir).map((u) => [u.id, u.pin]));

  const tokens: Record<string, string> = {};
  const login = async (user: string) => {
    const res = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ user_id: user, pin: pins[user] }) });
    tokens[user] = (await res.json()).token;
  };
  await Promise.all(['sf-01', 'sf-02', 'sup-01'].map(login));
  const call = (user: string, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${tokens[user]}` } });
  const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer();
  const newSession = async (user = 'sf-01') => (await (await call(user, '/api/sessions', { method: 'POST', ...json({ fiche_number: '12' }) })).json()).id as string;
  const upload = (user: string, sessionId: string, id: string, over: Record<string, unknown> = {}, bytes = png) => {
    const form = new FormData();
    form.set(
      'meta',
      JSON.stringify({
        id,
        session_id: sessionId,
        page_type: 2,
        captured_at: '2026-10-03T10:00:00.000Z',
        midwife_id: user,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        state: 'CAPTURED',
        flags: [],
        ...over,
      }),
    );
    form.set('image', new File([new Uint8Array(bytes)], 'p.png', { type: 'image/png' }));
    return call(user, '/api/pages', { method: 'POST', body: form });
  };
  const count = (table: string, where = '1') => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
  return { dataDir, db, app, call, json, png, newSession, upload, count, settle: () => Promise.all(jobs), seed: pins };
}

test('login: ok, wrong PIN, unknown user, protected routes', async () => {
  const t = await setup();
  const ok = await t.app.request('/api/login', { method: 'POST', body: JSON.stringify({ user_id: 'sup-01', pin: t.seed['sup-01'] }) });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.role, 'supervisor');
  assert.match(body.token, /^[0-9a-f]{64}$/);
  for (const bad of [{ user_id: 'sup-01', pin: 'nope' }, { user_id: 'ghost', pin: '000000' }, {}]) {
    const res = await t.app.request('/api/login', { method: 'POST', body: JSON.stringify(bad) });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'invalid_credentials');
  }
  assert.equal((await t.app.request('/api/health')).status, 200);
  assert.equal((await t.app.request('/api/pages/x')).status, 401);
  assert.equal((await t.app.request('/api/pages/x', { headers: { Authorization: 'Bearer nope' } })).status, 401);
});

test('upload replay: one page, one original, one PENDING_AI transition; sha mismatch is 409', async () => {
  const t = await setup();
  const sid = await t.newSession();
  const id = randomUUID();
  const first = await t.upload('sf-01', sid, id);
  assert.equal(first.status, 200);
  const page = await first.json();
  assert.equal(page.state, 'PENDING_AI');
  const second = await t.upload('sf-01', sid, id);
  assert.equal(second.status, 200);
  const replayed = await second.json();
  assert.deepEqual([replayed.id, replayed.sha256], [id, page.sha256]); // the stored page (its state may have moved on)
  await t.settle();
  assert.equal(t.count('pages'), 1);
  assert.equal(readdirSync(join(t.dataDir, 'originals')).length, 1);
  assert.equal(t.count('page_transitions', "to_state = 'PENDING_AI'"), 1);
  assert.equal(t.count('events', "json LIKE '%page_received%'"), 1);

  const bad = await t.upload('sf-01', sid, randomUUID(), { sha256: '0'.repeat(64) });
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).code, 'sha256_mismatch');
  assert.equal(t.count('pages'), 1);
  assert.equal((await t.upload('sf-02', sid, randomUUID())).status, 404); // not her session
  assert.equal((await t.upload('sup-01', sid, randomUUID(), { midwife_id: 'sup-01' })).status, 403);
});

test('illegal transition is 409 and leaves the state unchanged', async () => {
  const t = await setup(null); // no analyzer: the page stays PENDING_AI
  const sid = await t.newSession();
  const id = randomUUID();
  await t.upload('sf-01', sid, id);
  const res = await t.call('sf-01', `/api/pages/${id}/confirm`, { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'illegal_transition');
  assert.throws(() => transition(t.db, id, 'SYNCED', 'sf-01'), { code: 'illegal_transition' });
  assert.equal((await (await t.call('sf-01', `/api/pages/${id}`)).json()).state, 'PENDING_AI');
  assert.equal(t.count('page_transitions', `page_id = '${id}'`), 2); // CAPTURED, PENDING_AI
});

test('confirm is blocked while a field is NEEDS_REVIEW, then allowed and idempotent; PATCH is audited', async () => {
  const t = await setup();
  const sid = await t.newSession();
  const id = randomUUID();
  await t.upload('sf-01', sid, id);
  await t.settle();
  assert.equal((await (await t.call('sf-01', `/api/pages/${id}`)).json()).state, 'NEEDS_REVIEW');

  const blocked = await t.call('sf-01', `/api/pages/${id}/confirm`, { method: 'POST' });
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { code: 'fields_need_review', text: 'fields still need review', field_ids: ['b'] });

  assert.equal((await t.call('sf-02', `/api/pages/${id}/fields/b`, { method: 'PATCH', ...t.json({ value: 'y' }) })).status, 403);
  const patched = await t.call('sf-01', `/api/pages/${id}/fields/b`, { method: 'PATCH', ...t.json({ value: 'y' }) });
  assert.equal(patched.status, 200);
  assert.deepEqual([(await patched.json()).value, t.count('audit')], ['y', 1]);
  const audit = t.db.prepare('SELECT * FROM audit').get() as Record<string, string>;
  assert.deepEqual(
    [audit.actor_id, audit.role, audit.field_id, audit.old_json, audit.new_json],
    ['sf-01', 'midwife', 'b', '{"value":"x","status":"NEEDS_REVIEW"}', '{"value":"y","status":"KNOWN"}'],
  );

  const done = await t.call('sf-01', `/api/pages/${id}/confirm`, { method: 'POST' });
  assert.equal((await done.json()).state, 'VALIDATED');
  const again = await t.call('sf-01', `/api/pages/${id}/confirm`, { method: 'POST' });
  assert.equal(again.status, 200);
  assert.equal(t.count('page_transitions', "to_state = 'VALIDATED'"), 1);
  assert.equal((await t.call('sf-01', `/api/pages/${id}/fields/b`, { method: 'PATCH', ...t.json({ value: 'z' }) })).status, 409);
});

test('originals: role check, every attempt logged, encrypted at rest, exact bytes back', async () => {
  const t = await setup();
  const sid = await t.newSession();
  const id = randomUUID();
  await t.upload('sf-01', sid, id);
  await t.settle();

  const own = await t.call('sf-01', `/api/originals/${id}`);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/png');
  assert.equal(createHash('sha256').update(Buffer.from(await own.arrayBuffer())).digest('hex'), createHash('sha256').update(t.png).digest('hex'));
  assert.equal((await t.call('sf-02', `/api/originals/${id}`)).status, 403);
  assert.equal((await t.call('sup-01', `/api/originals/${id}`)).status, 200);
  const log = t.db.prepare('SELECT actor_id, allowed FROM originals_access ORDER BY id').all();
  assert.deepEqual(log, [
    { actor_id: 'sf-01', allowed: 1 },
    { actor_id: 'sf-02', allowed: 0 },
    { actor_id: 'sup-01', allowed: 1 },
  ]);

  const stored = readFileSync(join(t.dataDir, 'originals', `${id}.bin`));
  assert.equal(stored.includes(t.png.subarray(0, 16)), false);
  assert.equal(stored.length, t.png.length + 12 + 16);
  const reopened = openOriginals(t.dataDir);
  assert.deepEqual(reopened.read(id), t.png);
});

test('NDJSON analysis stream: ordered events, each line parses; replay then live', async () => {
  const t = await setup();
  const sid = await t.newSession();
  assert.equal((await t.call('sf-02', `/api/sessions/${sid}/analysis`)).status, 403);
  const id = randomUUID();
  await t.upload('sf-01', sid, id);
  await t.settle();

  const res = await t.call('sup-01', `/api/sessions/${sid}/analysis`);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('record_ready')) text += decoder.decode((await reader.read()).value);
  await reader.cancel();
  const types = text.trim().split('\n').map((l) => parseEvent(l).type);
  assert.deepEqual(types, ['page_received', 'page_read', 'field_flagged', 'field_flagged', 'record_ready']);
});

test('analysis errors: page_type_required, analyzer failure and model errors give PROCESSING_FAILED without a stack', async () => {
  const failing: Analyzer = async () => {
    throw new AnalysisError('page_type_unsupported');
  };
  const t = await setup(failing);
  const sid = await t.newSession();
  const noType = randomUUID();
  const broken = randomUUID();
  await t.upload('sf-01', sid, noType, { page_type: undefined });
  await t.upload('sf-01', sid, broken);
  await t.settle();
  for (const id of [noType, broken]) assert.equal((await (await t.call('sf-01', `/api/pages/${id}`)).json()).state, 'PROCESSING_FAILED');
  const codes = (t.db.prepare("SELECT json FROM events WHERE json LIKE '%\"error\"%'").all() as { json: string }[]).map((r) => JSON.parse(r.json).code);
  assert.deepEqual(codes, ['page_type_required', 'page_type_unsupported']);
  assert.equal(t.count('events', "json LIKE '%record_ready%'"), 2);
});
