// Patients, linking decisions and the longitudinal record (database side). The pure rules are in linking.ts (candidates,
// question) and record.ts (retained values, re-digitization). A patient exists only after a midwife decision; her id is
// the next PAT-nnnnnn of a server counter, never derived from the data. No identifier is stored or returned.
import type { Difference, ExtractedField, LinkDecision, LinkProposal, LinkResult, Patient, PatientRecord, RecordPage } from '@care-agent/schema';
import type { AuthUser } from './auth';
import { getFields, getPage, type Db } from './db';
import { ApiError } from './errors';
import { pageSchemaFor } from './fields';
import { transition } from './lifecycle';
import { propose, type Attributes, type KnownPatient, type SessionKey } from './linking';
import { applyPage, buildValues, findConflicts, usable, valueKey, type Choice, type ValuePage, type Values } from './record';

// Cover (page 1), identification (page 2) and pregnancy (page 3) fields that feed the key and the cross-checks.
const FICHE = 'p01.n_deg_de_la_fiche';
const FACILITY = 'p01.nom_de_l_etablissement_sanitaire';

interface SessionRow {
  id: string;
  midwife_id: string;
  fiche_number: string | null;
  facility: string | null;
  started_at: string;
}

const sessionRow = (db: Db, id: string) =>
  db.prepare('SELECT id, midwife_id, fiche_number, facility, started_at FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;

/** Pages of a session still in play (a retaken page is left out), in capture order, with their fields. */
function sessionPages(db: Db, sessionId: string): { page: RecordPage; fields: ExtractedField[] }[] {
  const ids = db.prepare('SELECT id FROM pages WHERE session_id = ? ORDER BY captured_at, rowid').all(sessionId) as { id: string }[];
  return ids
    .map(({ id }) => ({ page: getPage(db, id)!, fields: getFields(db, id) }))
    .filter(({ page }) => !page.flags.includes('SUPERSEDED'));
}

const toValuePage = ({ page, fields }: { page: RecordPage; fields: ExtractedField[] }): ValuePage => ({
  id: page.id,
  page_type: page.page_type,
  captured_at: page.captured_at,
  fields,
});

const text = (values: Values, pageType: number, fieldId: string) => {
  const f = values.get(valueKey({ page_type: pageType }, fieldId))?.field;
  return f && usable(f) ? String(f.value) : undefined;
};
const number = (values: Values, pageType: number, fieldId: string) => {
  const v = text(values, pageType, fieldId);
  return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
};

function attributesOf(values: Values): Attributes {
  return {
    age: number(values, 2, 'p02.age'),
    gestation: number(values, 2, 'p02.gestation'),
    parite: number(values, 2, 'p02.parite'),
    ddr: text(values, 3, 'p03.ddr'),
    province: text(values, 1, 'p01.province'),
  };
}

/** Link key of a session: what the midwife typed or confirmed wins over what the cover says. */
function sessionKey(db: Db, session: SessionRow): SessionKey {
  const values = buildValues(sessionPages(db, session.id).map(toValuePage), new Map());
  const cover = { fiche: text(values, 1, FICHE), facility: text(values, 1, FACILITY) };
  return {
    fiche: session.fiche_number ?? cover.fiche ?? null,
    facility: session.facility ?? cover.facility ?? null,
    source: session.fiche_number ? 'typed' : cover.fiche ? 'cover' : 'none',
    attrs: attributesOf(values),
  };
}

// --- patients and their record -------------------------------------------------------------------------------

/** Pages of the sessions linked to a patient, in record order (link time, then capture). */
function linkedPages(db: Db, patientId: string): ValuePage[] {
  const ids = db
    .prepare(
      `SELECT p.id FROM pages p JOIN session_links l ON l.session_id = p.session_id
       WHERE l.patient_id = ? AND p.state IN ('PATIENT_MATCHED', 'REGISTERED', 'SYNCED')
       ORDER BY l.decided_at, p.captured_at, p.rowid`,
    )
    .all(patientId) as { id: string }[];
  return ids
    .map(({ id }) => ({ page: getPage(db, id)!, fields: getFields(db, id) }))
    .filter(({ page }) => !page.flags.includes('SUPERSEDED'))
    .map(toValuePage);
}

function recordValues(db: Db, patientId: string): Values {
  const rows = db.prepare('SELECT page_id, field_id, choice FROM redigitization WHERE patient_id = ?').all(patientId) as { page_id: string; field_id: string; choice: Choice }[];
  return buildValues(linkedPages(db, patientId), new Map(rows.map((r) => [`${r.page_id}|${r.field_id}`, r.choice])));
}

const getPatient = (db: Db, id: string) => db.prepare('SELECT id, fiche_number, facility, created_at FROM patients WHERE id = ?').get(id) as Patient | undefined;

function knownPatients(db: Db): KnownPatient[] {
  const rows = db.prepare('SELECT id, fiche_number, facility, created_at FROM patients ORDER BY id').all() as Patient[];
  return rows.map((p) => {
    const v = db
      .prepare('SELECT COUNT(*) AS n, MAX(s.started_at) AS last FROM session_links l JOIN sessions s ON s.id = l.session_id WHERE l.patient_id = ?')
      .get(p.id) as { n: number; last: string | null };
    return { id: p.id, fiche_number: p.fiche_number, facility: p.facility, attrs: attributesOf(recordValues(db, p.id)), visits: v.n, last_visit: v.last ?? undefined };
  });
}

/** The link question of a session (read-only: nothing is created or linked here). */
export function proposalFor(db: Db, sessionId: string): LinkProposal {
  const session = sessionRow(db, sessionId);
  if (!session) throw new ApiError(404, 'session_not_found', 'unknown session');
  return propose(sessionId, sessionKey(db, session), knownPatients(db));
}

/** The same question for a typed (fiche, facility), without a session: no cross-check attributes. */
export const proposalForKey = (db: Db, fiche: string, facility: string): LinkProposal =>
  propose('', { fiche, facility, source: 'typed', attrs: {} }, knownPatients(db));

// --- decision ------------------------------------------------------------------------------------------------

const patientId = (n: number) => `PAT-${String(n).padStart(6, '0')}`;

/** Re-digitization differences of a session, with the old and new values. */
export function differencesOf(db: Db, sessionId: string): Difference[] {
  const rows = db
    .prepare(
      `SELECT r.page_id, r.field_id, r.old_page_id, r.choice, r.decided_at FROM redigitization r JOIN pages p ON p.id = r.page_id
       WHERE p.session_id = ? ORDER BY p.captured_at, r.rowid`,
    )
    .all(sessionId) as { page_id: string; field_id: string; old_page_id: string; choice: Choice; decided_at: string | null }[];
  return rows.map((r) => {
    const page = getPage(db, r.page_id)!;
    const value = (pageId: string) => getFields(db, pageId).find((f) => f.field_id === r.field_id)?.value ?? null;
    return {
      page_id: r.page_id,
      field_id: r.field_id,
      label_fr: pageSchemaFor(page.page_type)?.fields.find((f) => f.id === r.field_id)?.label_fr ?? r.field_id,
      page_type: page.page_type,
      old_value: value(r.old_page_id),
      old_date: getPage(db, r.old_page_id)!.captured_at,
      new_value: value(r.page_id),
      choice: r.choice,
      decided: r.decided_at !== null,
    };
  });
}

/**
 * The midwife's decision for a session. `patient` links to a known patient, `create_new` allocates the next PAT id,
 * `not_sure` parks the pages in DUPLICATE_SUSPECTED (settled later with the same call). Pages go VALIDATED (or
 * DUPLICATE_SUSPECTED) -> PATIENT_MATCHED -> REGISTERED. Fields of a page type already in the record that differ from a
 * retained value are stored as differences (default choice applied, midwife may change it).
 */
export function linkSession(db: Db, user: AuthUser, sessionId: string, decision: LinkDecision): LinkResult {
  const session = sessionRow(db, sessionId)!;
  const existing = db.prepare('SELECT decision FROM session_links WHERE session_id = ?').get(sessionId) as { decision: string } | undefined;
  if (existing && existing.decision !== 'not_sure') throw new ApiError(409, 'already_linked', 'this session is already linked');
  if (existing && decision.kind === 'not_sure') return { status: 'not_sure', differences: [] };
  const pages = sessionPages(db, sessionId);
  const from = existing ? 'DUPLICATE_SUSPECTED' : 'VALIDATED';
  if (!pages.length || pages.some((p) => p.page.state !== from)) throw new ApiError(409, 'session_not_ready', `every page of the session must be ${from}`);

  let known: Patient | undefined;
  if (decision.kind === 'patient') {
    known = getPatient(db, decision.patient_id);
    if (!known) throw new ApiError(404, 'patient_not_found', 'unknown patient');
  }
  const key = decision.kind === 'create_new' ? sessionKey(db, session) : undefined;
  if (key && (!key.fiche || !key.facility)) throw new ApiError(409, 'link_key_missing', 'the fiche number and the facility are required to create a patient');

  const now = new Date().toISOString();
  return db.transaction((): LinkResult => {
    let patient = known;
    if (key) {
      db.prepare("INSERT INTO counters (id, value) VALUES ('patient', 1) ON CONFLICT (id) DO UPDATE SET value = value + 1").run();
      const n = (db.prepare("SELECT value FROM counters WHERE id = 'patient'").get() as { value: number }).value;
      patient = { id: patientId(n), fiche_number: key.fiche!, facility: key.facility!, created_at: now };
      db.prepare('INSERT INTO patients (id, fiche_number, facility, created_at) VALUES (?, ?, ?, ?)').run(patient.id, patient.fiche_number, patient.facility, now);
    }
    db.prepare('INSERT OR REPLACE INTO session_links (session_id, patient_id, decision, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)').run(
      sessionId,
      patient?.id ?? null,
      decision.kind,
      user.id,
      now,
    );
    if (!patient) {
      for (const { page } of pages) transition(db, page.id, 'DUPLICATE_SUSPECTED', user.id);
      return { status: 'not_sure', differences: [] };
    }
    // differences against what the record held before this session, page by page (a later page sees the earlier ones)
    const values = recordValues(db, patient.id);
    const put = db.prepare('INSERT INTO redigitization (page_id, field_id, patient_id, old_page_id, choice) VALUES (?, ?, ?, ?, ?)');
    for (const vp of pages.map(toValuePage)) {
      const conflicts = findConflicts(values, vp);
      for (const c of conflicts) put.run(vp.id, c.field_id, patient.id, c.old.page_id, c.default);
      applyPage(values, vp, new Map(conflicts.map((c) => [c.field_id, c.default])));
    }
    for (const { page } of pages) {
      transition(db, page.id, 'PATIENT_MATCHED', user.id);
      transition(db, page.id, 'REGISTERED', user.id);
    }
    const visits = (db.prepare('SELECT COUNT(*) AS n FROM session_links WHERE patient_id = ?').get(patient.id) as { n: number }).n;
    return { status: 'linked', patient, visits, differences: differencesOf(db, sessionId) };
  })();
}

/** The midwife settles differences: each `{ page_id, field_id, choice }` must be one of the session's differences. */
export function saveChoices(db: Db, user: AuthUser, sessionId: string, choices: { page_id: string; field_id: string; choice: Choice }[]): Difference[] {
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const c of choices) {
      const r = db
        .prepare('UPDATE redigitization SET choice = ?, decided_by = ?, decided_at = ? WHERE page_id = ? AND field_id = ? AND page_id IN (SELECT id FROM pages WHERE session_id = ?)')
        .run(c.choice, user.id, now, c.page_id, c.field_id, sessionId);
      if (!r.changes) throw new ApiError(404, 'not_found', 'no such difference in this session');
    }
  })();
  return differencesOf(db, sessionId);
}

