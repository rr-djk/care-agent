import type { Candidate, ExtractedField, LinkProposal, LinkResult, PatientRecord, ReviewItem, ReviewQueue, Status, StreamEvent } from '@care-agent/schema';
import { describe, expect, it } from 'vitest';
import { activeItemMsg, activeLinkMsg, activeOfferMsg, countByStatus, currentItem, groupFields, initialState, keyValuesByVisit, linkButtons, linkResultText, pageStateLabel, queueLabel, readyToLink, reducer, toReview, type Action, type State } from './state';

const field = (field_id: string, status: Status, value: ExtractedField['value'] = 'x'): ExtractedField => ({
  field_id,
  value,
  status,
  confidence_signals: { validators_passed: true, quality: 1 },
  source_page: 3,
});

const run = (actions: Action[], from: State = initialState) => actions.reduce(reducer, from);
const ev = (event: StreamEvent): Action => ({ type: 'event', event });

const fields = [
  field('a', 'KNOWN'),
  field('b', 'UNKNOWN', null),
  field('c', 'NEEDS_REVIEW'),
  field('d', 'ILLEGIBLE', null),
  field('e', 'KNOWN'),
  field('f', 'NEEDS_REVIEW'),
  field('g', 'NOT_APPLICABLE', null),
];

describe('groupFields', () => {
  it('puts flagged fields first (NEEDS_REVIEW, ILLEGIBLE, UNKNOWN), then KNOWN, keeping order inside a status', () => {
    const { flagged, known } = groupFields(fields);
    expect(flagged.map((f) => f.field_id)).toEqual(['c', 'f', 'd', 'b']);
    expect(known.map((f) => f.field_id)).toEqual(['a', 'e']);
  });

  it('counts per status', () => {
    expect(countByStatus(fields)).toEqual({ KNOWN: 2, UNKNOWN: 1, NEEDS_REVIEW: 2, ILLEGIBLE: 1, NOT_APPLICABLE: 1 });
  });
});

describe('reducer', () => {
  const session = { id: 's1', midwife_id: 'sf-01', started_at: 't', page_ids: [] };

  it('turns an analysis event sequence into chat messages', () => {
    const s = run([
      { type: 'session_started', session },
      { type: 'page_added', pageId: 'p1', pageType: 3 },
      ev({ type: 'page_received', page_id: 'p1' }),
      ev({ type: 'page_read', page_id: 'p1', fields }),
      ev({ type: 'field_flagged', page_id: 'p1', field_id: 'c', reason: 'r' }),
      ev({ type: 'field_flagged', page_id: 'p1', field_id: 'd', reason: 'r' }),
      ev({ type: 'record_ready', record_id: 's1' }),
    ]);
    expect(s.messages.map((m) => [m.from, m.kind, m.kind === 'text' ? m.text : m.kind === 'summary' ? m.pageId : ''])).toEqual([
      ['bot', 'text', 'Session démarrée. Photographiez une page du registre.'],
      ['user', 'text', 'Photo enregistrée : page 3, Grossesse'],
      ['bot', 'text', 'Page reçue, analyse en cours…'],
      ['bot', 'summary', 'p1'],
      ['bot', 'text', 'Toutes les pages sont analysées.'],
    ]);
    expect(s.pages.p1.pageType).toBe(3);
    expect(s.pages.p1.fields).toHaveLength(7);
    expect(toReview(s.pages.p1)).toEqual(['c', 'd']);
  });

  it('shows a readable French message per error code and marks the page failed', () => {
    const s = run([ev({ type: 'error', code: 'model_timeout', text: 'page p1 failed', page_id: 'p1' })]);
    expect(s.messages[0]).toMatchObject({ kind: 'text', text: "L'analyse a pris trop de temps." });
    expect(s.pages.p1.failed).toBe(true);
  });

  it('applies a corrected field and a confirmation', () => {
    const s = run([
      ev({ type: 'page_read', page_id: 'p1', fields }),
      { type: 'field_updated', pageId: 'p1', field: field('c', 'KNOWN', 'y') },
      { type: 'page_confirmed', pageId: 'p1' },
    ]);
    expect(s.pages.p1.fields?.find((f) => f.field_id === 'c')).toMatchObject({ status: 'KNOWN', value: 'y' });
    expect(s.pages.p1.validated).toBe(true);
  });
});

