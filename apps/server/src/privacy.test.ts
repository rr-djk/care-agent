import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskIdentifiers, MASK } from './privacy';

test('masks CIN-like tokens, Moroccan phone numbers, emails and street addresses', () => {
  const cases: [string, string][] = [
    ['CIN AB123456 vue', `CIN ${MASK} vue`],
    ['carte K987654', `carte ${MASK}`],
    ['tel 0612345678', `tel ${MASK}`],
    ['tel 06 12 34 56 78 ok', `tel ${MASK} ok`],
    ['tel 06.12.34.56.78', `tel ${MASK}`],
    ['tel 05-22-33-44-55', `tel ${MASK}`],
    ['+212 6 12 34 56 78', MASK],
    ['+212612345678', MASK],
    ['00212 700 11 22 33', MASK],
    ['mail fatima.z@example.ma fin', `mail ${MASK} fin`],
    ['habite rue des Orangers 12', `habite ${MASK}`],
    ['Avenue Mohammed V', MASK],
    ['av. Hassan II numéro 4', MASK],
    ['lotissement Al Amal', MASK],
    ['hay Salam bloc B', MASK],
    ['derb Sultan', MASK],
    ['boulevard Zerktouni 20', MASK],
  ];
  for (const [input, expected] of cases) {
    const out = maskIdentifiers(input);
    assert.equal(out.text, expected, input);
    assert.equal(out.masked, true, input);
  }
});

test('clinical values are never masked', () => {
  for (const text of ['120/80', '12 SA', '3587 g', '152 cm', '12/04/2026', '05/12/25', '1582', '37,5', 'Neg', 'G2P1', 'Hb 11.5 g/dl', 'avis favorable', 'avenir incertain', 'hayat', 'urgence', 'césarienne programmée', '0.5']) {
    assert.deepEqual(maskIdentifiers(text), { text, masked: false }, text);
  }
});

test('masks several identifiers in one text and reports masked only when something changed', () => {
  const out = maskIdentifiers('AB123456 et 0612345678, mail a@b.co');
  assert.equal(out.text, `${MASK} et ${MASK}, mail ${MASK}`);
  assert.equal(maskIdentifiers('rien à masquer').masked, false);
});
