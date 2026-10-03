import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import sharp from 'sharp';
import { loadCv, TEMPLATE } from '@care-agent/quality';
import { MILD, onTable, syntheticPage } from '@care-agent/quality/synthetic';
import { loadPageSchema } from '@care-agent/schema/node';
import { loadCellBoxes, loadLayoutImage } from '../cli/pages';

before(() => loadCv());

test('real_cover: same fields as the specimen cover, every field has a cell box and a zone, the name area is masked', () => {
  const real = loadPageSchema('real_cover');
  const cover = loadPageSchema('cover');
  assert.deepEqual(real.fields.map((f) => f.id), cover.fields.map((f) => f.id));
  const boxes = loadCellBoxes('real_cover');
  for (const f of real.fields) {
    assert.equal(boxes.get(f.id)?.kind, f.type === 'checkbox' ? 'checkbox' : 'text', f.id);
    assert.equal(real.zones.find((z) => z.id === f.zone)?.cells.includes(f.id), true, f.id);
  }
  assert.equal(real.masks.length, 1);
  // no cell lies under the mask (the paper strip over the woman's name)
  const [mx0, my0, mx1, my1] = real.masks[0];
  for (const { bbox_frac: [x0, y0, x1, y1] } of boxes.values()) assert.ok(x1 < mx0 || x0 > mx1 || y1 < my0 || y0 > my1);
});

test('the CLI path warps a photo of the real form to the template size, and leaves specimen layouts alone', async () => {
  const photo = onTable(syntheticPage(), MILD);
  const dir = await mkdtemp(join(tmpdir(), 'care-agent-'));
  try {
    const file = join(dir, 'photo.png');
    await sharp(Buffer.from(photo.data), { raw: { width: photo.width, height: photo.height, channels: 3 } }).png().toFile(file);
    const warped = await loadLayoutImage(file, 'real_cover');
    assert.deepEqual([warped.width, warped.height], [TEMPLATE.width, TEMPLATE.height]);
    const same = await loadLayoutImage(file, 'cover');
    assert.deepEqual([same.width, same.height], [photo.width, photo.height]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
