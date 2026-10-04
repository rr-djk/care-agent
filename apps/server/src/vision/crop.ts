import sharp from 'sharp';
import type { BBoxFrac, ZoneDef } from '@care-agent/schema';
import type { PageImage } from './ink';

// Pages are skewed up to ~15 px at 200 dpi, so crops get this much extra on every side.
export const PAD_PX = 12;

/** Copy of the page with every mask rectangle painted black. Nothing under a mask may reach the model. */
export function maskPage(page: PageImage, masks: BBoxFrac[]): PageImage {
  const data = Buffer.from(page.data);
  for (const [fx0, fy0, fx1, fy1] of masks) {
    const x0 = Math.max(0, Math.floor(fx0 * page.width));
    const x1 = Math.min(page.width, Math.ceil(fx1 * page.width));
    for (let y = Math.max(0, Math.floor(fy0 * page.height)); y < Math.min(page.height, Math.ceil(fy1 * page.height)); y++) {
      data.fill(0, (y * page.width + x0) * 3, (y * page.width + x1) * 3);
    }
  }
  return { ...page, data };
}

function region(page: PageImage, [x0, x1]: [number, number], [y0, y1]: [number, number], pad: number) {
  const left = Math.max(0, Math.floor(x0 * page.width) - pad);
  const top = Math.max(0, Math.floor(y0 * page.height) - pad);
  return {
    left,
    top,
    width: Math.min(page.width, Math.ceil(x1 * page.width) + pad) - left,
    height: Math.min(page.height, Math.ceil(y1 * page.height) + pad) - top,
  };
}

/** PNG crop of one zone (masks blacked out first). A `label_strip` is placed to the left, so row labels stay visible. */
export async function cropZone(page: PageImage, zone: ZoneDef, masks: BBoxFrac[], pad = PAD_PX): Promise<Buffer> {
  const masked = maskPage(page, masks);
  const raw = { raw: { width: masked.width, height: masked.height, channels: 3 as const } };
  const extract = (r: ReturnType<typeof region>) => sharp(masked.data, raw).extract(r).png().toBuffer();
  const [zx0, zy0, zx1, zy1] = zone.bbox_frac;
  const body = region(masked, [zx0, zx1], [zy0, zy1], pad);
  if (!zone.label_strip) return extract(body);
  // The strip is cut over the zone's own rows so both halves have the same height.
  const strip = region(masked, [zone.label_strip[0], zone.label_strip[2]], [zy0, zy1], pad);
  return sharp({ create: { width: strip.width + body.width, height: body.height, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await extract(strip), left: 0, top: 0 },
      { input: await extract(body), left: strip.width, top: 0 },
    ])
    .png()
    .toBuffer();
}
