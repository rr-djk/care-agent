import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExtractedField, RecordPage } from '@care-agent/schema';

export type Db = Database.Database;

export const repoRoot = resolve(import.meta.dirname, '../../..');
export const dataDirFromEnv = () => resolve(process.env.DATA_DIR ?? `${repoRoot}/data`);

// Ordered, append-only: entry i is schema version i + 1. No column holds a personal identifier.
const MIGRATIONS = [
  `
  CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, pin_hash TEXT NOT NULL);
  CREATE TABLE auth_tokens (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, midwife_id TEXT NOT NULL, fiche_number TEXT, facility TEXT, started_at TEXT NOT NULL
  );
  CREATE TABLE pages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, page_type INTEGER, captured_at TEXT NOT NULL,
    midwife_id TEXT NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL, flags TEXT NOT NULL, quality TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX pages_session ON pages (session_id);
  CREATE TABLE page_transitions (page_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL);
  CREATE TABLE fields (page_id TEXT NOT NULL, field_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (page_id, field_id));
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL, field_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    role TEXT NOT NULL, old_json TEXT NOT NULL, new_json TEXT NOT NULL, at TEXT NOT NULL
  );
  CREATE TABLE originals_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL, actor_id TEXT NOT NULL, role TEXT NOT NULL,
    allowed INTEGER NOT NULL, at TEXT NOT NULL
  );
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, json TEXT NOT NULL);
  CREATE INDEX events_session ON events (session_id, id);
  `,
];

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'care-agent.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const current = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get() as { v: number }).v;
  MIGRATIONS.slice(current).forEach((sql, i) => {
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(current + i + 1);
    })();
  });
  return db;
}

interface PageRow {
  id: string;
  session_id: string;
  page_type: number | null;
  captured_at: string;
  midwife_id: string;
  sha256: string;
  state: RecordPage['state'];
  flags: string;
  quality: string | null;
}

export function getPage(db: Db, id: string): RecordPage | undefined {
  const r = db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as PageRow | undefined;
  if (!r) return undefined;
  return {
    id: r.id,
    session_id: r.session_id,
    page_type: r.page_type ?? undefined,
    captured_at: r.captured_at,
    midwife_id: r.midwife_id,
    sha256: r.sha256,
    state: r.state,
    flags: JSON.parse(r.flags),
    quality: r.quality ? JSON.parse(r.quality) : undefined,
  };
}

export function getFields(db: Db, pageId: string): ExtractedField[] {
  const rows = db.prepare('SELECT json FROM fields WHERE page_id = ? ORDER BY rowid').all(pageId) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json));
}
