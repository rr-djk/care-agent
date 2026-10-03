import type { ExtractedField, Status, StreamEvent } from '@care-agent/schema';
import { describe, expect, it } from 'vitest';
import { countByStatus, groupFields, initialState, reducer, toReview, type Action, type State } from './state';

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
    expect(s.messages.map((m) => [m.from, m.kind, m.kind === 'text' ? m.text : m.pageId])).toEqual([
      ['bot', 'text', 'Session démarrée. Photographiez une page du registre.'],
      ['user', 'text', 'Photo envoyée : page 3, Grossesse'],
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
