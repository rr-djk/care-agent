import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { ZoneDef } from '@care-agent/schema';
import { cropZone } from './crop';
import type { PageImage } from './ink';

// 100x100 page: red left half, green right half.
const W = 100;
const data = Buffer.alloc(W * W * 3);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) data.set(x < 50 ? [255, 0, 0] : [0, 255, 0], (y * W + x) * 3);
const page: PageImage = { data, width: W, height: W };
const zone: ZoneDef = { id: 'z', bbox_frac: [0.6, 0.2, 0.9, 0.6], label_strip: [0.1, 0.2, 0.3, 0.6], cells: [] };
const pixel = async (png: Buffer, x: number, y: number) => {
  const raw = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...raw.data.subarray((y * raw.info.width + x) * 3, (y * raw.info.width + x) * 3 + 3)];
};

test('label strip is composed to the left of the zone, same height', async () => {
  const png = await cropZone(page, zone, [], 0);
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.width, meta.height], [20 + 30, 40]); // strip 20 px + zone 30 px
  assert.deepEqual(await pixel(png, 5, 5), [255, 0, 0]); // strip comes from the red half
  assert.deepEqual(await pixel(png, 30, 5), [0, 255, 0]); // zone comes from the green half
});

test('padding grows the crop and is clamped to the page', async () => {
  const meta = await sharp(await cropZone(page, { ...zone, label_strip: undefined }, [], 12)).metadata();
  assert.deepEqual([meta.width, meta.height], [52, 64]); // x 48..100 (right side clamped to the page), y 8..72
});

test('masks are black in the output and the input page is untouched', async () => {
  const mask: [number, number, number, number] = [0.65, 0.25, 0.75, 0.35];
  const png = await cropZone(page, zone, [mask], 0);
  assert.deepEqual(await pixel(png, 20 + 7, 7), [0, 0, 0]); // inside the mask (page x 67, y 27)
  assert.deepEqual(await pixel(png, 20 + 25, 30), [0, 255, 0]); // outside
  assert.deepEqual([...page.data.subarray((27 * W + 67) * 3, (27 * W + 67) * 3 + 3)], [0, 255, 0]);
});

test('a mask over the label strip is applied too', async () => {
  const png = await cropZone(page, zone, [[0.1, 0.2, 0.3, 0.6]], 0);
  assert.deepEqual(await pixel(png, 5, 5), [0, 0, 0]);
});
