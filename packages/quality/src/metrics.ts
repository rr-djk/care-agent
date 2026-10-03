import { getCv, Scope, type CV } from './cv';
import { pointInQuad, type Quad } from './quad';

type Mat = InstanceType<CV['Mat']>;

const TILE = 40; // px on the 1000 px working copy
const TILE_MIN_STD = 10; // luma std of a tile that holds ink or print (blank paper is ~1-3)
const GLARE_MIN = 240; // every channel above this = white, not pink paper
const GLARE_BLOB_MIN = 0.004; // blobs under this share of the page are specks, not glare

export interface Blur {
  /** Median variance of the Laplacian over the tiles that hold ink/print (high = sharp). 0 when no such tile. */
  sharpness: number;
  /** min/max of the mean |dx| and |dy| gradients over those tiles: low = smeared in one direction (motion blur). */
  isotropy: number;
  tiles: number;
}

/** Tiles whose four corners lie inside the page (whole image when `quad` is null). */
function pageTiles(width: number, height: number, quad: Quad | null) {
  const tiles: [number, number][] = [];
  for (let y = 0; y + TILE <= height; y += TILE) {
    for (let x = 0; x + TILE <= width; x += TILE) {
      const inside = !quad || [[x, y], [x + TILE, y], [x, y + TILE], [x + TILE, y + TILE]].every(([px, py]) => pointInQuad(quad, px, py));
      if (inside) tiles.push([x, y]);
    }
  }
  return tiles;
}

/**
 * A page is mostly blank paper, so a global Laplacian variance mostly measures the paper: only tiles with ink or print
 * count, and the median of their Laplacian variance is the score.
 */
export function blurMetric(gray: Mat, quad: Quad | null): Blur {
  const cv = getCv();
  const s = new Scope();
  try {
    const { cols: w, rows: h } = gray;
    const lap = s.add(new cv.Mat());
    cv.Laplacian(gray, lap, cv.CV_32F);
    const g = gray.data;
    const l = lap.data32F;
    const variances: number[] = [];
    let gx = 0;
    let gy = 0;
    for (const [x0, y0] of pageTiles(w, h, quad)) {
      let sum = 0;
      let sum2 = 0;
      let lsum = 0;
      let lsum2 = 0;
      let tx = 0;
      let ty = 0;
      for (let y = y0; y < y0 + TILE; y++) {
        for (let x = x0; x < x0 + TILE; x++) {
          const i = y * w + x;
          sum += g[i];
          sum2 += g[i] * g[i];
          lsum += l[i];
          lsum2 += l[i] * l[i];
          if (x > 0 && x < w - 1) tx += Math.abs(g[i + 1] - g[i - 1]);
          if (y > 0 && y < h - 1) ty += Math.abs(g[i + w] - g[i - w]);
        }
      }
      const n = TILE * TILE;
      if (Math.sqrt(sum2 / n - (sum / n) ** 2) < TILE_MIN_STD) continue;
      variances.push(lsum2 / n - (lsum / n) ** 2);
      gx += tx;
      gy += ty;
    }
    if (!variances.length) return { sharpness: 0, isotropy: 1, tiles: 0 };
    variances.sort((a, b) => a - b);
    return { sharpness: variances[variances.length >> 1], isotropy: Math.min(gx, gy) / Math.max(gx, gy, 1), tiles: variances.length };
  } finally {
    s.free();
  }
}

export interface Exposure {
  mean: number; // mean luma 0..255
  clipped: number; // share of pixels above 250
  black: number; // share of pixels below 15
  spread: number; // p99 - p1 of the luma (p95 - p5 reads 0 on a page that is 98% blank paper)
}

/** Luma statistics over the pixels of `mask` (8UC1, non-zero = page), or the whole image. */
export function exposureMetric(gray: Mat, mask: Mat | null): Exposure {
  const hist = new Array<number>(256).fill(0);
  const g = gray.data;
  const m = mask?.data;
  let n = 0;
  for (let i = 0; i < g.length; i++) {
    if (m && !m[i]) continue;
    hist[g[i]]++;
    n++;
  }
  if (!n) return { mean: 0, clipped: 0, black: 1, spread: 0 };
  const pct = (p: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= p * n) return v;
    return 255;
  };
  const share = (from: number, to: number) => hist.slice(from, to + 1).reduce((a, b) => a + b, 0) / n;
  return { mean: hist.reduce((a, c, v) => a + c * v, 0) / n, clipped: share(251, 255), black: share(0, 14), spread: pct(0.99) - pct(0.01) };
}

/** Share of the page covered by large blobs of white (all channels saturated): a reflection of the light on the paper. */
export function glareMetric(rgb: Mat, mask: Mat | null, pageArea: number): number {
  const cv = getCv();
  const s = new Scope();
  try {
    const white = s.add(new cv.Mat(rgb.rows, rgb.cols, cv.CV_8UC1));
    const p = rgb.data;
    const m = mask?.data;
    const out = white.data; // cache: every `.data` access builds a new typed array view
    for (let i = 0; i < out.length; i++) {
      out[i] = (!m || m[i]) && p[i * 3] > GLARE_MIN && p[i * 3 + 1] > GLARE_MIN && p[i * 3 + 2] > GLARE_MIN ? 255 : 0;
    }
    const stats = s.add(new cv.Mat());
    cv.connectedComponentsWithStats(white, s.add(new cv.Mat()), stats, s.add(new cv.Mat()));
    let area = 0;
    for (let i = 1; i < stats.rows; i++) {
      const a = stats.data32S[i * stats.cols + cv.CC_STAT_AREA];
      if (a >= GLARE_BLOB_MIN * pageArea) area += a;
    }
    return area / pageArea;
  } finally {
    s.free();
  }
}
