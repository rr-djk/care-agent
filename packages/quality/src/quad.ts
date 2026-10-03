import { getCv, Scope, type CV } from './cv';

export interface Point {
  x: number;
  y: number;
}
/** Page corners, clockwise from the top-left: TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];

export const A4_RATIO = 297 / 210;
const FULL_PAGE_COVER = 0.97; // paper over this share of the image: a flat full-page render, not a photo
const FULL_PAGE_RATIO_TOL = 0.03; // a render has the A4 aspect; a cropped one (or a 4:3 photo full of paper) does not
const MIN_PAPER_SHARE = 0.05; // below this, no paper at all (the gate rejects)
const DETECT_SCALE = 0.5; // the page outline needs no more than ~500 px; the corners are scaled back

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function orderCorners(pts: Point[]): Quad {
  const by = (f: (p: Point) => number, sign: 1 | -1) => pts.reduce((a, b) => (sign * f(b) > sign * f(a) ? b : a));
  return [by((p) => p.x + p.y, -1), by((p) => p.x - p.y, 1), by((p) => p.x + p.y, 1), by((p) => p.x - p.y, -1)];
}

export function quadArea(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += q[i].x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * q[i].y;
  return Math.abs(s) / 2;
}

/** Largest deviation from 90 degrees among the four interior angles (0 = a rectangle seen straight on). */
export function maxAngleDeviation(q: Quad): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4];
    const b = q[i];
    const c = q[(i + 1) % 4];
    const cos = ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y)) / (dist(a, b) * dist(c, b));
    worst = Math.max(worst, Math.abs((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI - 90));
  }
  return worst;
}

/** Long side over short side, from the mean of the opposite edges (rough under perspective). */
export function quadRatio(q: Quad): number {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  return Math.max(w, h) / Math.min(w, h);
}

export function cornersInside(q: Quad, width: number, height: number, margin: number): boolean {
  return q.every((p) => p.x >= margin * width && p.x <= (1 - margin) * width && p.y >= margin * height && p.y <= (1 - margin) * height);
}

export function pointInQuad(q: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross !== 0 && sign !== 0 && Math.sign(cross) !== sign) return false;
    if (cross !== 0) sign = Math.sign(cross);
  }
  return true;
}

export interface PageDetection {
  quad: Quad | null;
  paperShare: number; // share of paper-coloured pixels (0 = nothing like paper)
  /** The paper fills the image with the A4 aspect: a flat full-page render, nothing to rectify. */
  fullPage: boolean;
}

/** Paper mask: pink paper is the only saturated, not-dark thing in the frame; plain light paper falls back to Otsu on luma. */
function paperMask(cv: CV, rgb: InstanceType<CV['Mat']>, s: Scope) {
  const hsv = s.add(new cv.Mat());
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const mask = s.add(new cv.Mat());
  cv.inRange(hsv, s.add(new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(0, 50, 60, 0))), s.add(new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(180, 255, 255, 255))), mask);
  const area = rgb.rows * rgb.cols;
  if (cv.countNonZero(mask) / area >= MIN_PAPER_SHARE) return mask;
  const gray = s.add(new cv.Mat());
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  cv.threshold(gray, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  return mask;
}

/** Page quadrilateral: paper mask, morphology, largest outer contour, approxPolyDP down to 4 corners. `rgb` is 8UC3. */
export function detectPage(full: InstanceType<CV['Mat']>): PageDetection {
  const cv = getCv();
  const s = new Scope();
  try {
    const rgb = s.add(new cv.Mat());
    cv.resize(full, rgb, new cv.Size(Math.round(full.cols * DETECT_SCALE), Math.round(full.rows * DETECT_SCALE)), 0, 0, cv.INTER_AREA);
    const { rows: h, cols: w } = rgb;
    const up = (q: Quad) => q.map((p) => ({ x: p.x / DETECT_SCALE, y: p.y / DETECT_SCALE })) as Quad;
    const mask = paperMask(cv, rgb, s);
    const paperShare = cv.countNonZero(mask) / (w * h);
    if (paperShare < MIN_PAPER_SHARE) return { quad: null, paperShare, fullPage: false };
    // close the holes left by ink and print, open away the speckle of a dark textured background
    const big = s.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7)));
    const small = s.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, big);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, small);
    const contours = s.add(new cv.MatVector());
    cv.findContours(mask, contours, s.add(new cv.Mat()), cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best: InstanceType<CV['Mat']> | undefined;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = s.add(contours.get(i));
      const a = cv.contourArea(c);
      if (a > bestArea) [best, bestArea] = [c, a];
    }
    if (!best || bestArea < 0.05 * w * h) return { quad: null, paperShare, fullPage: false };
    const whole: Quad = [{ x: 0, y: 0 }, { x: full.cols - 1, y: 0 }, { x: full.cols - 1, y: full.rows - 1 }, { x: 0, y: full.rows - 1 }];
    if (bestArea >= FULL_PAGE_COVER * w * h) {
      return { quad: whole, paperShare, fullPage: Math.abs(full.rows / full.cols / A4_RATIO - 1) <= FULL_PAGE_RATIO_TOL };
    }
    const hull = s.add(new cv.Mat());
    cv.convexHull(best, hull);
    const perimeter = cv.arcLength(hull, true);
    for (let eps = 0.01; eps <= 0.1; eps += 0.005) {
      const approx = s.add(new cv.Mat());
      cv.approxPolyDP(hull, approx, eps * perimeter, true);
      if (approx.rows === 4) {
        const pts = [0, 1, 2, 3].map((i) => ({ x: approx.data32S[i * 2], y: approx.data32S[i * 2 + 1] }));
        return { quad: up(orderCorners(pts)), paperShare, fullPage: false };
      }
    }
    return { quad: null, paperShare, fullPage: false };
  } finally {
    s.free();
  }
}
