import { loadCv, warpPage } from '@care-agent/quality';
import type { PageImage } from './ink';

/** Counters since start: the only trace of the rectification in the logs (no ids, no values). */
export const warpStats = { pages: 0, warped: 0 };

/**
 * The page rectified to the template size when a page quadrilateral is found (perspective warp, in memory only: the
 * stored original stays byte-exact); the same image otherwise (full-page render, no page found).
 */
export async function rectify(page: PageImage): Promise<PageImage> {
  await loadCv();
  const { image, warped } = warpPage({ data: page.data, width: page.width, height: page.height, channels: 3 });
  warpStats.pages++;
  if (warped) warpStats.warped++;
  console.log(`warp: ${warpStats.warped} of ${warpStats.pages} analysed pages rectified since start`);
  return warped ? { data: Buffer.from(image.data), width: image.width, height: image.height } : page;
}
