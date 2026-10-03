import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { loadCv, TEMPLATE } from '@care-agent/quality';
import { MILD, onTable, syntheticPage } from '@care-agent/quality/synthetic';
import { rectify, warpStats } from './rectify';

before(() => loadCv());

test('rectify: a page on a table is warped to the template size (counter incremented), a full-page render is returned as is', async () => {
  const photo = onTable(syntheticPage(), MILD);
  const out = await rectify({ data: Buffer.from(photo.data), width: photo.width, height: photo.height });
  assert.deepEqual([out.width, out.height], [TEMPLATE.width, TEMPLATE.height]);
  assert.equal(out.data.length, TEMPLATE.width * TEMPLATE.height * 3);
  assert.deepEqual([warpStats.pages, warpStats.warped], [1, 1]);

  const flat = syntheticPage();
  const page = { data: Buffer.from(flat.data), width: flat.width, height: flat.height };
  assert.equal(await rectify(page), page);
  assert.deepEqual([warpStats.pages, warpStats.warped], [2, 1]);
});
