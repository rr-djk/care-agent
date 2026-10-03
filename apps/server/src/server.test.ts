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
import type { ChatMessage, ChatModelFn } from './chat-llm';

const field = (field_id: string, status: ExtractedField['status'], value: string | null = 'x'): ExtractedField => ({
  field_id,
  value,
  status,
  confidence_signals: { validators_passed: true, quality: 1 },
  source_page: 2,
});
const FIELDS = [field('a', 'KNOWN'), field('b', 'NEEDS_REVIEW'), field('c', 'ILLEGIBLE', null)];
const okAnalyzer: Analyzer = async () => FIELDS;

async function setup(analyzer: Analyzer | null = okAnalyzer, opts: { ink?: Analyzer; inkOnly?: boolean; chatModel?: ChatModelFn } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'care-agent-test-'));
  process.env.ORIGINALS_KEY = 'ab'.repeat(32);
  const db = openDb(dataDir);
  const originals = openOriginals(dataDir);
  const events = new EventStore(db);
  const worker = createWorker({ db, originals, events }, analyzer ?? undefined, opts.ink);
  const jobs: Promise<void>[] = [];
  const enqueue = worker.enqueue;
  worker.enqueue = (id) => {
    const job = enqueue(id);
    jobs.push(job);
    return job;
  };
  const manual = worker.manual;
  worker.manual = (id, actor) => {
    const job = manual(id, actor);
    jobs.push(job.catch(() => {})); // upload in ink mode fires it without awaiting
    return job;
  };
  const app = createApp({ db, originals, events, worker, model: 'fake', inkOnly: opts.inkOnly, chatModel: opts.chatModel });
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
  const patch = (user: string, pageId: string, fieldId: string, body: object) =>
    call(user, `/api/pages/${pageId}/fields/${fieldId}`, { method: 'PATCH', ...json(body) });
  const review = async (sessionId: string, user = 'sf-01') => (await call(user, `/api/sessions/${sessionId}/review`)).json();
  /** POST /api/chat: the concatenated reply, the event types and the HTTP status. */
  const chat = async (sessionId: string, message: string, extra: object = {}, user = 'sf-01') => {
    const res = await call(user, '/api/chat', { method: 'POST', ...json({ session_id: sessionId, message, ...extra }) });
    if (res.status !== 200) return { status: res.status, reply: '', types: [] as string[], error: await res.json() };
    const lines = (await res.text()).trim().split('\n').map((l) => parseEvent(l));
    const reply = lines.flatMap((e) => (e.type === 'token' ? [e.text] : [])).join('').trim();
    return { status: 200, reply, types: lines.map((e) => e.type), error: lines.find((e) => e.type === 'error') };
  };
  const count = (table: string, where = '1') => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
  return { dataDir, db, app, call, json, png, newSession, upload, patch, review, chat, count, settle: () => Promise.all(jobs), seed: pins };
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

// --- step 8: review flow, manual entry, retake, chat -----------------------------------------------------------------

const preg = (id: string, status: ExtractedField['status'], value: ExtractedField['value'], signals: Partial<ExtractedField['confidence_signals']> = {}): ExtractedField => ({
  field_id: id,
  value,
  status,
  confidence_signals: { validators_passed: true, quality: 1, ...signals },
  source_page: 3,
});
const PREG = [
  preg('p03.ddr', 'NEEDS_REVIEW', null, { agreement: 0 }),
  preg('p03.taille', 'NEEDS_REVIEW', '1582', { validators_passed: false }),
  preg('p03.date_de_depassement_de_terme', 'ILLEGIBLE', null),
  preg('p03.age_probable.v1_t1', 'KNOWN', '12'),
];
const pregAnalyzer: Analyzer = async () => PREG;
const pageOf = async (t: Awaited<ReturnType<typeof setup>>, id: string) => (await t.call('sf-01', `/api/pages/${id}`)).json();
const upload3 = async (t: Awaited<ReturnType<typeof setup>>, sid: string, over: Record<string, unknown> = {}) => {
  const id = randomUUID();
  await t.upload('sf-01', sid, id, { page_type: 3, ...over });
  await t.settle();
  return id;
};

