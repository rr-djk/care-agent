import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './normalize.mjs';

// Same cases as test_normalize.py: both implementations must give the same outputs.
const cases = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'data', 'normalize_cases.json'), 'utf8'));

test('shared normalize cases', () => {
  for (const [raw, expected] of cases) assert.equal(normalize(raw), expected, raw);
});

test('noisy spellings compare equal, a dropped letter is not repaired', () => {
  assert.equal(normalize('Néant'), normalize('N éant'));
  assert.equal(normalize('3587 g'), normalize('3587g'));
  assert.notEqual(normalize('N ant'), normalize('Néant'));
});
