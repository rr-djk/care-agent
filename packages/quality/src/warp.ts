import { getCv, Scope, type RawImage } from './cv';
import { toRgbMat, workingCopy } from './prepare';
import { A4_RATIO, cornersInside, detectPage, quadArea, quadRatio, type Quad } from './quad';

/** Template size of the specimen pages (A4 portrait, 200 dpi). */
export const TEMPLATE = { width: 1654, height: 2339 } as const;

const MIN_AREA_SHARE = 0.3;
const RATIO_TOL = 0.2; // a quad whose aspect is far from A4 is not a lone page (booklet spread, wrong contour): do not stretch it
const EDGE_MARGIN = 0; // a corner on the frame border is tolerated, one outside it is not (page cut)

/**
 * Rectifies the page to the template size with a perspective transform when a plausible page quadrilateral is found and
 * the image is not already a full-page render; otherwise returns the image unchanged. The input is never modified.
 */
export function warpPage(image: RawImage): { image: RawImage; warped: boolean } {
  const cv = getCv();
  const s = new Scope();
  try {
    const full = toRgbMat(image, s);
    const { rgb, scale } = workingCopy(full, s);
    const { quad, fullPage } = detectPage(rgb);
    if (!quad || fullPage) return { image, warped: false };
    const share = quadArea(quad) / (rgb.cols * rgb.rows);
    if (share < MIN_AREA_SHARE || !cornersInside(quad, rgb.cols, rgb.rows, EDGE_MARGIN) || Math.abs(quadRatio(quad) / A4_RATIO - 1) > RATIO_TOL) {
      return { image, warped: false };
    }
    // long side vertical: a page photographed sideways is turned a quarter so it fills the portrait template
    const len = (a: number, b: number) => Math.hypot(quad[a].x - quad[b].x, quad[a].y - quad[b].y);
    const sideways = len(0, 1) + len(3, 2) > len(0, 3) + len(1, 2);
    const src: Quad = sideways ? [quad[3], quad[0], quad[1], quad[2]] : quad;

    const { width, height } = TEMPLATE;
    const from = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, src.flatMap((p) => [p.x / scale, p.y / scale])));
    const to = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]));
    const m = s.add(cv.getPerspectiveTransform(from, to));
    const out = s.add(new cv.Mat());
    cv.warpPerspective(full, out, m, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    return { image: { data: new Uint8Array(out.data), width, height, channels: 3 }, warped: true };
  } finally {
    s.free();
  }
}