test('review queue: ordered items, French doubts, progress; supervisor reads, other midwife refused', async () => {
  const t = await setup(pregAnalyzer);
  const sid = await t.newSession();
  const p1 = await upload3(t, sid);
  const p2 = await upload3(t, sid);
  const q = await t.review(sid);
  assert.deepEqual(q.items.map((i: any) => [i.page_id === p1 ? 1 : 2, i.field_id, i.reason_code]), [
    [1, 'p03.ddr', 'ink_but_empty'],
    [1, 'p03.taille', 'unusual_value'],
    [1, 'p03.date_de_depassement_de_terme', 'illegible'],
    [2, 'p03.ddr', 'ink_but_empty'],
    [2, 'p03.taille', 'unusual_value'],
    [2, 'p03.date_de_depassement_de_terme', 'illegible'],
  ]);
  assert.match(q.items[1].text_fr, /J'ai lu « 1582 » pour Taille, mais la valeur semble inhabituelle/);
  assert.deepEqual(q.progress.pages.map((p: any) => [p.page_id, p.total, p.done]), [[p1, 3, 0], [p2, 3, 0]]);
  assert.equal((await t.call('sup-01', `/api/sessions/${sid}/review`)).status, 200);
  assert.equal((await t.call('sf-02', `/api/sessions/${sid}/review`)).status, 403);
  assert.equal((await t.call('sf-01', '/api/sessions/nope/review')).status, 404);
});

test('actions: confirm, correct ok, correct still invalid (stays NEEDS_REVIEW with the reason), leave illegible; all audited', async () => {
  const t = await setup(pregAnalyzer);
  const sid = await t.newSession();
  const id = await upload3(t, sid);

  // correct, but the value still fails the range validator: never silently accepted
  const bad = await (await t.patch('sf-01', id, 'p03.taille', { value: '1700' })).json();
  assert.equal(bad.status, 'NEEDS_REVIEW');
  assert.equal(bad.confidence_signals.validators_passed, false);
  assert.match(bad.text_fr, /« 1700 » ne convient pas pour Taille \(attendu : entre 120 et 200 cm\)/);
  let q = await t.review(sid);
  assert.match(q.items.find((i: any) => i.field_id === 'p03.taille').text_fr, /^Vous avez saisi « 1700 »/);

  // correct with a unit and a decimal comma: normalized, KNOWN
  const ok = await (await t.patch('sf-01', id, 'p03.taille', { value: '158 cm' })).json();
  assert.deepEqual([ok.status, ok.value, ok.confidence_signals.validators_passed, ok.text_fr], ['KNOWN', '158', true, undefined]);

  // confirm keeps the current value; an empty field cannot be confirmed
  const typed = await (await t.patch('sf-01', id, 'p03.ddr', { value: '12/4/26' })).json();
  assert.deepEqual([typed.status, typed.value], ['KNOWN', '12/04/2026']);
  assert.equal((await t.patch('sf-01', id, 'p03.date_de_depassement_de_terme', { confirm: true })).status, 400);
  const left = await (await t.patch('sf-01', id, 'p03.date_de_depassement_de_terme', { status: 'ILLEGIBLE' })).json();
  assert.deepEqual([left.status, left.value, left.reason], ['ILLEGIBLE', null, 'left_illegible']);
  assert.equal((await t.patch('sf-01', id, 'p03.age_probable.v1_t1', { confirm: true })).status, 200);
  assert.equal((await t.patch('sf-01', id, 'p03.age_probable.v1_t1', { nothing: 1 })).status, 400);

  q = await t.review(sid);
  assert.deepEqual(q.items, []); // kept-illegible leaves the queue
  assert.deepEqual([q.progress.total, q.progress.done], [3, 3]);
  assert.equal(t.count('audit'), 5);
  const last = t.db.prepare("SELECT old_json, new_json FROM audit WHERE field_id = 'p03.date_de_depassement_de_terme'").get() as Record<string, string>;
  assert.deepEqual([last.old_json, last.new_json], ['{"value":null,"status":"ILLEGIBLE"}', '{"value":null,"status":"ILLEGIBLE"}']);
  assert.equal((await (await t.call('sf-01', `/api/pages/${id}/confirm`, { method: 'POST' })).json()).state, 'VALIDATED');
});

test('PATCH masks identifiers in text values', async () => {
  const t = await setup(async () => [preg('p04.si_autres_a_preciser', 'NEEDS_REVIEW', 'x')]);
  const sid = await t.newSession();
  const id = await upload3(t, sid, { page_type: 4 });
  const r = await (await t.patch('sf-01', id, 'p04.si_autres_a_preciser', { value: 'tel 0612345678 puis hémorragie' })).json();
  assert.deepEqual([r.value, r.status], ['tel [masqué] puis hémorragie', 'KNOWN']);
  assert.match(r.text_fr, /identifiant personnel a été masqué/);
});

test('retake: the new page replaces the old one (SUPERSEDED, out of the queue) and is analyzed', async () => {
  const t = await setup(pregAnalyzer);
  const sid = await t.newSession();
  const old = await upload3(t, sid);
  const fresh = await upload3(t, sid, { replaces: old });
  assert.deepEqual((await pageOf(t, old)).flags, ['SUPERSEDED']);
  const page = await pageOf(t, fresh);
  assert.deepEqual([page.state, page.replaces, page.fields.length], ['NEEDS_REVIEW', old, 4]);
  const q = await t.review(sid);
  assert.deepEqual([...new Set(q.items.map((i: any) => i.page_id))], [fresh]);
  assert.deepEqual(q.progress.pages.map((p: any) => p.page_id), [fresh]);
  // replay of the retake upload changes nothing
  await t.upload('sf-01', sid, fresh, { page_type: 3, replaces: old });
  assert.equal(t.count('pages'), 2);
  // the replaced page must exist, be hers, same session, same type
  assert.equal((await t.upload('sf-01', sid, randomUUID(), { page_type: 3, replaces: randomUUID() })).status, 404);
  const other = await t.newSession();
  assert.equal((await t.upload('sf-01', other, randomUUID(), { page_type: 3, replaces: old })).status, 404);
  assert.equal((await t.upload('sf-01', sid, randomUUID(), { page_type: 4, replaces: fresh })).status, 400);
});

test('manual entry: failed analysis -> manual -> only inked cells UNKNOWN -> PATCH all -> VALIDATED', async () => {
  const down: Analyzer = async () => {
    throw new AnalysisError('model_unreachable');
  };
  const ink: Analyzer = async () => [
    { ...preg('p03.groupage_a', 'KNOWN', true), verbatim: null },
    preg('p03.taille', 'UNKNOWN', null), // inked text cell
    preg('p03.ddr', 'NOT_PROVIDED', null), // no ink
  ].map((f) => (f.status === 'UNKNOWN' ? { ...f, reason: 'manual' } : f));
  const t = await setup(down, { ink });
  const sid = await t.newSession();
  const id = await upload3(t, sid);
  assert.equal((await pageOf(t, id)).state, 'PROCESSING_FAILED');
  assert.equal((await t.call('sf-02', `/api/pages/${id}/manual`, { method: 'POST' })).status, 403);

  const res = await t.call('sf-01', `/api/pages/${id}/manual`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).state, 'MANUAL_REVIEW_REQUIRED');
  assert.deepEqual(
    (t.db.prepare('SELECT from_state, to_state FROM page_transitions WHERE page_id = ? ORDER BY rowid').all(id) as any[]).map((r) => `${r.from_state}>${r.to_state}`),
    ['null>CAPTURED', 'CAPTURED>PENDING_AI', 'PENDING_AI>PROCESSING_FAILED', 'PROCESSING_FAILED>MANUAL_REVIEW_REQUIRED'],
  );
  const q = await t.review(sid);
  assert.deepEqual(q.items.map((i: any) => [i.field_id, i.kind, i.reason_code, i.actions]), [['p03.taille', 'manual', 'manual', ['correct', 'retake', 'leave_illegible']]]);
  assert.equal((await t.patch('sf-01', id, 'p03.taille', { value: '158' })).status, 200);
  assert.deepEqual((await t.review(sid)).items, []);
  assert.equal((await (await t.call('sf-01', `/api/pages/${id}/confirm`, { method: 'POST' })).json()).state, 'VALIDATED');
  const again = await t.call('sf-01', `/api/pages/${id}/manual`, { method: 'POST' });
  assert.deepEqual([again.status, (await again.json()).code], [409, 'page_not_failed']);
  assert.equal(t.count('events', "json LIKE '%page_read%'"), 1);
});