/**
 * SYNCED = the phone acknowledged the registered record: it received the link result and showed the record. Only
 * REGISTERED pages move (REGISTERED -> SYNCED); a replay changes nothing.
 */
export function acknowledge(db: Db, user: AuthUser, sessionId: string): void {
  const pages = sessionPages(db, sessionId);
  if (!pages.length || pages.some((p) => p.page.state !== 'REGISTERED' && p.page.state !== 'SYNCED')) {
    throw new ApiError(409, 'not_registered', 'the session is not registered yet');
  }
  for (const { page } of pages) if (page.state === 'REGISTERED') transition(db, page.id, 'SYNCED', user.id);
}

// --- reading -------------------------------------------------------------------------------------------------

/** Sessions parked by "Je ne sais pas": the supervisor sees all, a midwife her own. */
export function duplicates(db: Db, user: AuthUser) {
  const rows = db
    .prepare(
      `SELECT l.session_id, l.decided_at, s.midwife_id FROM session_links l JOIN sessions s ON s.id = l.session_id
       WHERE l.decision = 'not_sure' ORDER BY l.decided_at`,
    )
    .all() as { session_id: string; decided_at: string; midwife_id: string }[];
  return rows
    .filter((r) => user.role === 'supervisor' || r.midwife_id === user.id)
    .map((r) => ({ ...r, proposal: proposalFor(db, r.session_id) }));
}