const item = (page_id: string, field_id: string, value: string | null = null): ReviewItem => ({
  page_id,
  field_id,
  kind: 'doubt',
  label_fr: field_id,
  value,
  reason_code: 'unusual_value',
  text_fr: `doute sur ${field_id}`,
  actions: ['correct', 'retake', 'leave_illegible'],
});
const queue = (items: ReviewItem[], pages: [string, number, number, string?][]): ReviewQueue => ({
  items,
  progress: {
    total: pages.reduce((n, p) => n + p[1], 0),
    done: pages.reduce((n, p) => n + p[2], 0),
    pages: pages.map(([page_id, total, done, state]) => ({ page_id, page_type: 3, state: (state ?? 'NEEDS_REVIEW') as 'NEEDS_REVIEW', total, done })),
  },
});
const kinds = (s: State) => s.messages.map((m) => (m.kind === 'item' ? `item:${m.item.field_id}` : m.kind === 'page_clear' ? `clear:${m.pageId}` : m.kind));

describe('review walk', () => {
  it('asks one question at a time, once per distinct item, and the head item is the only active one', () => {
    const a = item('p1', 'a');
    let s = run([{ type: 'review_loaded', queue: queue([a, item('p1', 'b')], [['p1', 2, 0]]) }]);
    expect(kinds(s)).toEqual(['item:a']);
    expect(currentItem(s)?.field_id).toBe('a');
    expect(activeItemMsg(s)).toBe(0);
    s = run([{ type: 'review_loaded', queue: queue([a, item('p1', 'b')], [['p1', 2, 0]]) }], s); // same queue: no repeat
    expect(kinds(s)).toEqual(['item:a']);
    s = run([{ type: 'review_loaded', queue: queue([item('p1', 'b')], [['p1', 2, 1]]) }], s); // a was answered
    expect(kinds(s)).toEqual(['item:a', 'item:b']);
    expect(activeItemMsg(s)).toBe(1);
    // the same field again with a new value (typed value still invalid): asked again
    s = run([{ type: 'review_loaded', queue: queue([item('p1', 'b', '1700')], [['p1', 2, 1]]) }], s);
    expect(kinds(s)).toEqual(['item:a', 'item:b', 'item:b']);
  });

  it('announces "tout est vérifié" once per page, before the next page is asked about, and reopens on new doubt', () => {
    let s = run([{ type: 'review_loaded', queue: queue([item('p2', 'x')], [['p1', 1, 1], ['p2', 1, 0]]) }]);
    expect(kinds(s)).toEqual(['clear:p1', 'item:x']);
    s = run([{ type: 'review_loaded', queue: queue([item('p2', 'x')], [['p1', 1, 1], ['p2', 1, 0]]) }], s);
    expect(kinds(s)).toEqual(['clear:p1', 'item:x']);
    s = run([{ type: 'review_loaded', queue: queue([], [['p1', 1, 1], ['p2', 1, 1]]) }], s);
    expect(kinds(s)).toEqual(['clear:p1', 'item:x', 'clear:p2']);
    expect(activeItemMsg(s)).toBeUndefined();
    s = run([{ type: 'review_loaded', queue: queue([item('p1', 'y')], [['p1', 2, 1], ['p2', 1, 1]]) }], s); // p1 reopened
    s = run([{ type: 'review_loaded', queue: queue([], [['p1', 2, 2], ['p2', 1, 1]]) }], s);
    expect(kinds(s).filter((k) => k === 'clear:p1')).toHaveLength(2);
  });

  it('a validated or failed page is not announced; a page with nothing flagged is cleared at once', () => {
    const s = run([{ type: 'review_loaded', queue: queue([], [['p1', 0, 0, 'VALIDATED'], ['p2', 0, 0]]) }]);
    expect(kinds(s)).toEqual(['clear:p2']);
  });
});

