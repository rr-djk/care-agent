// The sync engine: ONE loop that sends the queued pages to the server, in capture order.
// A page leaves the queue only when the server answers 200 with the same sha256; its image bytes are then deleted.
// Network errors, timeouts and 5xx keep the page CAPTURED (attempts + backoff). Other refusals (409 sha mismatch, 4xx)
// put it in SYNC_FAILED with the error code, for the midwife to retry. Nothing is ever dropped automatically.
import type { RecordPage } from '@care-agent/schema';
import { api } from '../api';
import { ApiError } from '../errors';
import { hasKey } from './crypto';
import { isReachable, netBlocked, subscribeNet } from './network';
import * as store from './store';

const MAX_BACKOFF_MS = 60_000;
const TIMER_MS = 30_000;

/** Exponential (1 s, 2 s, 4 s...) with jitter (between half and the full delay), capped at 60 s. `attempts` >= 1. */
export function backoffMs(attempts: number, rand = Math.random): number {
  const cap = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempts - 1));
  return Math.round(cap / 2 + (rand() * cap) / 2);
}

export type SyncEvent = { type: 'changed' } | { type: 'uploaded'; page: RecordPage } | { type: 'auth_expired' };

export function createSync({ now = Date.now, rand = Math.random } = {}) {
  let userId: string | null = null;
  let loop: Promise<void> | null = null;
  let again = false;
  let forced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: string | null = null;
  const listeners = new Set<(e: SyncEvent) => void>();
  const emit = (e: SyncEvent) => listeners.forEach((l) => l(e));

  /** Sends one page: its session first (idempotent), then the page (idempotent). */
  async function send(item: store.LocalPage, session: store.LocalSession | undefined) {
    if (session && !session.synced) {
      await api.createSession(session.session);
      await store.saveSession({ ...session, synced: true });
      session.synced = true;
    }
    const bytes = await store.getBlob(item.id);
    if (!bytes) throw new ApiError('local_data_missing', 'image bytes missing on the device');
    const stored = await api.uploadPage(item.meta, new Blob([bytes as BlobPart], { type: item.mime }));
    if (stored.sha256 !== item.meta.sha256) throw new ApiError('sha256_mismatch', 'the server stored another image', undefined, 409);
    await store.markUploaded(item, stored.state);
    emit({ type: 'uploaded', page: stored });
  }

  /** Returns true when the pass must stop (connectivity problem or expired login: the next pages would fail too). */
  async function fail(item: store.LocalPage, e: unknown): Promise<boolean> {
    const code = e instanceof ApiError ? e.code : 'network';
    const status = e instanceof ApiError ? e.status : undefined;
    if (code === 'unauthorized') {
      emit({ type: 'auth_expired' }); // the page stays queued; the midwife logs in again
      return true;
    }
    if (code === 'network' || (status !== undefined && status >= 500)) {
      const attempts = item.attempts + 1;
      await store.savePage({ ...item, attempts, nextAttemptAt: now() + backoffMs(attempts, rand) });
      return true;
    }
    await store.savePage({ ...item, state: 'SYNC_FAILED', error: code });
    return false;
  }

  async function pass(force: boolean) {
    if (!userId || !hasKey() || netBlocked()) return;
    if (!isReachable()) {
      try {
        await api.health(); // marks the server reachable again
      } catch {
        return;
      }
    }
    const sessions = new Map((await store.listSessions(userId)).map((s) => [s.id, s]));
    for (const item of (await store.listPages(userId)).filter((p) => p.state === 'CAPTURED')) {
      if (!force && item.nextAttemptAt > now()) {
        clearTimeout(timer);
        timer = setTimeout(() => void kick(), item.nextAttemptAt - now() + 10); // capture order: nothing behind it goes first
        return;
      }
      if (netBlocked()) return;
      sending = item.id;
      emit({ type: 'changed' });
      try {
        await send(item, sessions.get(item.meta.session_id));
      } catch (e) {
        if (await fail(item, e)) return;
      } finally {
        sending = null;
        emit({ type: 'changed' });
      }
    }
  }

  /** Runs the loop (or asks the running one for another pass). `force` ignores the backoff delays (connectivity came back). */
  function kick(force = false): Promise<void> {
    forced ||= force;
    if (loop) {
      again = true;
      return loop;
    }
    loop = (async () => {
      do {
        again = false;
        const f = forced;
        forced = false;
        await pass(f).catch(() => undefined); // IndexedDB trouble must not kill the loop; the next trigger retries
      } while (again);
    })().finally(() => {
      loop = null;
      emit({ type: 'changed' });
    });
    return loop;
  }

  return {
    kick,
    /** Which user's queue the loop serves (set by `start`; tests call it directly). */
    bind(id: string | null) {
      userId = id;
    },
    /** Starts for this user: triggers are online, visibility, network changes and a 30 s timer. */
    start(id: string): () => void {
      userId = id;
      const onVisible = () => document.visibilityState === 'visible' && void kick();
      const onOnline = () => void kick(true);
      window.addEventListener('online', onOnline);
      document.addEventListener('visibilitychange', onVisible);
      const unsubscribe = subscribeNet(onOnline);
      const interval = setInterval(() => void kick(), TIMER_MS);
      void kick();
      return () => {
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisible);
        unsubscribe();
        clearInterval(interval);
        clearTimeout(timer);
        userId = null;
      };
    },
    /** « Réessayer »: requeue a SYNC_FAILED page (its session is re-created idempotently too). */
    async retry(id: string): Promise<void> {
      const item = (await store.listPages(userId!)).find((p) => p.id === id);
      if (!item || item.state !== 'SYNC_FAILED') return;
      await store.savePage({ ...item, state: 'CAPTURED', attempts: 0, nextAttemptAt: 0, error: undefined });
      const session = (await store.listSessions(userId!)).find((s) => s.id === item.meta.session_id);
      if (session) await store.saveSession({ ...session, synced: false });
      void kick(true);
    },
    sendingId: () => sending,
    subscribe(listener: (e: SyncEvent) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export const sync = createSync();
