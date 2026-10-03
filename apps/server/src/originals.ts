import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IV_LEN = 12;
const TAG_LEN = 16;

export interface OriginalStore {
  write(pageId: string, bytes: Buffer): void;
  read(pageId: string): Buffer;
}

/** Key from ORIGINALS_KEY (64 hex chars) or DATA_DIR/originals.key, created with mode 0600 on first start. */
function loadKey(dataDir: string): Buffer {
  const fromEnv = process.env.ORIGINALS_KEY;
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) throw new Error('ORIGINALS_KEY must be 32 bytes as 64 hex characters');
    return Buffer.from(fromEnv, 'hex');
  }
  const file = join(dataDir, 'originals.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

/** AES-256-GCM files `<dir>/<pageId>.bin` = iv | tag | ciphertext. Plaintext only ever lives in memory. */
export function openOriginals(dataDir: string): OriginalStore {
  const dir = join(dataDir, 'originals');
  mkdirSync(dir, { recursive: true });
  const key = loadKey(dataDir);
  const path = (pageId: string) => join(dir, `${pageId}.bin`);
  return {
    write(pageId, bytes) {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const tmp = `${path(pageId)}.tmp`;
      writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
      renameSync(tmp, path(pageId)); // never a half-written original
    },
    read(pageId) {
      const file = readFileSync(path(pageId));
      const decipher = createDecipheriv('aes-256-gcm', key, file.subarray(0, IV_LEN));
      decipher.setAuthTag(file.subarray(IV_LEN, IV_LEN + TAG_LEN));
      return Buffer.concat([decipher.update(file.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
    },
  };
}

/** Content type from the magic bytes (the upload is stored untouched, so no type is recorded). */
export function sniffContentType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  return 'application/octet-stream';
}
