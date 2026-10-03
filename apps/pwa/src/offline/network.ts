// Connectivity as the app sees it: the demo switch ("Mode hors ligne (simulation)"), navigator.onLine, and whether the
// last request reached the server (api.ts reports it; a failed /api/health probe keeps it false).
let simulated = false;
let reachable = true;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
}

/** True when no network call may be made at all (simulation on, or the browser says it is offline). */
export const netBlocked = () => simulated || (typeof navigator !== 'undefined' && navigator.onLine === false);

/** What the header badge shows: blocked, or the server did not answer last time. */
export const isOffline = () => netBlocked() || !reachable;

export const isSimulated = () => simulated;

export function setSimulated(on: boolean) {
  simulated = on;
  notify();
}

export function setReachable(ok: boolean) {
  if (ok === reachable) return;
  reachable = ok;
  notify();
}

export const isReachable = () => reachable;

export function subscribeNet(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
