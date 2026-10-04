// The pure models behind the new screens: page summary, home rows, patient record, matching comparison, dashboard texts.
import type { Candidate, ExtractedField, LinkProposal, PatientRecord, ReviewQueue, Status } from '@care-agent/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { compareRows } from './components/MatchCard';
import { statText } from './dashboard';
import { homeRow, homeRows } from './home';
import { setLang } from './i18n';
import type { LocalPage, LocalSession } from './offline/store';
import { bloodGroup, columnOrder, indicators, latestMeasures, matchesSearch, weeksSince } from './profile';
import { buildSummary } from './summary';

afterEach(() => setLang('fr'));

const f = (field_id: string, value: ExtractedField['value'], status: Status = 'KNOWN'): ExtractedField => ({ field_id, value, status, confidence_signals: { validators_passed: true, quality: 1 }, source_page: 3 });

describe('page summary', () => {
  const fields = [
    f('p03.ddr', '07/04/2025'),
    f('p03.taille', '152 cm'),
    f('p03.groupage_a', true),
    f('p03.groupage_b', false),
    f('p03.date_prevue_d_accouchement', null, 'NOT_PROVIDED'),
    f('p03.ta.v1_t1', '115/62'),
    f('p03.ta.v2_t1', '118/74', 'NEEDS_REVIEW'),
    f('p03.poids_kg.m7_t3', '64.0'),
    f('p03.glucosurie.v1_t1', null, 'ILLEGIBLE'),
  ];

  it('flags first, then one section per part of the form; counts', () => {
    const s = buildSummary(3, fields);
    expect(s.flagged.map((x) => x.field_id)).toEqual(['p03.ta.v2_t1', 'p03.glucosurie.v1_t1']);
    expect(s.sections.map((x) => x.title)).toEqual(['Grossesse', 'Visites et examen général', 'Examen obstétrical', 'Biologie et sérologies', 'Bilan sanguin et traitement']);
    expect([s.read, s.review, s.checked]).toEqual([5, 2, 1]);
    const header = s.sections[0];
    expect(header.kind === 'list' && [header.values.map((x) => x.field_id), header.ticked.map((x) => x.field_id)]).toEqual([['p03.ddr', 'p03.taille'], ['p03.groupage_a']]);
  });

  it('the pregnancy table is a grid per trimester: rows by measure, visit columns, cells mapped to fields', () => {
    const visits = buildSummary(3, fields).sections[1];
    expect(visits.kind).toBe('table');
    if (visits.kind !== 'table') return;
    expect(visits.segments.map((x) => x.label)).toEqual(['1er trim.', '2e trim.', '3e trim.']);
    expect(visits.segments[0].columns).toEqual(['V1', 'V2', 'V3']);
    expect(visits.segments[2].columns).toEqual(['M7', 'M8', 'M9']);
    const ta = visits.segments[0].rows.find((r) => r.label === 'TA')!;
    expect(ta.cells.map((c) => c?.value ?? null)).toEqual(['115/62', '118/74', null]);
    expect(visits.flagged).toBe(1);
    setLang('en');
    const en = buildSummary(3, fields).sections[1];
    expect([en.title, en.kind === 'table' && en.segments[0].label, en.kind === 'table' && en.segments[0].rows.find((r) => r.cells[0]?.field_id === 'p03.ta.v1_t1')?.label]).toEqual(['Visits and general exam', 'T1', 'Blood pressure']);
  });

  it('other tables take their column names from the labels; a page type without schema has no section', () => {
    const s = buildSummary(2, [f('p02.date.accouch_1', '21/03/2018')]);
    const deliveries = s.sections.find((x) => x.id === 'p02.deliveries.r1');
    expect(deliveries?.kind === 'table' && deliveries.segments[0].columns).toEqual(['Accouchement 1', 'Accouchement 2', 'Accouchement 3', 'Accouchement 4', 'Accouchement 5']);
    expect(buildSummary(42, [f('x', 'y')]).sections).toEqual([]);
  });
});

