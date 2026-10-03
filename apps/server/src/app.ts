import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { RecordPage, type StreamEvent } from '@care-agent/schema';
import { login, userForToken, type AuthUser } from './auth';
import { deterministicReply, NOTHING_TO_REVIEW, type ChatTarget } from './chat';
import { runToolAgent, type ChatModelFn } from './chat-llm';
import { getFields, getPage, type Db } from './db';
import { ApiError } from './errors';
import { applyFieldEdit, pageSchemaFor, parseEdit, reviewedFields } from './fields';
import { transition } from './lifecycle';
import { sniffContentType, type OriginalStore } from './originals';
import { maskIdentifiers } from './privacy';
import { buildReview } from './review';
import type { EventStore } from './stream';
import type { Worker } from './worker';

export interface AppDeps {
  db: Db;
  originals: OriginalStore;
  events: EventStore;
  worker: Worker;
  model: string | null; // reported by /api/health; null when analysis is off
  inkOnly?: boolean; // ANALYZER=ink: uploaded pages go straight to manual entry (no model)
  chatModel?: ChatModelFn; // CHAT_ENGINE=strands: LLM chat engine; the deterministic parser is the default
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const PING_MS = 10_000;
const MAX_CHAT_CHARS = 500;

export function createApp({ db, originals, events, worker, model, inkOnly, chatModel }: AppDeps) {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ code: err.code, text: err.text, ...err.extra }, err.status);
    console.error(`unhandled ${err.name}`); // name only: messages could echo clinical values
    return c.json({ code: 'internal', text: 'internal error' }, 500);
  });

  app.get('/api/health', (c) => c.json({ status: 'ok', model }));

  app.post('/api/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(login(db, body.user_id, body.pin));
  });

  app.use('/api/*', async (c, next) => {
    c.set('user', userForToken(db, c.req.header('Authorization')));
    await next();
  });

  const canSee = (user: AuthUser, ownerId: string) => user.role === 'supervisor' || user.id === ownerId;
  const ownPage = (user: AuthUser, id: string) => {
    const page = getPage(db, id);
    if (!page) throw new ApiError(404, 'not_found', 'page not found');
    if (!canSee(user, page.midwife_id)) throw new ApiError(403, 'forbidden', 'not your page');
    return page;
  };
  const midwifeOnly = (user: AuthUser) => {
    if (user.role !== 'midwife') throw new ApiError(403, 'forbidden', 'midwife only');
  };

  /** The review queue of a session: pages in capture order, with the audit trail for the progress counts. */
  const loadReview = (sessionId: string) => {
    const ids = db.prepare('SELECT id FROM pages WHERE session_id = ? ORDER BY captured_at, rowid').all(sessionId) as { id: string }[];
    return buildReview(
      ids.map(({ id }) => ({ ...getPage(db, id)!, fields: getFields(db, id), reviewed: reviewedFields(db, id) })),
      pageSchemaFor,
    );
  };
  const ownSession = (user: AuthUser, id: string) => {
    const session = db.prepare('SELECT midwife_id FROM sessions WHERE id = ?').get(id) as { midwife_id: string } | undefined;
    if (!session) throw new ApiError(404, 'session_not_found', 'unknown session');
    if (!canSee(user, session.midwife_id)) throw new ApiError(403, 'forbidden', 'not your session');
  };

  app.post('/api/sessions', async (c) => {
    const user = c.get('user');
    midwifeOnly(user);
    const body = await c.req.json().catch(() => ({}));
    const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const session = {
      id: randomUUID(),
      midwife_id: user.id,
      fiche_number: text(body.fiche_number),
      facility: text(body.facility),
      started_at: new Date().toISOString(),
      page_ids: [],
    };
    db.prepare('INSERT INTO sessions (id, midwife_id, fiche_number, facility, started_at) VALUES (?, ?, ?, ?, ?)').run(
      session.id,
      session.midwife_id,
      session.fiche_number ?? null,
      session.facility ?? null,
      session.started_at,
    );
    return c.json(session);
  });

  app.post('/api/pages', async (c) => {
    const user = c.get('user');
    midwifeOnly(user);
    const form = await c.req.parseBody();
    if (typeof form.meta !== 'string' || !(form.image instanceof File)) {
      throw new ApiError(400, 'bad_request', 'multipart fields "meta" (JSON) and "image" (file) are required');
    }
    const meta = RecordPage.safeParse(parseJson(form.meta));
    if (!meta.success) throw new ApiError(400, 'invalid_meta', 'meta is not a valid RecordPage');
    const { id, session_id, page_type, captured_at, sha256, flags, quality, replaces } = meta.data;
    if (meta.data.midwife_id !== user.id) throw new ApiError(403, 'forbidden', 'meta.midwife_id is not the caller');

    const stored = getPage(db, id);
    if (stored) {
      if (stored.midwife_id !== user.id) throw new ApiError(403, 'forbidden', 'not your page');
      return c.json(stored); // replay: nothing changes
    }
    const session = db.prepare('SELECT midwife_id FROM sessions WHERE id = ?').get(session_id) as { midwife_id: string } | undefined;
    if (!session || session.midwife_id !== user.id) throw new ApiError(404, 'session_not_found', 'unknown session');

    // retake: the page being replaced must be hers, in this session, of the same page type
    const replaced = replaces ? getPage(db, replaces) : undefined;
    if (replaces && (!replaced || replaced.session_id !== session_id || replaced.midwife_id !== user.id)) {
      throw new ApiError(404, 'not_found', 'the page to replace was not found');
    }
    if (replaced && replaced.page_type !== page_type) throw new ApiError(400, 'invalid_meta', 'a retake must have the page type of the replaced page');

    const bytes = Buffer.from(await form.image.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new ApiError(409, 'sha256_mismatch', 'the image does not match meta.sha256');
    }
    originals.write(id, bytes);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO pages (id, session_id, page_type, captured_at, midwife_id, sha256, state, flags, quality, created_at, replaces)
         VALUES (?, ?, ?, ?, ?, ?, 'CAPTURED', ?, ?, ?, ?)`,
      ).run(id, session_id, page_type ?? null, captured_at, user.id, sha256, JSON.stringify(flags), quality ? JSON.stringify(quality) : null, now, replaces ?? null);
      db.prepare("INSERT INTO page_transitions (page_id, from_state, to_state, at, actor) VALUES (?, NULL, 'CAPTURED', ?, ?)").run(id, now, user.id);
      if (replaced) {
        const superseded = JSON.stringify([...new Set([...replaced.flags, 'SUPERSEDED'])]);
        db.prepare('UPDATE pages SET flags = ? WHERE id = ?').run(superseded, replaced.id);
      }
      if (!inkOnly) transition(db, id, 'PENDING_AI', user.id);
    })();
    events.publish(session_id, { type: 'page_received', page_id: id });
    if (!inkOnly) void worker.enqueue(id);
    else {
      worker.manual(id, user.id).catch((err) => {
        const code = err instanceof ApiError ? err.code : 'analysis_failed';
        events.publish(session_id, { type: 'error', code, text: `page ${id} failed`, page_id: id });
      });
    }
    return c.json(getPage(db, id));
  });

  app.get('/api/pages/:id', (c) => {
    const page = ownPage(c.get('user'), c.req.param('id'));
    return c.json({ ...page, fields: getFields(db, page.id) });
  });

  app.patch('/api/pages/:id/fields/:fieldId', async (c) => {
    const user = c.get('user');
    midwifeOnly(user);
    const page = ownPage(user, c.req.param('id'));
    const edit = parseEdit(await c.req.json().catch(() => ({})));
    if (!edit) throw new ApiError(400, 'bad_request', 'body needs { confirm: true } or { value: string | boolean | null, status?: Status } or { status: "ILLEGIBLE" }');
    return c.json(applyFieldEdit(db, user, page, c.req.param('fieldId'), edit));
  });

  app.post('/api/pages/:id/manual', async (c) => {
    const user = c.get('user');
    midwifeOnly(user);
    const page = ownPage(user, c.req.param('id'));
    await worker.manual(page.id, user.id);
    return c.json({ ...getPage(db, page.id), fields: getFields(db, page.id) });
  });

  app.get('/api/sessions/:id/review', (c) => {
    ownSession(c.get('user'), c.req.param('id'));
    return c.json(loadReview(c.req.param('id')));
  });

  app.post('/api/chat', async (c) => {
    const user = c.get('user');
    midwifeOnly(user);
    const { session_id, page_id, field_id, message } = await c.req.json().catch(() => ({}));
    const optional = (v: unknown) => v === undefined || typeof v === 'string';
    if (typeof session_id !== 'string' || typeof message !== 'string' || !message.trim() || message.length > MAX_CHAT_CHARS || !optional(page_id) || !optional(field_id) || (field_id && !page_id)) {
      throw new ApiError(400, 'bad_request', `body needs { session_id, message (1..${MAX_CHAT_CHARS} chars), page_id?, field_id? (field_id needs page_id) }`);
    }
    ownSession(user, session_id);
    const bound = page_id ? ownPage(user, page_id) : undefined;
    if (bound && bound.session_id !== session_id) throw new ApiError(404, 'not_found', 'page not found in this session');

    // current item: the given field, else the head of the review queue (of the given page, else of the session)
    const queue = loadReview(session_id).items.filter((i) => !bound || i.page_id === bound.id);
    const page = bound ?? (queue[0] ? getPage(db, queue[0].page_id) : undefined);
    const fields = page ? getFields(db, page.id) : [];
    const field = fields.find((f) => f.field_id === (field_id ?? queue[0]?.field_id));
    if (field_id && !field) throw new ApiError(404, 'not_found', 'field not found');
    const def = page && field ? pageSchemaFor(page.page_type)?.fields.find((f) => f.id === field.field_id) : undefined;
    const target: ChatTarget | null = field ? { field, def, label: def?.label_fr ?? field.field_id } : null;
    const apply: Parameters<typeof deterministicReply>[2] = (edit) => applyFieldEdit(db, user, page!, field!.field_id, edit);
    const text = maskIdentifiers(message).text; // the message itself is never stored: only the resulting field changes are

    c.header('Content-Type', 'application/x-ndjson');
    return stream(c, async (s) => {
      const send = (e: StreamEvent) => s.write(`${JSON.stringify(e)}\n`);
      const timer = setInterval(() => void send({ type: 'ping' }), PING_MS); // slow CPU inference
      try {
        const deterministic = () => deterministicReply(text, target, apply);
        const reply =
          chatModel && page
            ? await runToolAgent(
                chatModel,
                {
                  pageId: page.id,
                  fieldIds: new Set(fields.map((f) => f.field_id)),
                  pending: () => loadReview(session_id).items.filter((i) => i.page_id === page.id),
                  apply: (fieldId, edit) => applyFieldEdit(db, user, page, fieldId, edit),
                  startManual: () => worker.manual(page.id, user.id),
                },
                text,
              ).catch(deterministic) // model unreachable: the parser still understands short answers
            : page
              ? deterministic()
              : NOTHING_TO_REVIEW;
        for (const token of reply.match(/\S+\s*/g) ?? []) await send({ type: 'token', text: token });
        await send({ type: 'done' });
      } catch (e) {
        await send({ type: 'error', code: e instanceof ApiError ? e.code : 'chat_failed', text: e instanceof ApiError ? e.text : 'chat failed' });
      } finally {
        clearInterval(timer);
      }
    });
  });

  app.post('/api/pages/:id/confirm', (c) => {
    const user = c.get('user');
    midwifeOnly(user);
    const page = ownPage(user, c.req.param('id'));
    if (page.state === 'VALIDATED') return c.json(page);
    const open = getFields(db, page.id).filter((f) => f.status === 'NEEDS_REVIEW').map((f) => f.field_id);
    if (open.length) throw new ApiError(409, 'fields_need_review', 'fields still need review', { field_ids: open });
    transition(db, page.id, 'VALIDATED', user.id);
    return c.json(getPage(db, page.id));
  });

  // Replays the stored events of the session, then follows live until the client disconnects (never closes by itself).
  app.get('/api/sessions/:id/analysis', (c) => {
    const user = c.get('user');
    const sessionId = c.req.param('id');
    const session = db.prepare('SELECT midwife_id FROM sessions WHERE id = ?').get(sessionId) as { midwife_id: string } | undefined;
    if (!session) throw new ApiError(404, 'not_found', 'session not found');
    if (!canSee(user, session.midwife_id)) throw new ApiError(403, 'forbidden', 'not your session');
    c.header('Content-Type', 'application/x-ndjson');
    return stream(c, async (s) => {
      const ac = new AbortController();
      s.onAbort(() => ac.abort());
      let last = 0;
      while (!ac.signal.aborted) {
        for (const row of events.after(sessionId, last)) {
          await s.write(`${row.json}\n`);
          last = row.id;
        }
        if (!(await events.wait(PING_MS, ac.signal)) && !ac.signal.aborted) await s.write('{"type":"ping"}\n');
      }
    });
  });

  app.get('/api/originals/:pageId', (c) => {
    const user = c.get('user');
    const pageId = c.req.param('pageId');
    const page = getPage(db, pageId);
    const allowed = !!page && canSee(user, page.midwife_id);
    db.prepare('INSERT INTO originals_access (page_id, actor_id, role, allowed, at) VALUES (?, ?, ?, ?, ?)').run(
      pageId,
      user.id,
      user.role,
      allowed ? 1 : 0,
      new Date().toISOString(),
    );
    if (!page) throw new ApiError(404, 'not_found', 'page not found');
    if (!allowed) throw new ApiError(403, 'forbidden', 'not allowed to see this original');
    const bytes = originals.read(pageId);
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': sniffContentType(bytes) });
  });

  return app;
}