test('ANALYZER=ink: an uploaded page goes straight CAPTURED -> MANUAL_REVIEW_REQUIRED, no model', async () => {
  const ink: Analyzer = async () => [preg('p03.taille', 'UNKNOWN', null, {}), preg('p03.ddr', 'NOT_PROVIDED', null)].map((f) => ({ ...f, reason: f.status === 'UNKNOWN' ? 'manual' : undefined }));
  const t = await setup(null, { ink, inkOnly: true });
  const sid = await t.newSession();
  const id = await upload3(t, sid);
  assert.equal((await pageOf(t, id)).state, 'MANUAL_REVIEW_REQUIRED');
  assert.equal(t.count('page_transitions', `page_id = '${id}' AND to_state = 'PENDING_AI'`), 0);
  assert.equal((await t.review(sid)).items[0].kind, 'manual');
});

test('chat (deterministic): answers apply through the same code, messages are never stored', async () => {
  const t = await setup(pregAnalyzer);
  const sid = await t.newSession();
  const id = await upload3(t, sid);

  // head of the queue = ddr (ink but nothing read): a date answer corrects it
  const dated = await t.chat(sid, 'je crois que c’est le 12/04/2026 svp ZQXJUNK');
  assert.deepEqual(dated.types.slice(-1), ['done']);
  assert.equal(dated.reply, 'C’est noté : DDR = 12/04/2026.');
  assert.equal((await pageOf(t, id)).fields.find((f: any) => f.field_id === 'p03.ddr').value, '12/04/2026');

  // next item is taille: an out-of-range answer stays NEEDS_REVIEW and the reply says why
  const bad = await t.chat(sid, '1700');
  assert.match(bad.reply, /attendu : entre 120 et 200 cm/);
  assert.equal((await pageOf(t, id)).fields.find((f: any) => f.field_id === 'p03.taille').status, 'NEEDS_REVIEW');
  assert.equal((await t.chat(sid, "c'est bon", { page_id: id, field_id: 'p03.taille' })).reply, 'Taille confirmé : 1700.');
  assert.equal((await t.chat(sid, 'blabla')).reply, "Je n'ai pas compris. Tapez la valeur, ou utilisez les boutons.");
  assert.match((await t.chat(sid, 'je ne sais pas')).reply, /reste illisible/);
  assert.match((await t.chat(sid, 'ok')).reply, /rien à vérifier/);
  assert.equal(t.count('audit'), 4);

  // validation: unknown session, other midwife, bad body, page of another session
  assert.equal((await t.chat('nope', 'ok')).status, 404);
  assert.equal((await t.chat(sid, 'ok', {}, 'sf-02')).status, 403);
  assert.equal((await t.chat(sid, '')).status, 400);
  assert.equal((await t.chat(sid, 'ok', { field_id: 'p03.taille' })).status, 400);
  assert.equal((await t.chat(sid, 'ok', { page_id: id, field_id: 'nope' })).status, 404);
  assert.equal((await t.chat(await t.newSession(), 'ok', { page_id: id })).status, 404);
  assert.equal((await t.chat(sid, 'ok', {}, 'sup-01')).status, 403);

  // no chat text in the database: dump every table
  for (const { name } of t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    const dump = JSON.stringify(t.db.prepare(`SELECT * FROM ${name}`).all());
    assert.ok(!/ZQXJUNK|blabla|je ne sais pas/.test(dump), `chat text found in ${name}`);
  }
});

