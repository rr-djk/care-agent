// Encrypted IndexedDB (no library). Stores: `profiles` (salt, encrypted canary and token), `sessions`, `pages` (meta)
// and `blobs` (image bytes). Every record body is AES-GCM sealed with the in-memory key (random IV per record, the record
// id as additional data). Only ids, the owner, an order number and the queue state are in clear, for lookup.
import type { LifecycleState, RecordPage, Role, Session } from '@care-agent/schema';
import type { Auth } from '../api';
import { DeviceError } from '../errors';
import { clearKey, createProfile, hasKey, openJson, open as openBytes, requireKey, seal, sealJson, sealSecret, setKey, unlockProfile, type Profile } from './crypto';

const DB_NAME = 'care-agent-offline';
const STORES = ['profiles', 'sessions', 'pages', 'blobs'] as const;

/** CAPTURED = queued (not on the server yet); UPLOADED = the server confirmed the same sha256; SYNC_FAILED = refused, needs the midwife. */
export type QueueState = 'CAPTURED' | 'UPLOADED' | 'SYNC_FAILED';

export interface LocalSession {
  id: string;
  userId: string;
  seq: number;
  synced: boolean; // created on the server
  session: Session;
}

export interface LocalPage {
  id: string;
  userId: string;
  seq: number; // capture order
  state: QueueState;
  meta: RecordPage;
  mime: string;
  attempts: number;
  nextAttemptAt: number; // epoch ms, backoff
  error?: string; // code of the refusal (SYNC_FAILED)
  server?: LifecycleState; // state reported by the server at upload
}

interface Row {
  id: string;
  userId: string;
  seq: number;
  state?: QueueState;
  body: Uint8Array;
}

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const name of STORES) req.result.createObjectStore(name, { keyPath: name === 'profiles' ? 'userId' : 'id' });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));
const committed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => ((tx.oncomplete = () => resolve()), (tx.onerror = () => reject(tx.error)), (tx.onabort = () => reject(tx.error))));

async function all<T>(store: (typeof STORES)[number]): Promise<T[]> {
  return wrap((await db()).transaction(store).objectStore(store).getAll());
}
async function one<T>(store: (typeof STORES)[number], key: string): Promise<T | undefined> {
  return wrap((await db()).transaction(store).objectStore(store).get(key));
}
async function write(puts: [(typeof STORES)[number], unknown][], deletes: [(typeof STORES)[number], string][] = []) {
  const tx = (await db()).transaction([...puts.map(([s]) => s), ...deletes.map(([s]) => s)], 'readwrite');
  for (const [s, v] of puts) tx.objectStore(s).put(v);
  for (const [s, k] of deletes) tx.objectStore(s).delete(k);
  await committed(tx);
}

let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(Date.now(), lastSeq + 1));

// --- profiles (the device vault) ---

export const getProfile = (userId: string) => one<Profile>('profiles', userId);
const putProfile = (p: Profile) => write([['profiles', p]]);
export const listProfiles = () => all<Profile>('profiles');

/** Users with something left on the device, in clear: just ids. */
async function hasRecords(userId: string) {
  const rows = [...(await all<Row>('sessions')), ...(await all<Row>('pages'))];
  return rows.some((r) => r.userId === userId);
}

/** After an ONLINE login: derive (or re-derive) the key from the PIN and store the encrypted token. */
export async function enroll(auth: Auth, pin: string): Promise<void> {
  const secret = { token: auth.token, role: auth.role };
  const existing = await getProfile(auth.userId);
  if (existing) {
    const r = await unlockProfile(existing, pin, Date.now(), true);
    if (r.ok) {
      setKey(r.key);
      return putProfile({ ...r.profile, secret: await sealSecret(r.key, auth.userId, secret), updatedAt: Date.now() });
    }
    // The server accepts a PIN this device does not know: never overwrite a key that still guards queued pages.
    if (await hasRecords(auth.userId)) throw new DeviceError('device_pin_mismatch');
  }
  const { profile, key } = await createProfile(auth.userId, pin, secret);
  await putProfile(profile);
  setKey(key);
}

