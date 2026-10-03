// DEMO-GRADE auth: PIN login for a handful of known users on a trusted LAN. Tokens never expire and there is no
// rate limiting or TLS. Replace before any real deployment.
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Role } from '@care-agent/schema';
import { z } from 'zod';
import type { Db } from './db';
import { ApiError } from './errors';

export interface AuthUser {
  id: string;
  role: Role;
}

const UserFile = z.array(z.object({ id: z.string(), role: Role, pin: z.string().min(4) }));
const DEFAULT_USERS: { id: string; role: Role }[] = [
  { id: 'sf-01', role: 'midwife' },
  { id: 'sf-02', role: 'midwife' },
  { id: 'sup-01', role: 'supervisor' },
];

const hashPin = (pin: string) => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pin, salt, 32).toString('hex')}`;
};

function pinMatches(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  return timingSafeEqual(scryptSync(pin, Buffer.from(salt, 'hex'), 32), expected);
}

/**
 * Seeds an empty users table from DATA_DIR/users.json (`[{ id, role, pin }]`), else the demo set with random PINs.
 * Returns the generated PINs (to print once); empty when users already existed or came from the file.
 */
export function seedUsers(db: Db, dataDir: string): { id: string; pin: string }[] {
  if ((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0) return [];
  const file = join(dataDir, 'users.json');
  const insert = db.prepare('INSERT INTO users (id, role, pin_hash) VALUES (?, ?, ?)');
  if (existsSync(file)) {
    const users = UserFile.parse(JSON.parse(readFileSync(file, 'utf8')));
    db.transaction(() => users.forEach((u) => insert.run(u.id, u.role, hashPin(u.pin))))();
    return [];
  }
  const generated = DEFAULT_USERS.map((u) => ({ ...u, pin: String(randomInt(0, 1_000_000)).padStart(6, '0') }));
  db.transaction(() => generated.forEach((u) => insert.run(u.id, u.role, hashPin(u.pin))))();
  return generated.map(({ id, pin }) => ({ id, pin }));
}

export function login(db: Db, userId: unknown, pin: unknown): { token: string; role: Role } {
  const user =
    typeof userId === 'string' && typeof pin === 'string'
      ? (db.prepare('SELECT id, role, pin_hash FROM users WHERE id = ?').get(userId) as { id: string; role: Role; pin_hash: string } | undefined)
      : undefined;
  if (!user || !pinMatches(pin as string, user.pin_hash)) throw new ApiError(401, 'invalid_credentials', 'unknown user or wrong PIN');
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, new Date().toISOString());
  return { token, role: user.role };
}

export function userForToken(db: Db, header: string | undefined): AuthUser {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const user = db
    .prepare('SELECT u.id, u.role FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?')
    .get(token) as AuthUser | undefined;
  if (!user) throw new ApiError(401, 'unauthorized', 'missing or invalid token');
  return user;
}