describe('home rows', () => {
  const session = (id: string, started_at: string, fiche?: string): LocalSession => ({ id, userId: 'sf-01', seq: 1, synced: true, session: { id, midwife_id: 'sf-01', started_at, page_ids: [], fiche_number: fiche } });
  const local = (id: string, session_id: string, state: LocalPage['state'], captured_at = '2026-10-04T10:00:00Z'): LocalPage =>
    ({ id, userId: 'sf-01', seq: 1, state, mime: 'image/jpeg', attempts: 0, nextAttemptAt: 0, meta: { id, session_id, page_type: 3, captured_at, midwife_id: 'sf-01', sha256: 'x', state: 'CAPTURED', flags: [] } }) as LocalPage;
  const review = (items: number, states: string[]): ReviewQueue =>
    ({ items: Array.from({ length: items }, () => ({}) as never), progress: { total: 0, done: 0, pages: states.map((state, i) => ({ page_id: `s${i}`, state, total: 0, done: 0 })) } }) as ReviewQueue;

  it('failed > unsent > to check > reading > registered > ready; ticks follow the pages', () => {
    const s = session('a', '2026-10-04T09:00:00Z', '2026-711-003');
    expect(homeRow(s, [local('p', 'a', 'SYNC_FAILED')])).toMatchObject({ tone: 'failed', ticks: 1, badge: 1 });
    expect(homeRow(s, [local('p', 'a', 'CAPTURED')])).toMatchObject({ tone: 'unsent', ticks: 1, status: { key: 'home.status.unsent', params: { n: 1 } } });
    expect(homeRow(s, [], review(3, ['NEEDS_REVIEW']))).toMatchObject({ tone: 'review', badge: 3, ticks: 2 });
    expect(homeRow(s, [local('p', 'a', 'UPLOADED')])).toMatchObject({ tone: 'reading', ticks: 2 });
    expect(homeRow(s, [], review(0, ['REGISTERED', 'SYNCED']))).toMatchObject({ tone: 'linked', ticks: 3 });
    expect(homeRow(s, [], review(0, ['VALIDATED']))).toMatchObject({ tone: 'ready' });
    expect(homeRow(s, [])).toMatchObject({ tone: 'empty', ticks: 0, pages: 0 });
  });

  it('most recent first, search on the fiche number (separators ignored), filters', () => {
    const sessions = [session('a', '2026-10-01T09:00:00Z', '2026-711-003'), session('b', '2026-10-03T09:00:00Z', '2026-640-118')];
    const pages = [local('p', 'a', 'CAPTURED', '2026-10-04T10:00:00Z')];
    expect(homeRows(sessions, pages, {}).map((r) => r.id)).toEqual(['a', 'b']); // a's page is the latest activity
    expect(homeRows(sessions, pages, {}, { query: '640 118' }).map((r) => r.id)).toEqual(['b']);
    expect(homeRows(sessions, pages, {}, { filter: 'unsent' }).map((r) => r.id)).toEqual(['a']);
  });
});