/** The longitudinal record: visits in date order and the retained value of every non-empty field with its source page. */
export function patientRecord(db: Db, user: AuthUser, id: string): PatientRecord {
  const patient = getPatient(db, id);
  if (!patient) throw new ApiError(404, 'not_found', 'patient not found');
  if (user.role !== 'supervisor') {
    const mine = db
      .prepare('SELECT 1 FROM session_links l JOIN sessions s ON s.id = l.session_id WHERE l.patient_id = ? AND s.midwife_id = ?')
      .get(id, user.id);
    if (!mine) throw new ApiError(403, 'forbidden', 'no session of yours is linked to this patient');
  }
  const sessions = db
    .prepare('SELECT s.id, s.started_at FROM session_links l JOIN sessions s ON s.id = l.session_id WHERE l.patient_id = ? ORDER BY l.decided_at')
    .all(id) as { id: string; started_at: string }[];
  const visits = sessions.map((s) => ({
    session_id: s.id,
    date: s.started_at,
    pages: sessionPages(db, s.id).map(({ page }) => ({ page_id: page.id, page_type: page.page_type, captured_at: page.captured_at, state: page.state })),
  }));
  const order = (r: { page_type?: number; field: ExtractedField }) => {
    const fields = pageSchemaFor(r.page_type)?.fields ?? [];
    return (r.page_type ?? 0) * 1000 + Math.max(0, fields.findIndex((f) => f.id === r.field.field_id));
  };
  const values = [...recordValues(db, id).values()]
    .filter((r) => usable(r.field))
    .sort((a, b) => order(a) - order(b))
    .map((r) => ({
      page_type: r.page_type,
      field_id: r.field.field_id,
      label_fr: pageSchemaFor(r.page_type)?.fields.find((f) => f.id === r.field.field_id)?.label_fr ?? r.field.field_id,
      value: r.field.value,
      source_page_id: r.page_id,
      source_date: r.captured_at,
    }));
  return { patient, visits, values };
}
