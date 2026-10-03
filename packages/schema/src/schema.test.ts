import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import * as S from './index';

const FORBIDDEN = [
  'name', 'nom', 'prenom', 'husband', 'mari', 'spouse', 'conjoint', 'cin',
  'national', 'phone', 'telephone', 'tel', 'address', 'adresse',
];

// Collects every object key reachable from a zod schema (zod 4 internals: _zod.def).
function keys(schema: unknown, out = new Set<string>(), seen = new Set<unknown>()): Set<string> {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return out;
  seen.add(schema);
  const def = (schema as { _zod?: { def?: Record<string, any> } })._zod?.def;
  if (!def) return out;
  if (def.type === 'object') {
    for (const [k, v] of Object.entries(def.shape)) { out.add(k); keys(v, out, seen); }
  }
  for (const child of [def.element, def.innerType, def.valueType, def.in, def.out, ...(def.options ?? [])]) {
    keys(child, out, seen);
  }
  return out;
}

test('no schema contains a personal-identifier key', () => {
  const all = Object.values(S).filter((v) => v instanceof z.ZodType);
  assert.ok(all.length > 10);
  const found = new Set<string>();
  for (const s of all) for (const k of keys(s)) found.add(k);
  assert.ok(found.has('fiche_number')); // the walker really descends
  assert.ok(found.has('fields')); // ... through unions and arrays
  const bad = [...found].filter((k) => FORBIDDEN.some((f) => k.toLowerCase().includes(f)));
  assert.deepEqual(bad, []);
});

test('lifecycle: happy path allowed, illegal jump refused', () => {
  const path = ['CAPTURED', 'PENDING_AI', 'AI_PROCESSED', 'NEEDS_REVIEW', 'VALIDATED', 'PATIENT_MATCHED', 'REGISTERED', 'SYNCED'] as const;
  for (let i = 0; i < path.length - 1; i++) assert.ok(S.canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`);
  assert.equal(S.canTransition('CAPTURED', 'SYNCED'), false);
  assert.equal(S.canTransition('AI_PROCESSED', 'VALIDATED'), false); // no validation without review
  assert.equal(S.canTransition('VALIDATED', 'SYNC_FAILED'), false);
  assert.ok(S.canTransition('REGISTERED', 'SYNC_FAILED'));
  assert.ok(S.canTransition('SYNC_FAILED', 'REGISTERED'));
  assert.ok(S.canTransition('PROCESSING_FAILED', 'PENDING_AI'));
  assert.ok(S.canTransition('CAPTURED', 'MANUAL_REVIEW_REQUIRED'));
  assert.ok(S.canTransition('MANUAL_REVIEW_REQUIRED', 'VALIDATED'));
  assert.ok(S.canTransition('VALIDATED', 'DUPLICATE_SUSPECTED'));
  assert.ok(S.canTransition('DUPLICATE_SUSPECTED', 'PATIENT_MATCHED'));
});

test('parseEvent accepts valid lines and rejects unknown types', () => {
  assert.deepEqual(S.parseEvent('{"type":"token","text":"Bon"}'), { type: 'token', text: 'Bon' });
  assert.deepEqual(S.parseEvent('{"type":"ping"}'), { type: 'ping' });
  assert.equal(S.parseEvent('{"type":"record_ready","record_id":"r1"}').type, 'record_ready');
  assert.throws(() => S.parseEvent('{"type":"nope"}'));
  assert.throws(() => S.parseEvent('{"type":"token"}'));
  assert.throws(() => S.parseEvent('not json'));
});

test('Patient id format', () => {
  const p = { fiche_number: '12', facility: 'F1', created_at: '2026-10-03T00:00:00Z' };
  assert.ok(S.Patient.safeParse({ ...p, id: 'PAT-000001' }).success);
  for (const id of ['PAT-1', 'PAT-0000001', 'pat-000001', 'PAT-00000a']) {
    assert.equal(S.Patient.safeParse({ ...p, id }).success, false, id);
  }
});

test('ZoneAnswer accepts empty string, null and strings only', () => {
  assert.ok(S.ZoneAnswer.safeParse({ cells: ['17/08/2025', '', null] }).success);
  assert.equal(S.ZoneAnswer.safeParse({ cells: [1] }).success, false);
  assert.equal(S.ZoneAnswer.safeParse({ cells: [true] }).success, false);
  assert.equal(S.ZoneAnswer.safeParse({ cells: [undefined] }).success, false);
});
