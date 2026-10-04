// Linking engine (pure): which known patients could be the woman of a session? Never decides anything: it only builds
// candidates and the question the midwife answers. Matching key = the fiche number (the code written on the registry),
// narrowed by the facility when one is known; age, LMP (DDR),
// gravidity/parity and province are cross-checks. Nothing here is an identifier.
import type { Candidate, CandidateKind, LinkProposal } from '@care-agent/schema';

export interface Attributes {
  age?: number;
  ddr?: string; // dd/mm/yyyy
  gestation?: number; // gravidity
  parite?: number;
  province?: string;
}

export interface KnownPatient {
  id: string;
  fiche_number: string;
  facility: string;
  attrs: Attributes;
  visits: number;
  last_visit?: string;
}

export interface SessionKey {
  fiche: string | null; // as typed by the midwife or read on the cover
  facility: string | null;
  source: 'typed' | 'cover' | 'none'; // where the fiche number comes from (typed = confirmed by the midwife)
  attrs: Attributes;
}

// --- normalization -------------------------------------------------------------------------------------------

const FICHE_SHAPE = /^\d{4}-\d{3}-\d{3}$/; // year-facility-sequence, as on the specimens

/**
 * Link key of a fiche number: trimmed, upper case, every separator (space, slash, dot, underscore, dash variants) is "-",
 * "O" read for 0 and "I"/"L" read for 1 are corrected for matching. A correction, or a shape that is not 2026-823-001,
 * makes the reading low confidence: the midwife must confirm it.
 */
export function normalizeFiche(raw: string): { key: string; low_confidence: boolean } {
  let low = false;
  let key = raw.trim().toUpperCase().replace(/[\s/._‐-―−-]+/g, '-');
  const fixed = key.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (fixed !== key) low = true;
  key = fixed;
  if (/^\d{10}$/.test(key)) key = `${key.slice(0, 4)}-${key.slice(4, 7)}-${key.slice(7)}`;
  return { key, low_confidence: low || !FICHE_SHAPE.test(key) };
}

/** Facility key: no accents, lower case, letters and digits separated by single spaces. */
export const normalizeFacility = (raw: string) =>
  raw.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

const dayNumber = (ddmmyyyy?: string): number | undefined => {
  const m = ddmmyyyy ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy) : null;
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86_400_000 : undefined;
};

// --- cross-checks --------------------------------------------------------------------------------------------

const NEAR_AGE = 1; // years
const NEAR_DDR = 7; // days: a near-match candidate
const SAME_DDR = 14; // days: beyond this the LMP contradicts the candidate

/** Concordances and contradictions (French) between the session and a known patient; each only when both sides have the value. */
export function crossCheck(session: Attributes, patient: Attributes): { matches: string[]; mismatches: string[] } {
  const matches: string[] = [];
  const mismatches: string[] = [];
  const check = (ok: boolean | undefined, yes: string, no: string) => (ok === undefined ? undefined : (ok ? matches : mismatches).push(ok ? yes : no));
  if (session.age !== undefined && patient.age !== undefined) {
    check(Math.abs(session.age - patient.age) <= NEAR_AGE, `Âge concordant (${patient.age} ans).`, `Âge différent : ${patient.age} ans dans le dossier, ${session.age} ans sur cette fiche.`);
  }
  const [a, b] = [dayNumber(session.ddr), dayNumber(patient.ddr)];
  if (a !== undefined && b !== undefined) {
    check(Math.abs(a - b) <= SAME_DDR, `DDR concordante (${patient.ddr}).`, `DDR différente : ${patient.ddr} dans le dossier, ${session.ddr} sur cette fiche.`);
  }
  if (session.gestation !== undefined && patient.gestation !== undefined) {
    check(session.gestation === patient.gestation, `Gestité concordante (${patient.gestation}).`, `Gestité différente : ${patient.gestation} dans le dossier, ${session.gestation} sur cette fiche.`);
  }
  if (session.parite !== undefined && patient.parite !== undefined) {
    check(session.parite === patient.parite, `Parité concordante (${patient.parite}).`, `Parité différente : ${patient.parite} dans le dossier, ${session.parite} sur cette fiche.`);
  }
  if (session.province && patient.province) {
    check(normalizeFacility(session.province) === normalizeFacility(patient.province), `Province concordante (${patient.province}).`, `Province différente : ${patient.province} dans le dossier, ${session.province} sur cette fiche.`);
  }
  return { matches, mismatches };
}

// --- candidates ----------------------------------------------------------------------------------------------

const SCORE: Record<CandidateKind, number> = { exact: 0.9, near_fiche: 0.6, near_facility: 0.6, near_attributes: 0.5 };
const INCONSISTENT_PENALTY = 0.3;
const MAX_CANDIDATES = 2;

