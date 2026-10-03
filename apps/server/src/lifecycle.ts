import { canTransition, type LifecycleState } from '@care-agent/schema';
import type { Db } from './db';
import { ApiError } from './errors';

/** Moves a page to `to`; the new state and its page_transitions row are written in one transaction. */
export function transition(db: Db, pageId: string, to: LifecycleState, actor: string): LifecycleState {
  return db.transaction(() => {
    const row = db.prepare('SELECT state FROM pages WHERE id = ?').get(pageId) as { state: LifecycleState } | undefined;
    if (!row) throw new ApiError(404, 'not_found', 'page not found');
    if (!canTransition(row.state, to)) throw new ApiError(409, 'illegal_transition', `${row.state} -> ${to} is not allowed`);
    db.prepare('UPDATE pages SET state = ? WHERE id = ?').run(to, pageId);
    db.prepare('INSERT INTO page_transitions (page_id, from_state, to_state, at, actor) VALUES (?, ?, ?, ?, ?)').run(
      pageId,
      row.state,
      to,
      new Date().toISOString(),
      actor,
    );
    return to;
  })();
}