describe('patient record', () => {
  const v = (field_id: string, value: string | boolean, page_type: number, source_date = '2026-08-12T10:00:00Z') => ({ field_id, label_fr: field_id, value, page_type, source_page_id: 'x', source_date });
  const record = (values: ReturnType<typeof v>[]): PatientRecord => ({ patient: { id: 'PAT-000001', fiche_number: '2026-711-003', facility: 'DR', created_at: 't' }, visits: [], values });

  it('gestational age in completed weeks from the LMP, none outside 0..45 weeks', () => {
    const now = Date.UTC(2026, 3, 29); // 29/04/2026
    expect(weeksSince('01/04/2026', now)).toBe(4);
    expect(weeksSince('01/04/2025', now)).toBeNull();
    expect(weeksSince(undefined, now)).toBeNull();
  });

  it('indicators with their source; blood group from the ticked boxes; no term after delivery', () => {
    const r = record([v('p03.ddr', '01/04/2026', 3), v('p03.groupage_o', true, 3), v('p03.rh_minus', true, 3), v('p02.gestation', '3', 2), v('p02.parite', '2', 2), v('p02.age', '28', 2)]);
    const ind = indicators(r, Date.UTC(2026, 3, 29));
    expect(ind.map((i) => [i.key, i.value])).toEqual([['term', '4'], ['ddr', '01/04/2026'], ['blood', 'O Rh −'], ['gp', 'G3 P2'], ['age', '28']]);
    expect(ind[1].source).toEqual({ page_type: 3, date: '2026-08-12T10:00:00Z' });
    expect(bloodGroup(record([]))).toBeNull();
    expect(indicators(record([v('p03.ddr', '01/04/2026', 3), v('p05.t_deg', '37.0', 5)]), Date.UTC(2026, 3, 29)).map((i) => i.key)).toEqual(['ddr']);
  });

  it('latest measurement: latest visit column of the pregnancy table, a later page wins', () => {
    expect([columnOrder('p03.ta.v1_t1'), columnOrder('p03.ta.v3_t2'), columnOrder('p03.ta.m9_t3'), columnOrder('p03.ddr')]).toEqual([11, 23, 39, -1]);
    const r = record([v('p03.ta.v1_t1', '110/70', 3), v('p03.ta.v2_t2', '118/74', 3), v('p03.poids_kg.v1_t1', '60', 3), v('p05.ta', '125/80', 5, '2026-12-20T10:00:00Z')]);
    expect(latestMeasures(r).map((m) => [m.key, m.value])).toEqual([['ta', '125/80'], ['weight', '60']]);
  });

  it('search: fiche, PAT id or facility, case and separators ignored', () => {
    const p = { id: 'PAT-000214', fiche_number: '2026-711-003', facility: 'DR Tahannaout Sud' };
    expect(['711003', 'pat000214', 'tahannaout', ''].map((q) => matchesSearch(p, q))).toEqual([true, true, true, true]);
    expect(matchesSearch(p, '999')).toBe(false);
  });
});

describe('matching comparison', () => {
  const proposal: LinkProposal = { session_id: 's', fiche: { value: '2026 711 003', source: 'cover', low_confidence: false }, facility: 'dr tahannaout sud', current: { age: 28, ddr: '15/03/2026', gestation: 2, parite: 1 }, question: 'propose', text_fr: '?', candidates: [] };
  const candidate = (summary: Partial<Candidate['summary']>): Candidate => ({ patient_id: 'PAT-000001', score: 0.9, kind: 'exact', consistent: true, reasons: [], summary: { fiche_number: '2026-711-003', facility: 'DR Tahannaout Sud', visits: 1, ...summary } });

  it('the server cross-check rules: age ±1, LMP ±14 days, G/P equal; fiche and facility ignore case and separators', () => {
    const marks = (c: Candidate) => compareRows(proposal, c).map((r) => r.mark);
    expect(marks(candidate({ age: 29, ddr: '01/03/2026', gestation: 2, parite: 1 }))).toEqual(['same', 'same', 'same', 'same', 'same']);
    expect(marks(candidate({ age: 31, ddr: '01/02/2026', gestation: 3, parite: 1 }))).toEqual(['same', 'same', 'diff', 'diff', 'diff']);
    expect(marks(candidate({ fiche_number: '2026-711-008' }))).toEqual(['diff', 'same', 'none', 'none', 'none']); // nothing to compare: "–"
  });
});

describe('dashboard texts', () => {
  it('French as the server writes it, English by exact text, bands with a decimal point', () => {
    expect(statText('36,0 à 37,4')).toBe('36,0 à 37,4');
    setLang('en');
    expect([statText('Hépatite C'), statText('36,0 à 37,4'), statText('≥ 160'), statText('Négatif')]).toEqual(['Hepatitis C', '36.0 to 37.4', '≥ 160', 'Negative']);
  });
});
