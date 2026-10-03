import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageSchemaFor } from './fields';
import { deterministicReply, NOT_UNDERSTOOD, parseAnswer, type Intent } from './chat';
import type { ExtractedField } from '@care-agent/schema';
import type { EditResult } from './fields';

const def = (id: string) => pageSchemaFor(3)!.fields.find((f) => f.id === id)!;
const TAILLE = def('p03.taille'); // number, cm
const DDR = def('p03.ddr'); // date
const TA = def('p03.ta.v1_t1'); // short_text, bp
const URINE = def('p03.glucosurie.v1_t1'); // enum Neg/Pos
const FER = def('p03.fer.v1_t1'); // enum Oui/Non
const RUBEOLE = def('p03.rubeole.v1_t1'); // enum Immune / Non immune
const BOX = def('p03.groupage_a'); // checkbox
const value = (v: string | boolean): Intent => ({ kind: 'value', value: v });

test('intent parser: answers to the current item', () => {
  const table: [string, typeof TAILLE | undefined, Intent][] = [
    ['152', TAILLE, value('152')],
    ['152 cm', TAILLE, value('152 cm')],
    ['1,52', TAILLE, value('1,52')],
    ["c'est 158.5", TAILLE, value('158.5')],
    ['12/04/2026', DDR, value('12/04/2026')],
    ['le 12.4.26', DDR, value('12/4/26')],
    ['120/80', TA, value('120/80')],
    ['12 sur 8', TA, { kind: 'unknown' }],
    ['120 sur 80', TA, value('120/80')],
    ['neg', URINE, value('Neg')],
    ['Négatif', URINE, value('Neg')],
    ['pos', URINE, value('Pos')],
    ['oui', FER, value('Oui')],
    ['non', FER, value('Non')],
    ['non', RUBEOLE, value('Non immune')],
    ['oui', BOX, value(true)],
    ['non', BOX, value(false)],
    ["c'est bon", TAILLE, { kind: 'confirm' }],
    ['ok', DDR, { kind: 'confirm' }],
    ['OK !', DDR, { kind: 'confirm' }],
    ['oui c’est ça', TAILLE, { kind: 'confirm' }],
    ["Oui c'est ça", BOX, { kind: 'confirm' }],
    ['oui', TAILLE, { kind: 'confirm' }],
    ['je ne sais pas', TAILLE, { kind: 'leave_illegible' }],
    ['illisible', DDR, { kind: 'leave_illegible' }],
    ['reprendre', TAILLE, { kind: 'retake' }],
    ['il faut une nouvelle photo', TAILLE, { kind: 'retake' }],
    ['bonjour', TAILLE, { kind: 'unknown' }],
    ['demain', DDR, { kind: 'unknown' }],
    ['152 kg', TAILLE, value('152 kg')], // unit mismatch is the validator's call, not the parser's
    ['quelque chose', undefined, { kind: 'unknown' }],
  ];
  for (const [message, d, expected] of table) assert.deepEqual(parseAnswer(message, d), expected, message);
});

const field = (value: ExtractedField['value']): ExtractedField => ({ field_id: 'p03.taille', value, status: 'NEEDS_REVIEW', confidence_signals: { validators_passed: false, quality: 1 }, source_page: 3 });
const ok = (f: Partial<EditResult> = {}): EditResult => ({ ...field('158'), status: 'KNOWN' as const, ...f });

test('replies: the action goes through apply, unparseable answers get the fixed sentence', () => {
  const calls: unknown[] = [];
  const apply = (edit: unknown) => (calls.push(edit), ok());
  const target = { field: field('1582'), label: 'Taille', def: TAILLE };
  assert.equal(deterministicReply('158', target, apply), 'C’est noté : Taille = 158.');
  assert.equal(deterministicReply("c'est bon", target, apply), 'Taille confirmé : 158.');
  assert.equal(deterministicReply('illisible', target, apply), 'Taille reste illisible.');
  assert.deepEqual(calls, [{ value: '158' }, { confirm: true }, { value: null, status: 'ILLEGIBLE' }]);
  assert.match(deterministicReply('reprendre', target, apply), /Reprendre la photo/);
  assert.equal(deterministicReply('bof', target, apply), NOT_UNDERSTOOD);
  assert.equal(calls.length, 3); // nothing applied for retake or unparseable
  assert.match(deterministicReply('ok', { ...target, field: field(null) }, apply), /pas de valeur à confirmer/);
  assert.match(deterministicReply('ok', null, apply), /rien à vérifier/);
  const stillBad = deterministicReply('1700', target, () => ok({ status: 'NEEDS_REVIEW', value: '1700', text_fr: '« 1700 » ne convient pas pour Taille (attendu : entre 120 et 200 cm). Le champ reste à vérifier.' }));
  assert.match(stillBad, /attendu : entre 120 et 200 cm/);
});