describe('manual entry offer, retake and chat stream', () => {
  it('offers « Saisie manuelle » after a model error only', () => {
    const model = run([ev({ type: 'error', code: 'model_unreachable', text: 'x', page_id: 'p1' })]);
    expect(model.messages.map((m) => m.kind)).toEqual(['text', 'manual_offer']);
    expect(model.pages.p1).toMatchObject({ failed: true, failCode: 'model_unreachable' });
    const other = run([ev({ type: 'error', code: 'page_type_unsupported', text: 'x', page_id: 'p1' })]);
    expect(other.messages.map((m) => m.kind)).toEqual(['text']);
    // the manual page is read: the failure flag is cleared
    expect(run([ev({ type: 'page_read', page_id: 'p1', fields })], model).pages.p1.failed).toBe(false);
  });

  it('a retake marks the old page superseded and keeps the page order', () => {
    const s = run([
      { type: 'page_added', pageId: 'p1', pageType: 3 },
      { type: 'page_added', pageId: 'p2', pageType: 3, replaces: 'p1' },
    ]);
    expect(s.order).toEqual(['p1', 'p2']);
    expect(s.pages.p1.superseded).toBe(true);
    expect(s.pages.p2.superseded).toBe(false);
    expect(s.messages[1]).toMatchObject({ kind: 'text', text: 'Nouvelle photo enregistrée : page 3, Grossesse', hint: expect.stringContaining('Elle remplace la photo précédente.') });
  });

  it('chat tokens build one streaming bot message that done closes', () => {
    const s = run([ev({ type: 'token', text: 'C’est ' }), ev({ type: 'token', text: 'noté.' })]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ kind: 'text', text: 'C’est noté.', streaming: true });
    const done = run([ev({ type: 'done' }), ev({ type: 'token', text: 'Suite' })], s);
    expect(done.messages.map((m) => m.kind === 'text' && [m.text, m.streaming])).toEqual([['C’est noté.', false], ['Suite', true]]);
  });

  it('page list labels', () => {
    const page = { id: 'p', fields: [], flagged: [], failed: false, validated: false, cleared: false, superseded: false };
    const progress = { page_id: 'p', state: 'NEEDS_REVIEW' as const, total: 5, done: 2 };
    expect(pageStateLabel({ ...page, fields: null })).toBe('analyse en cours');
    expect(pageStateLabel(page, progress)).toBe('2/5 vérifiés');
    expect(pageStateLabel({ ...page, failed: true })).toBe('échec');
    expect(pageStateLabel({ ...page, superseded: true }, progress)).toBe('remplacée');
    expect(pageStateLabel({ ...page, validated: true })).toBe('validée');
  });

  it('a replayed event sequence (stream reconnect) does not duplicate bubbles', () => {
    const events = [
      ev({ type: 'page_received', page_id: 'p1' }),
      ev({ type: 'page_read', page_id: 'p1', fields }),
      ev({ type: 'field_flagged', page_id: 'p1', field_id: 'c', reason: 'r' }),
      ev({ type: 'record_ready', record_id: 's1' }),
    ];
    const once = run([{ type: 'page_added', pageId: 'p1', pageType: 3 }, ...events]);
    const twice = run(events, once);
    expect(twice.messages).toEqual(once.messages);
    expect(twice.pages.p1.flagged).toEqual(['c']);
    // a genuinely new page after the replay still shows up, with its own record_ready
    const more = run([{ type: 'page_added', pageId: 'p2', pageType: 3 }, ev({ type: 'page_received', page_id: 'p2' }), ev({ type: 'page_read', page_id: 'p2', fields }), ev({ type: 'record_ready', record_id: 's1' })], twice);
    expect(more.messages.filter((m) => m.kind === 'text' && m.text === 'Toutes les pages sont analysées.')).toHaveLength(2);
    // chat events are never deduplicated
    expect(run([ev({ type: 'token', text: 'a' }), ev({ type: 'done' }), ev({ type: 'token', text: 'a' })]).messages).toHaveLength(2);
  });

  it('restoring a session is idempotent and keeps the queued pages', () => {
    const session = { id: 's1', midwife_id: 'sf-01', started_at: 't', page_ids: [] };
    const restored = { type: 'session_restored' as const, session, pages: [{ id: 'p1', pageType: 3 }, { id: 'p2', pageType: 3, replaces: 'p1' }] };
    const s = run([restored, restored]);
    expect(s.order).toEqual(['p1', 'p2']);
    expect(s.pages.p1.superseded).toBe(true);
    expect(s.messages).toHaveLength(1);
  });

  it('queue labels (French) follow the local state', () => {
    const idle = { offline: false, sending: false, analysed: false };
    expect(queueLabel({ state: 'CAPTURED', attempts: 0 }, idle)).toBe("Enregistrée sur l'appareil (chiffrée)");
    expect(queueLabel({ state: 'CAPTURED', attempts: 0 }, { ...idle, offline: true })).toBe('En attente de traitement IA');
    expect(queueLabel({ state: 'CAPTURED', attempts: 2 }, idle)).toBe('En attente de traitement IA');
    expect(queueLabel({ state: 'CAPTURED', attempts: 0 }, { ...idle, sending: true })).toBe('Envoi en cours…');
    expect(queueLabel({ state: 'UPLOADED', attempts: 0 }, idle)).toBe('Envoyée — analyse en cours');
    expect(queueLabel({ state: 'UPLOADED', attempts: 0 }, { ...idle, analysed: true })).toBeNull();
    expect(queueLabel({ state: 'SYNC_FAILED', attempts: 0, error: 'sha256_mismatch' }, idle)).toBe("Échec d'envoi : La photo a été corrompue pendant l'envoi, reprenez-la.");
  });
});

