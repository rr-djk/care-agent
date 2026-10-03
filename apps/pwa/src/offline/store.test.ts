import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RecordPage } from '@care-agent/schema';
import { setKey } from './crypto';
import { addPage, createLocalSession, enroll, getBlob, listPages, listSessions, markUploaded, wipe } from './store';

const SECRET_BYTES = new TextEncoder().encode('ORIGINAL-IMAGE-BYTES-THAT-MUST-NEVER-BE-READABLE-0123456789');
const TOKEN = 'bearer-token-that-must-never-be-readable';
const SHA = 'cd'.repeat(32);
const ID = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

/** Every value of every object store, as the raw bytes a forensic reader of the device would get. */
async function rawDump(): Promise<Buffer> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('care-agent-offline');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const parts: Buffer[] = [];
  const walk = (v: unknown) => {
    if (v instanceof Uint8Array) parts.push(Buffer.from(v));
    else if (typeof v === 'string') parts.push(Buffer.from(v));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => (parts.push(Buffer.from(k)), walk(x)));
  };
  for (const name of Array.from(db.objectStoreNames)) {
    const rows = await new Promise<unknown[]>((resolve) => {
      const r = db.transaction(name).objectStore(name).getAll();
      r.onsuccess = () => resolve(r.result);
    });
    rows.forEach(walk);
  }
  db.close();
  return Buffer.concat(parts);
}

beforeEach(async () => {
  await wipe();
});

describe('encrypted store', () => {
  it('nothing sensitive is readable in the database: image bytes, token, sha256, session details', async () => {
    await enroll({ token: TOKEN, role: 'midwife', userId: 'sf-01' }, '123456');
    await createLocalSession('sf-01', { id: SESSION, midwife_id: 'sf-01', fiche_number: 'FICHE-4242', facility: 'Centre-Secret', started_at: 't', page_ids: [] });
    const meta: RecordPage = { id: ID, session_id: SESSION, page_type: 3, captured_at: '2026-10-03T10:00:00.000Z', midwife_id: 'sf-01', sha256: SHA, state: 'CAPTURED', flags: [] };
    await addPage('sf-01', meta, SECRET_BYTES, 'image/png');
    const dump = await rawDump();
    expect(dump.length).toBeGreaterThan(SECRET_BYTES.length); // really dumped something
    for (const needle of [SECRET_BYTES, TOKEN, SHA, 'FICHE-4242', 'Centre-Secret', 'image/png', '2026-10-03']) {
      expect(dump.includes(Buffer.from(needle)), String(needle)).toBe(false);
    }
    // the clear parts are only ids, the owner, the order and the queue state
    expect(dump.includes(Buffer.from(ID))).toBe(true);
  });

  it('keeps the quality result and the LOW_QUALITY flag of a page in its (encrypted) meta', async () => {
    await enroll({ token: TOKEN, role: 'midwife', userId: 'sf-01' }, '123456');
    const quality = { outcome: 'WARNING' as const, metrics: { blur: 120, brightness: 180, glare: 0, framing: 0.9 }, messages: ['Photo floue : rapprochez-vous et tenez le téléphone immobile'] };
    const meta: RecordPage = { id: ID, session_id: SESSION, page_type: 3, captured_at: 't', midwife_id: 'sf-01', sha256: SHA, state: 'CAPTURED', flags: ['LOW_QUALITY'], quality };
    await addPage('sf-01', meta, SECRET_BYTES, 'image/png');
    const [page] = await listPages('sf-01');
    expect(page.meta.flags).toEqual(['LOW_QUALITY']);
    expect(page.meta.quality).toEqual(quality);
    expect((await rawDump()).includes(Buffer.from('floue'))).toBe(false); // still sealed at rest
  });

  it('keeps the original bytes exactly, deletes the blob once uploaded but keeps the meta with the server state', async () => {
    await enroll({ token: TOKEN, role: 'midwife', userId: 'sf-01' }, '123456');
    const meta: RecordPage = { id: ID, session_id: SESSION, page_type: 3, captured_at: 't', midwife_id: 'sf-01', sha256: SHA, state: 'CAPTURED', flags: [] };
    const page = await addPage('sf-01', meta, SECRET_BYTES, 'image/png');
    expect(page).toMatchObject({ state: 'CAPTURED', attempts: 0 });
    expect(await getBlob(ID)).toEqual(SECRET_BYTES);
    await markUploaded(page, 'PENDING_AI');
    expect(await getBlob(ID)).toBeNull();
    expect(await listPages('sf-01')).toMatchObject([{ id: ID, state: 'UPLOADED', server: 'PENDING_AI' }]);
  });

  it("one user's queue is not listed for another; a record cannot be decrypted with another key", async () => {
    await enroll({ token: TOKEN, role: 'midwife', userId: 'sf-01' }, '123456');
    await createLocalSession('sf-01', { id: SESSION, midwife_id: 'sf-01', started_at: 't', page_ids: [] });
    expect(await listSessions('sf-02')).toEqual([]);
    setKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    await expect(listSessions('sf-01')).rejects.toThrow();
  });
});