/** Exact key match, then near matches: fiche one edit away, facility name one or two edits away, same facility with close LMP and age. */
export function findCandidates(session: SessionKey, patients: KnownPatient[]): Candidate[] {
  if (!session.fiche) return [];
  const fiche = normalizeFiche(session.fiche).key;
  const facility = session.facility ? normalizeFacility(session.facility) : null; // no facility: the code alone decides
  const out: Candidate[] = [];
  for (const p of patients) {
    const pFiche = normalizeFiche(p.fiche_number).key;
    const pFacility = normalizeFacility(p.facility);
    const known = facility !== null && pFacility !== ''; // both sides name a facility: it narrows the match
    const sameFacility = !known || pFacility === facility;
    const fd = editDistance(fiche, pFiche);
    const cd = known ? editDistance(facility, pFacility) : Infinity;
    const { matches, mismatches } = crossCheck(session.attrs, p.attrs);
    let kind: CandidateKind | undefined;
    let why = '';
    if (fd === 0 && sameFacility) {
      kind = 'exact';
      why = !known ? 'Même numéro de fiche (aucun établissement indiqué).' : 'Même numéro de fiche et même établissement.';
    } else if (fd === 1 && sameFacility) {
      kind = 'near_fiche';
      why = `Numéro de fiche presque identique (${p.fiche_number} dans le dossier), même établissement.`;
    } else if (fd === 0 && cd <= 2) {
      kind = 'near_facility';
      why = `Même numéro de fiche, établissement au nom proche (${p.facility}).`;
    } else if (known && sameFacility && nearAttributes(session.attrs, p.attrs)) {
      kind = 'near_attributes';
      why = 'Même établissement, DDR et âge proches.';
    }
    if (!kind) continue;
    const consistent = mismatches.length === 0;
    out.push({
      patient_id: p.id,
      score: Math.max(0.1, SCORE[kind] - (consistent ? 0 : INCONSISTENT_PENALTY)),
      kind,
      consistent,
      reasons: [why, ...matches, ...mismatches],
      summary: { fiche_number: p.fiche_number, facility: p.facility, age: p.attrs.age, ddr: p.attrs.ddr, gestation: p.attrs.gestation, parite: p.attrs.parite, visits: p.visits, last_visit: p.last_visit },
    });
  }
  return out.sort((a, b) => b.score - a.score || a.patient_id.localeCompare(b.patient_id)).slice(0, MAX_CANDIDATES);
}

function nearAttributes(a: Attributes, b: Attributes): boolean {
  const [x, y] = [dayNumber(a.ddr), dayNumber(b.ddr)];
  return x !== undefined && y !== undefined && Math.abs(x - y) <= NEAR_DDR && a.age !== undefined && b.age !== undefined && Math.abs(a.age - b.age) <= NEAR_AGE;
}

// --- the question --------------------------------------------------------------------------------------------

/**
 * Decision rules. No fiche: ask to type it (the facility is optional). A doubtful fiche reading: ask to confirm it. Then:
 * no candidate -> propose to create; exactly one exact and consistent candidate -> propose it; anything else
 * (several, near, inconsistent) -> the 4-button question. Every case asks: nothing is linked or created silently.
 */
export function propose(sessionId: string, session: SessionKey, patients: KnownPatient[]): LinkProposal {
  const doubtful = session.fiche !== null && session.source !== 'typed' && normalizeFiche(session.fiche).low_confidence;
  const { age, ddr, gestation, parite } = session.attrs;
  const current = Object.fromEntries(Object.entries({ age, ddr, gestation, parite }).filter(([, v]) => v !== undefined));
  const base = { session_id: sessionId, fiche: { value: session.fiche, source: session.source, low_confidence: doubtful }, facility: session.facility, current };
  if (!session.fiche) {
    return { ...base, question: 'need_key', text_fr: "Je n'ai pas pu lire le numéro de la fiche. Saisissez-le (l'établissement est facultatif) pour retrouver la patiente.", candidates: [] };
  }
  const where = session.facility ? ` (${session.facility})` : '';
  if (doubtful) {
    return { ...base, question: 'confirm_fiche', text_fr: `J'ai lu ${session.fiche}, est-ce correct ?`, candidates: [] };
  }
  const candidates = findCandidates(session, patients);
  const [first] = candidates;
  if (!first) {
    return { ...base, question: 'create', text_fr: `Aucun dossier ne correspond à la fiche ${session.fiche}${where}. Créer un nouveau dossier ?`, candidates };
  }
  if (candidates.length === 1 && first.kind === 'exact' && first.consistent) {
    return { ...base, question: 'propose', text_fr: `La fiche ${session.fiche} correspond au dossier ${first.patient_id}. Est-ce bien la même patiente ?`, candidates };
  }
  return { ...base, question: 'choose', text_fr: `Je ne suis pas sûr de la patiente pour la fiche ${session.fiche}. Choisissez un dossier, créez-en un nouveau, ou dites que vous ne savez pas.`, candidates };
}
