// Device-side encryption, WebCrypto only. The PIN never leaves the device through here: it is stretched into a
// non-extractable AES-GCM key that lives in memory only. A per-user "profile" (salt + encrypted canary + encrypted
// bearer token) lets the same PIN unlock the device later, offline.
export const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const CANARY = 'care-agent-canary-v1';
const MAX_FREE_FAILURES = 4; // the 5th wrong PIN starts the delay
const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

let current: CryptoKey | null = null;
export const hasKey = () => current !== null;
export const setKey = (key: CryptoKey) => void (current = key);
export const clearKey = () => void (current = null);
export function requireKey(): CryptoKey {
  if (!current) throw new Error('locked');
  return current;
}

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM with a fresh random IV: returns iv | ciphertext+tag. `aad` binds the record to its id (no swapping). */
export async function seal(key: CryptoKey, plain: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain as BufferSource));
  const out = new Uint8Array(IV_BYTES + body.length);
  out.set(iv);
  out.set(body, IV_BYTES);
  return out;
}

/** Throws when the key is wrong or the data/aad was altered. */
export async function open(key: CryptoKey, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = sealed.slice(0, IV_BYTES);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, sealed.slice(IV_BYTES)));
}

export const sealJson = (key: CryptoKey, value: unknown, aad: string) => seal(key, enc.encode(JSON.stringify(value)), aad);
export const openJson = async <T>(key: CryptoKey, sealed: Uint8Array, aad: string): Promise<T> => JSON.parse(dec.decode(await open(key, sealed, aad)));

/** What the offline unlock gives back: the bearer token of the last online login. */
export interface Secret {
  token: string;
  role: 'midwife' | 'supervisor';
}

export interface Profile {
  userId: string;
  salt: Uint8Array;
  canary: Uint8Array; // sealed CANARY: a wrong PIN fails to decrypt it
  secret: Uint8Array | null; // sealed Secret; null after logout
  failures: number; // consecutive wrong PINs
  lockedUntil: number; // epoch ms
  updatedAt: number;
}

export const sealSecret = (key: CryptoKey, userId: string, secret: Secret) => sealJson(key, secret, `secret|${userId}`);

export async function createProfile(userId: string, pin: string, secret: Secret, now = Date.now()): Promise<{ profile: Profile; key: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(pin, salt);
  const profile: Profile = {
    userId,
    salt,
    canary: await sealJson(key, CANARY, `canary|${userId}`),
    secret: await sealSecret(key, userId, secret),
    failures: 0,
    lockedUntil: 0,
    updatedAt: now,
  };
  return { profile, key };
}

/** Growing delay after repeated wrong PINs: 0 for the first 4, then 30 s, 60 s, 2 min... capped at 1 h. */
export const lockDelayMs = (failures: number) => (failures <= MAX_FREE_FAILURES ? 0 : Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (failures - MAX_FREE_FAILURES - 1)));

export type UnlockResult =
  | { ok: true; key: CryptoKey; secret: Secret | null; profile: Profile }
  | { ok: false; reason: 'wrong_pin' | 'locked'; retryInMs: number; profile: Profile };

/** Tries the PIN. The caller persists `profile` (failure counter, lock time). `ignoreLock`: the server just accepted this PIN. */
export async function unlockProfile(profile: Profile, pin: string, now = Date.now(), ignoreLock = false): Promise<UnlockResult> {
  if (!ignoreLock && now < profile.lockedUntil) return { ok: false, reason: 'locked', retryInMs: profile.lockedUntil - now, profile };
  const key = await deriveKey(pin, profile.salt);
  try {
    await open(key, profile.canary, `canary|${profile.userId}`);
  } catch {
    const failures = profile.failures + 1;
    const delay = lockDelayMs(failures);
    return { ok: false, reason: delay ? 'locked' : 'wrong_pin', retryInMs: delay, profile: { ...profile, failures, lockedUntil: delay ? now + delay : 0 } };
  }
  const secret = profile.secret ? await openJson<Secret>(key, profile.secret, `secret|${profile.userId}`) : null;
  return { ok: true, key, secret, profile: { ...profile, failures: 0, lockedUntil: 0 } };
}