/** OFFLINE-capable unlock with the same user id + PIN. Wrong PIN / locked throw a DeviceError; the counter is persisted. */
export async function unlock(userId: string, pin: string): Promise<Auth> {
  const profile = await getProfile(userId);
  if (!profile) throw new DeviceError('no_profile');
  const r = await unlockProfile(profile, pin);
  await putProfile(r.profile);
  if (!r.ok) throw new DeviceError(r.reason, r.retryInMs);
  if (!r.secret) throw new DeviceError('no_token'); // logged out: the server must be reached to log in again
  setKey(r.key);
  return { token: r.secret.token, role: r.secret.role as Role, userId };
}

/** Logout: forget the key (memory) and delete the stored token. Queued pages stay, encrypted. */
export async function logout(userId: string): Promise<void> {
  clearKey();
  const profile = await getProfile(userId);
  if (profile) await putProfile({ ...profile, secret: null, updatedAt: Date.now() });
}

/** « Effacer les données de l'appareil »: forgets the key and deletes the whole database. */
export async function wipe(): Promise<void> {
  clearKey();
  const open = dbp;
  dbp = null;
  (await open?.catch(() => undefined))?.close();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export const isUnlocked = hasKey;

// --- sessions and pages ---

const aad = (kind: string, id: string) => `${kind}|${id}`;

async function toSession(r: Row): Promise<LocalSession> {
  const { synced, session } = await openJson<Pick<LocalSession, 'synced' | 'session'>>(requireKey(), r.body, aad('session', r.id));
  return { id: r.id, userId: r.userId, seq: r.seq, synced, session };
}
async function toPage(r: Row): Promise<LocalPage> {
  const body = await openJson<Omit<LocalPage, 'id' | 'userId' | 'seq' | 'state'>>(requireKey(), r.body, aad('page', r.id));
  return { id: r.id, userId: r.userId, seq: r.seq, state: r.state!, ...body };
}
const pageRow = async (p: LocalPage): Promise<Row> => {
  const { id, userId, seq, state, ...body } = p;
  return { id, userId, seq, state, body: await sealJson(requireKey(), body, aad('page', id)) };
};

export async function saveSession(s: LocalSession): Promise<void> {
  const row: Row = { id: s.id, userId: s.userId, seq: s.seq, body: await sealJson(requireKey(), { synced: s.synced, session: s.session }, aad('session', s.id)) };
  await write([['sessions', row]]);
}

export async function createLocalSession(userId: string, session: Session): Promise<LocalSession> {
  const local = { id: session.id, userId, seq: nextSeq(), synced: false, session };
  await saveSession(local);
  return local;
}

export async function listSessions(userId: string): Promise<LocalSession[]> {
  const rows = (await all<Row>('sessions')).filter((r) => r.userId === userId).sort((a, b) => a.seq - b.seq);
  return Promise.all(rows.map(toSession));
}

/** Stores the page meta and the ORIGINAL bytes (never re-encoded) in one transaction. */
export async function addPage(userId: string, meta: RecordPage, bytes: Uint8Array, mime: string): Promise<LocalPage> {
  const page: LocalPage = { id: meta.id, userId, seq: nextSeq(), state: 'CAPTURED', meta, mime, attempts: 0, nextAttemptAt: 0 };
  const blob = { id: meta.id, body: await seal(requireKey(), bytes, aad('blob', meta.id)) };
  await write([
    ['pages', await pageRow(page)],
    ['blobs', blob],
  ]);
  return page;
}

export async function listPages(userId: string): Promise<LocalPage[]> {
  const rows = (await all<Row>('pages')).filter((r) => r.userId === userId).sort((a, b) => a.seq - b.seq);
  return Promise.all(rows.map(toPage));
}

export async function savePage(p: LocalPage): Promise<void> {
  await write([['pages', await pageRow(p)]]);
}

export async function getBlob(id: string): Promise<Uint8Array | null> {
  const row = await one<{ id: string; body: Uint8Array }>('blobs', id);
  return row ? openBytes(requireKey(), row.body, aad('blob', id)) : null;
}

/** The server confirmed the page: record it and delete the image bytes in the same transaction. */
export async function markUploaded(p: LocalPage, server: LifecycleState): Promise<void> {
  await write([['pages', await pageRow({ ...p, state: 'UPLOADED', server, error: undefined })]], [['blobs', p.id]]);
}

/** Final review state reached (page confirmed): the local meta is no longer needed. */
export async function deletePage(id: string): Promise<void> {
  await write([], [
    ['pages', id],
    ['blobs', id],
  ]);
}