describe('patient linking', () => {
  const session = { id: 's1', midwife_id: 'sf-01', started_at: 't', page_ids: [] };
  const queue = (...states: [string, string][]): ReviewQueue => ({
    items: [],
    progress: { total: 0, done: 0, pages: states.map(([page_id, state]) => ({ page_id, page_type: 1, state: state as never, total: 0, done: 0 })) },
  });
  const candidate = (patient_id: string, over: Partial<Candidate> = {}): Candidate => ({
    patient_id,
    score: 0.9,
    kind: 'exact',
    consistent: true,
    reasons: ['Même numéro de fiche et même établissement.'],
    summary: { fiche_number: '2026-711-003', facility: 'DR Tahannaout Sud', visits: 1 },
    ...over,
  });
  const proposal = (question: LinkProposal['question'], candidates: Candidate[] = []): LinkProposal => ({
    session_id: 's1',
    fiche: { value: '2026-711-003', source: 'cover', low_confidence: false },
    facility: 'DR Tahannaout Sud',
    question,
    text_fr: 'Question ?',
    candidates,
  });
  const started = [{ type: 'session_started', session } as Action, { type: 'page_added', pageId: 'p1', pageType: 1 } as Action, { type: 'page_added', pageId: 'p2', pageType: 3 } as Action];
  const kinds = (s: State) => s.messages.map((m) => m.kind);

  it('offers the link question once every page is confirmed, and only then', () => {
    const open = run([...started, { type: 'review_loaded', queue: queue(['p1', 'VALIDATED'], ['p2', 'NEEDS_REVIEW']) }]);
    expect(readyToLink(open)).toBe(false);
    expect(kinds(open)).not.toContain('finish_offer');
    const ready = run([{ type: 'review_loaded', queue: queue(['p1', 'VALIDATED'], ['p2', 'VALIDATED']) }], open);
    expect(readyToLink(ready)).toBe(true);
    expect(kinds(ready).filter((k) => k === 'finish_offer')).toHaveLength(1);
    expect(activeOfferMsg(ready)).toBe(ready.messages.at(-1)!.id);
    // a refresh does not repeat the offer; a page that is not on the server yet blocks it
    expect(kinds(run([{ type: 'review_loaded', queue: queue(['p1', 'VALIDATED'], ['p2', 'VALIDATED']) }], ready)).filter((k) => k === 'finish_offer')).toHaveLength(1);
    const unsent = run([{ type: 'page_added', pageId: 'p3', pageType: 4 }, { type: 'review_loaded', queue: queue(['p1', 'VALIDATED'], ['p2', 'VALIDATED']) }], ready);
    expect(readyToLink(unsent)).toBe(false);
    expect(activeOfferMsg(unsent)).toBeUndefined();
  });

  it('a registered or parked session is not offered again (after a reload)', () => {
    const s = run([{ type: 'session_started', session }, { type: 'review_loaded', queue: queue(['p1', 'REGISTERED']) }]);
    expect(readyToLink(s)).toBe(false);
    expect(run([{ type: 'review_loaded', queue: queue(['p1', 'DUPLICATE_SUSPECTED']) }], s).link.offered).toBe(false);
    expect(readyToLink(run([{ type: 'session_started', session }, { type: 'review_loaded', queue: queue(['p1', 'VALIDATED']) }]))).toBe(true); // nothing local, the server has it
  });

  it('buttons: 4-button question, one-tap proposal, create, doubtful fiche, typing', () => {
    const labels = (p: LinkProposal) => linkButtons(p).map((b) => b.label);
    expect(labels(proposal('choose', [candidate('PAT-000001', { kind: 'near_fiche' }), candidate('PAT-000002', { kind: 'near_fiche' })]))).toEqual(['Patient 1', 'Patient 2', 'Aucune, créer', 'Je ne sais pas']);
    expect(labels(proposal('choose', [candidate('PAT-000001', { kind: 'near_fiche' })]))).toEqual(['Patient 1', 'Aucune, créer', 'Je ne sais pas']);
    expect(labels(proposal('propose', [candidate('PAT-000001')]))).toEqual(["Oui, c'est le dossier PAT-000001", 'Non, créer un nouveau dossier', 'Je ne sais pas']);
    expect(labels(proposal('create'))).toEqual(['Créer un nouveau dossier', 'Je ne sais pas']);
    expect(labels(proposal('confirm_fiche'))).toEqual(["Oui, c'est correct", 'Non, je la saisis']);
    expect(linkButtons(proposal('need_key'))).toEqual([]);
    const decisions = linkButtons(proposal('choose', [candidate('PAT-000001'), candidate('PAT-000002')])).map((b) => b.decision);
    expect(decisions).toEqual([{ kind: 'patient', patient_id: 'PAT-000001' }, { kind: 'patient', patient_id: 'PAT-000002' }, { kind: 'create_new' }, { kind: 'not_sure' }]);
  });

  it('question, then decision: only the latest question has buttons; the result message and the differences card follow', () => {
    const ready = run([...started, { type: 'review_loaded', queue: queue(['p1', 'VALIDATED'], ['p2', 'VALIDATED']) }]);
    const asked = run([{ type: 'link_proposal', proposal: proposal('confirm_fiche') }], ready);
    expect(activeOfferMsg(asked)).toBeUndefined();
    const first = activeLinkMsg(asked);
    const retyped = run([{ type: 'link_proposal', proposal: proposal('propose', [candidate('PAT-000001')]) }], asked);
    expect(activeLinkMsg(retyped)).not.toBe(first);
    const result: LinkResult = {
      status: 'linked',
      patient: { id: 'PAT-000012', fiche_number: '2026-711-003', facility: 'DR Tahannaout Sud', created_at: 't' },
      visits: 3,
      differences: [{ page_id: 'p2', field_id: 'p03.taille', label_fr: 'Taille', page_type: 3, old_value: '160', old_date: 't', new_value: '', choice: 'old', decided: false }],
    };
    const done = run([{ type: 'link_decided', result }], retyped);
    expect(activeLinkMsg(done)).toBeUndefined();
    expect(kinds(done).slice(-2)).toEqual(['link_done', 'differences']);
    expect(done.differences).toHaveLength(1);
    expect(linkResultText(result)).toBe('Dossier PAT-000012 mis à jour (3 visites)');
    expect(run([{ type: 'differences_updated', differences: [{ ...result.differences[0], choice: 'new', decided: true }] }], done).differences[0].choice).toBe('new');
    expect(readyToLink(run([{ type: 'review_loaded', queue: queue(['p1', 'REGISTERED'], ['p2', 'REGISTERED']) }], done))).toBe(false);
  });

  it('result texts: creation, first visit, parked', () => {
    const patient = { id: 'PAT-000001', fiche_number: 'f', facility: 'x', created_at: 't' };
    expect(linkResultText({ status: 'linked', patient, visits: 1, differences: [] })).toBe('Dossier PAT-000001 créé (1 visite)');
    expect(linkResultText({ status: 'not_sure', differences: [] })).toMatch(/mises de côté pour vérification/);
  });

  it('page labels after the decision', () => {
    const view = { id: 'p1', fields: [], flagged: [], failed: false, validated: true, cleared: true, superseded: false };
    const progress = (state: string) => ({ page_id: 'p1', state: state as never, total: 0, done: 0 });
    expect(pageStateLabel(view, progress('REGISTERED'))).toBe('dossier enregistré');
    expect(pageStateLabel(view, progress('SYNCED'))).toBe('dossier enregistré');
    expect(pageStateLabel(view, progress('DUPLICATE_SUSPECTED'))).toBe('à vérifier (doublon ?)');
    expect(pageStateLabel(view, progress('VALIDATED'))).toBe('validée');
  });

  it('key values of a visit come from that visit\'s own pages', () => {
    const v = (field_id: string, source_page_id: string) => ({ field_id, label_fr: field_id, value: '1', source_page_id, source_date: 't', page_type: 3 });
    const record: PatientRecord = {
      patient: { id: 'PAT-000001', fiche_number: 'f', facility: 'x', created_at: 't' },
      visits: [
        { session_id: 'a', date: 't', pages: [{ page_id: 'p1', page_type: 3, captured_at: 't', state: 'SYNCED' }] },
        { session_id: 'b', date: 't', pages: [{ page_id: 'p2', page_type: 3, captured_at: 't', state: 'SYNCED' }] },
      ],
      values: [v('p03.ddr', 'p1'), v('p03.poids_kg.v1_t1', 'p1'), v('p03.taille', 'p2')],
    };
    expect(keyValuesByVisit(record).map((vals) => vals.map((x) => x.field_id))).toEqual([['p03.ddr'], ['p03.taille']]);
  });
});
