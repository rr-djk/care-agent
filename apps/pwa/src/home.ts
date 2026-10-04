// One row of the home list (one row per fiche, like a chat list): what is left to do, a badge, and the sync ticks of
// its pages. Pure. Local queue first (what is still on the phone), then the server's review queue when it was loaded.
import type { ReviewQueue } from '@care-agent/schema';
import type { Key, Params } from './i18n';
import type { LocalPage, LocalSession } from './offline/store';

export type Tone = 'failed' | 'unsent' | 'review' | 'reading' | 'ready' | 'linked' | 'ok' | 'empty';

export interface HomeRow {
  id: string;
  fiche?: string;
  facility?: string;
  when: string; // ISO: last capture, else the opening of the fiche
  pages: number;
  status: { key: Key; params?: Params };
  tone: Tone;
  badge?: number; // fields to check, or pages to send
  ticks: 0 | 1 | 2 | 3; // 1 = on the phone, 2 = received by the server, 3 = saved in the record
}

const READING = ['CAPTURED', 'PENDING_AI', 'AI_PROCESSED'];
const RECORDED = ['PATIENT_MATCHED', 'REGISTERED', 'SYNCED'];

export function homeRow(s: LocalSession, local: LocalPage[], review?: ReviewQueue): HomeRow {
  const mine = local.filter((p) => p.meta.session_id === s.id);
  const server = review?.progress.pages ?? [];
  const pages = new Set([...mine.map((p) => p.id), ...server.map((p) => p.page_id)]).size;
  const when = [s.session.started_at, ...mine.map((p) => p.meta.captured_at)].sort().at(-1)!;
  const base = { id: s.id, fiche: s.session.fiche_number, facility: s.session.facility, when, pages };
  const failed = mine.filter((p) => p.state === 'SYNC_FAILED').length;
  const unsent = mine.filter((p) => p.state === 'CAPTURED').length;
  const toCheck = review?.items.length ?? 0;

  if (failed) return { ...base, status: { key: 'home.status.failed' }, tone: 'failed', badge: failed, ticks: 1 };
  if (unsent) return { ...base, status: { key: 'home.status.unsent', params: { n: unsent } }, tone: 'unsent', badge: unsent, ticks: 1 };
  if (!pages) return { ...base, status: { key: 'home.status.empty' }, tone: 'empty', ticks: 0 };
  if (toCheck) return { ...base, status: { key: 'home.status.review', params: { n: toCheck } }, tone: 'review', badge: toCheck, ticks: 2 };
  if (mine.some((p) => p.state === 'UPLOADED' && !server.some((x) => x.page_id === p.id)) || server.some((p) => READING.includes(p.state))) {
    return { ...base, status: { key: 'home.status.reading' }, tone: 'reading', ticks: 2 };
  }
  if (server.length && server.every((p) => RECORDED.includes(p.state))) return { ...base, status: { key: 'home.status.registered' }, tone: 'linked', ticks: 3 };
  if (server.length && server.every((p) => p.state === 'VALIDATED')) return { ...base, status: { key: 'home.status.ready' }, tone: 'ready', ticks: 2 };
  return { ...base, status: { key: 'home.status.ok' }, tone: 'ok', ticks: 2 };
}

/** Rows of the home list, most recent first, filtered by search text (fiche, facility) and by tab. */
export function homeRows(sessions: LocalSession[], local: LocalPage[], reviews: Record<string, ReviewQueue>, opts: { query?: string; filter?: 'all' | 'review' | 'unsent' } = {}): HomeRow[] {
  const norm = (x = '') => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s\-_/.]+/g, '');
  const q = norm(opts.query);
  return sessions
    .map((s) => homeRow(s, local, reviews[s.id]))
    .filter((r) => !q || norm(r.fiche).includes(q) || norm(r.facility).includes(q))
    .filter((r) => opts.filter === 'review' ? r.tone === 'review' : opts.filter === 'unsent' ? r.tone === 'unsent' || r.tone === 'failed' : true)
    .sort((a, b) => b.when.localeCompare(a.when));
}
