import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RecordPage } from '@care-agent/schema';
import { DeviceError } from '../errors';
import { clearKey, createProfile, hasKey, lockDelayMs, open, PBKDF2_ITERATIONS, seal, unlockProfile } from './crypto';
import { addPage, enroll, getBlob, listPages, logout, unlock, wipe } from './store';

const secret = { token: 'tok-0123456789abcdef-SECRET', role: 'midwife' as const };
const PNG = Uint8Array.from({ length: 256 }, (_, i) => (i * 7 + 3) % 256); // stands for the original image bytes
const meta = (id: string): RecordPage => ({
  id,
  session_id: '11111111-1111-4111-8111-111111111111',
  page_type: 3,
  captured_at: '2026-10-03T10:00:00.000Z',
  midwife_id: 'sf-01',
  sha256: 'ab'.repeat(32),
  state: 'CAPTURED',
  flags: [],
});

beforeEach(async () => {
  await wipe();
});

describe('crypto', () => {
  it('uses at least 310 000 PBKDF2 iterations', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(310_000);
  });

  it('round trip with a fresh IV each time; the key cannot be exported; altered data or another id is refused', async () => {
    const { key } = await createProfile('sf-01', '123456', secret);
    const a = await seal(key, PNG, 'blob|x');
    const b = await seal(key, PNG, 'blob|x');
    expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12));
    expect(await open(key, a, 'blob|x')).toEqual(PNG);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    const tampered = a.slice();
    tampered[20] ^= 1;
    await expect(open(key, tampered, 'blob|x')).rejects.toThrow();
    await expect(open(key, a, 'blob|other')).rejects.toThrow();
  });

  it('wrong PIN is refused, the right one gives the token back; after 5 failures a growing delay applies', async () => {
    const { profile } = await createProfile('sf-01', '123456', secret);
    const good = await unlockProfile(profile, '123456');
    expect(good.ok && good.secret).toEqual(secret);
    let p = profile;
    const now = 1_000_000;
    for (let i = 1; i <= 4; i++) {
      const r = await unlockProfile(p, '000000', now);
      expect(r).toMatchObject({ ok: false, reason: 'wrong_pin', retryInMs: 0 });
      p = r.profile;
    }
    const fifth = await unlockProfile(p, '000000', now);
    expect(fifth).toMatchObject({ ok: false, reason: 'locked', retryInMs: 30_000 });
    // locked: even the right PIN is refused until the delay passes
    expect(await unlockProfile(fifth.profile, '123456', now + 1000)).toMatchObject({ ok: false, reason: 'locked' });
    expect((await unlockProfile(fifth.profile, '123456', now + 31_000)).ok).toBe(true);
    expect([5, 6, 7, 20].map(lockDelayMs)).toEqual([30_000, 60_000, 120_000, 3_600_000]);
  });
});

describe('device vault', () => {
  it('enroll online, then unlock with the same PIN: token back, queued page readable; wrong PIN refused and persisted', async () => {
    await enroll({ token: secret.token, role: 'midwife', userId: 'sf-01' }, '123456');
    await addPage('sf-01', meta('22222222-2222-4222-8222-222222222222'), PNG, 'image/png');
    clearKey(); // "reload": the key only lived in memory
    expect(hasKey()).toBe(false);
    await expect(unlock('sf-01', '654321')).rejects.toMatchObject({ code: 'wrong_pin' });
    expect(hasKey()).toBe(false);
    const auth = await unlock('sf-01', '123456');
    expect(auth).toEqual({ token: secret.token, role: 'midwife', userId: 'sf-01' });
    const [page] = await listPages('sf-01');
    expect(page.state).toBe('CAPTURED');
    expect(await getBlob(page.id)).toEqual(PNG);
  });

  it('5 wrong PINs lock the unlock (counter survives a reload)', async () => {
    await enroll({ token: secret.token, role: 'midwife', userId: 'sf-01' }, '123456');
    clearKey();
    for (let i = 0; i < 4; i++) await expect(unlock('sf-01', '0')).rejects.toMatchObject({ code: 'wrong_pin' });
    await expect(unlock('sf-01', '0')).rejects.toMatchObject({ code: 'locked' });
    await expect(unlock('sf-01', '123456')).rejects.toBeInstanceOf(DeviceError);
  });

  it('logout wipes the key and the token but keeps the encrypted queue; logging in again with the same PIN reopens it', async () => {
    await enroll({ token: secret.token, role: 'midwife', userId: 'sf-01' }, '123456');
    await addPage('sf-01', meta('22222222-2222-4222-8222-222222222222'), PNG, 'image/png');
    await logout('sf-01');
    expect(hasKey()).toBe(false);
    await expect(unlock('sf-01', '123456')).rejects.toMatchObject({ code: 'no_token' });
    await enroll({ token: 'new-token', role: 'midwife', userId: 'sf-01' }, '123456');
    expect(await listPages('sf-01')).toHaveLength(1);
    expect((await unlock('sf-01', '123456')).token).toBe('new-token');
  });

  it('a PIN the device does not know never replaces a key that guards queued pages', async () => {
    await enroll({ token: secret.token, role: 'midwife', userId: 'sf-01' }, '123456');
    await addPage('sf-01', meta('22222222-2222-4222-8222-222222222222'), PNG, 'image/png');
    await expect(enroll({ token: 't', role: 'midwife', userId: 'sf-01' }, '999999')).rejects.toMatchObject({ code: 'device_pin_mismatch' });
  });

  it('wipe removes everything', async () => {
    await enroll({ token: secret.token, role: 'midwife', userId: 'sf-01' }, '123456');
    await addPage('sf-01', meta('22222222-2222-4222-8222-222222222222'), PNG, 'image/png');
    await wipe();
    expect(hasKey()).toBe(false);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('care-agent-offline'); // the database itself is gone
    await expect(unlock('sf-01', '123456')).rejects.toMatchObject({ code: 'no_profile' });
  });
});
