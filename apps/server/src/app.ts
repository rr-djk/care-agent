import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { RecordPage, Status, type ExtractedField } from '@care-agent/schema';
import { login, userForToken, type AuthUser } from './auth';
import { getFields, getPage, type Db } from './db';
import { ApiError } from './errors';
import { transition } from './lifecycle';
import { sniffContentType, type OriginalStore } from './originals';
import type { EventStore } from './stream';
import type { Worker } from './worker';

export interface AppDeps {
  db: Db;
  originals: OriginalStore;
  events: EventStore;
  worker: Worker;
  model: string | null; // reported by /api/health; null when analysis is off
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const PING_MS = 10_000;
const EDITABLE = ['NEEDS_REVIEW', 'MANUAL_REVIEW_REQUIRED'];

export function createApp({ db, originals, events, worker, model }: AppDeps) {
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
    const { id, session_id, page_type, captured_at, sha256, flags, quality } = meta.data;
    if (meta.data.midwife_id !== user.id) throw new ApiError(403, 'forbidden', 'meta.midwife_id is not the caller');

    const stored = getPage(db, id);
    if (stored) {
      if (stored.midwife_id !== user.id) throw new ApiError(403, 'forbidden', 'not your page');
      return c.json(stored); // replay: nothing changes
    }
    const session = db.prepare('SELECT midwife_id FROM sessions WHERE id = ?').get(session_id) as { midwife_id: string } | undefined;
    if (!session || session.midwife_id !== user.id) throw new ApiError(404, 'session_not_found', 'unknown session');

    const bytes = Buffer.from(await form.image.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new ApiError(409, 'sha256_mismatch', 'the image does not match meta.sha256');
    }
    originals.write(id, bytes);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO pages (id, session_id, page_type, captured_at, midwife_id, sha256, state, flags, quality, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'CAPTURED', ?, ?, ?)`,
      ).run(id, session_id, page_type ?? null, captured_at, user.id, sha256, JSON.stringify(flags), quality ? JSON.stringify(quality) : null, now);
      db.prepare("INSERT INTO page_transitions (page_id, from_state, to_state, at, actor) VALUES (?, NULL, 'CAPTURED', ?, ?)").run(id, now, user.id);
      transition(db, id, 'PENDING_AI', user.id);
    })();
    events.publish(session_id, { type: 'page_received', page_id: id });
    void worker.enqueue(id);
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
    const body = await c.req.json().catch(() => ({}));
    const status = Status.safeParse(body.status ?? 'KNOWN');
    const value = body.value;
    if (!status.success || !(value === null || ['string', 'boolean'].includes(typeof value))) {
      throw new ApiError(400, 'bad_request', 'body needs { value: string | boolean | null, status?: Status }');
    }
    if (!EDITABLE.includes(page.state)) throw new ApiError(409, 'page_not_editable', `page is ${page.state}`);
    const row = db.prepare('SELECT json FROM fields WHERE page_id = ? AND field_id = ?').get(page.id, c.req.param('fieldId')) as { json: string } | undefined;
    if (!row) throw new ApiError(404, 'not_found', 'field not found');
    const old: ExtractedField = JSON.parse(row.json);
    const updated: ExtractedField = { ...old, value, status: status.data };
    db.transaction(() => {
      db.prepare('UPDATE fields SET json = ? WHERE page_id = ? AND field_id = ?').run(JSON.stringify(updated), page.id, old.field_id);
      db.prepare('INSERT INTO audit (page_id, field_id, actor_id, role, old_json, new_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        page.id,
        old.field_id,
        user.id,
        user.role,
        JSON.stringify({ value: old.value, status: old.status }),
        JSON.stringify({ value: updated.value, status: updated.status }),
        new Date().toISOString(),
      );
    })();
    return c.json(updated);
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
