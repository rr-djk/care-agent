import type { ExtractedField } from '@care-agent/schema';
import { getPage, type Db } from './db';
import { transition } from './lifecycle';
import type { OriginalStore } from './originals';
import type { EventStore } from './stream';
import { ModelError } from './vision/model';
import { SequentialQueue } from './vision/queue';

/** Reads one page image (the exact uploaded bytes, decrypted in memory) into fields. */
export type Analyzer = (image: Buffer, pageType: number) => Promise<ExtractedField[]>;

/** A failure with a stable code for the event stream (never a stack or a message from inside the model). */
export class AnalysisError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const SYSTEM = 'system';
const PROCESSING = ['CAPTURED', 'PENDING_AI', 'AI_PROCESSED'];

function failureCode(err: unknown): string {
  if (err instanceof AnalysisError) return err.code;
  if (err instanceof ModelError) return `model_${err.kind}`;
  return 'analysis_failed';
}

export interface Worker {
  /** Queues a PENDING_AI page; the promise settles when its analysis is done (it never rejects). No-op without analyzer. */
  enqueue(pageId: string): Promise<void>;
  /** Re-queues the pages left in PENDING_AI by a previous run. */
  resume(): void;
}

export function createWorker(deps: { db: Db; originals: OriginalStore; events: EventStore }, analyzer?: Analyzer): Worker {
  const { db, originals, events } = deps;
  const queue = new SequentialQueue();

  /** record_ready once no page of the session is still waiting for the analysis. */
  function maybeReady(sessionId: string) {
    const rows = db.prepare('SELECT state FROM pages WHERE session_id = ?').all(sessionId) as { state: string }[];
    if (rows.every((r) => !PROCESSING.includes(r.state))) events.publish(sessionId, { type: 'record_ready', record_id: sessionId });
  }

  async function run(pageId: string) {
    const page = getPage(db, pageId);
    if (!page || page.state !== 'PENDING_AI' || !analyzer) return;
    try {
      if (page.page_type === undefined) throw new AnalysisError('page_type_required');
      const fields = await analyzer(originals.read(pageId), page.page_type);
      db.transaction(() => {
        const put = db.prepare('INSERT OR REPLACE INTO fields (page_id, field_id, json) VALUES (?, ?, ?)');
        for (const f of fields) put.run(pageId, f.field_id, JSON.stringify(f));
        transition(db, pageId, 'AI_PROCESSED', SYSTEM);
        transition(db, pageId, 'NEEDS_REVIEW', SYSTEM);
      })();
      events.publish(page.session_id, { type: 'page_read', page_id: pageId, fields });
      for (const f of fields) {
        if (f.status === 'NEEDS_REVIEW' || f.status === 'ILLEGIBLE') {
          events.publish(page.session_id, { type: 'field_flagged', page_id: pageId, field_id: f.field_id, reason: f.status });
        }
      }
    } catch (err) {
      const code = failureCode(err);
      transition(db, pageId, 'PROCESSING_FAILED', SYSTEM);
      // the event schema has no page-failure event: the shared `error` event carries the code and the page id
      events.publish(page.session_id, { type: 'error', code, text: `page ${pageId} failed`, page_id: pageId });
    }
    maybeReady(page.session_id);
  }

  const enqueue = (pageId: string) => queue.run(() => run(pageId));
  return {
    enqueue,
    resume() {
      const rows = db.prepare("SELECT id FROM pages WHERE state = 'PENDING_AI' ORDER BY created_at").all() as { id: string }[];
      for (const r of rows) void enqueue(r.id);
    },
  };
}
