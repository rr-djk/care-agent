import { EventEmitter } from 'node:events';
import type { StreamEvent } from '@care-agent/schema';
import type { Db } from './db';

/** Analysis events: stored per session (replay) and announced to live followers. */
export class EventStore {
  private emitter = new EventEmitter();

  constructor(private db: Db) {}

  publish(sessionId: string, event: StreamEvent): void {
    this.db.prepare('INSERT INTO events (session_id, json) VALUES (?, ?)').run(sessionId, JSON.stringify(event));
    this.emitter.emit('event');
  }

  after(sessionId: string, id: number): { id: number; json: string }[] {
    return this.db.prepare('SELECT id, json FROM events WHERE session_id = ? AND id > ? ORDER BY id').all(sessionId, id) as {
      id: number;
      json: string;
    }[];
  }

  /** Resolves true when an event was published, false on timeout or abort. */
  wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (v: boolean) => {
        clearTimeout(timer);
        this.emitter.off('event', onEvent);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onEvent = () => finish(true);
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), ms);
      this.emitter.on('event', onEvent);
      signal.addEventListener('abort', onAbort);
    });
  }
}