test('chat (LLM engine, fake model): tools are bound to the request page; another record is refused', async () => {
  const sid2: { id?: string } = {};
  const seen: ChatMessage[][] = [];
  let step = 0;
  const chatModel: ChatModelFn = async (messages) => {
    seen.push(structuredClone(messages));
    step++;
    const call = (args: object): ChatMessage => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'apply_correction', arguments: JSON.stringify(args) } }] });
    if (step === 1) return call({ field_id: 'p03.taille', value: '160', page_id: sid2.id }); // aimed at another page
    if (step === 2) return call({ field_id: 'p03.taille', value: '160' }); // the bound page
    return { role: 'assistant', content: 'Taille notée : 160 cm.' };
  };
  const t = await setup(pregAnalyzer, { chatModel });
  const sid = await t.newSession();
  const mine = await upload3(t, sid);
  sid2.id = await upload3(t, await t.newSession());
  const res = await t.chat(sid, 'mets 160 pour la taille', { page_id: mine });
  assert.equal(res.reply, 'Taille notée : 160 cm.');
  const tool = (round: number) => JSON.parse(seen[round].filter((m) => m.role === 'tool').at(-1)!.content!);
  assert.deepEqual(tool(1), { error: 'out_of_scope' });
  assert.deepEqual([tool(2).status, tool(2).value], ['KNOWN', '160']);
  assert.equal((await pageOf(t, mine)).fields.find((f: any) => f.field_id === 'p03.taille').value, '160');
  assert.equal((await pageOf(t, sid2.id)).fields.find((f: any) => f.field_id === 'p03.taille').value, '1582'); // untouched
  assert.equal(t.count('audit'), 1);
});

test('chat (LLM engine): an unreachable model falls back to the deterministic parser', async () => {
  const chatModel: ChatModelFn = async () => {
    throw new Error('down');
  };
  const t = await setup(pregAnalyzer, { chatModel });
  const sid = await t.newSession();
  await upload3(t, sid);
  assert.equal((await t.chat(sid, '12/04/2026')).reply, 'C’est noté : DDR = 12/04/2026.');
});
