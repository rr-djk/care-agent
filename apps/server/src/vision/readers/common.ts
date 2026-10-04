// Per-cell handwriting readers (experiment, docs/cell-reader.md). Not used by the default pipeline.
import type { BBoxFrac } from '@care-agent/schema';
import type { PageImage } from '../ink';

/** One output unit (a character for CTC, a sub-word token for TrOCR) with its probability and the runner-up. */
export interface ReadingStep {
  text: string;
  p: number;
  alt?: string; // second-best unit at this position
  p_alt?: number;
}

export interface CellReading {
  text: string;
  steps: ReadingStep[];
  seq_logprob: number; // sum of log p over the steps (end token included for TrOCR)
  ms: number;
}

export interface CellReader {
  name: string;
  /** Reads one cell crop (raw RGB). `allowed` restricts the output alphabet (phase 2), undefined = free reading. */
  read(crop: PageImage, opts?: { allowed?: string }): Promise<CellReading>;
}

/**
 * Raw RGB crop of one cell, cut from a page that is ALREADY masked (`maskPage`): nothing under a mask can reach a reader.
 * `pad` > 0 widens the box (page skew), < 0 shrinks it (keeps the printed grid lines out).
 */
export function cellCrop(masked: PageImage, [fx0, fy0, fx1, fy1]: BBoxFrac, pad: number): PageImage {
  const x0 = Math.max(0, Math.round(fx0 * masked.width) - pad);
  const y0 = Math.max(0, Math.round(fy0 * masked.height) - pad);
  const x1 = Math.min(masked.width, Math.round(fx1 * masked.width) + pad);
  const y1 = Math.min(masked.height, Math.round(fy1 * masked.height) + pad);
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) masked.data.copy(data, y * width * 3, ((y0 + y) * masked.width + x0) * 3, ((y0 + y) * masked.width + x0 + width) * 3);
  return { data, width, height };
}

/**
 * Tight crop around the handwriting: the cell box widened by `expand` px (page skew clips the first/last letters of a
 * plain box crop), printed lines whitened (horizontal dark runs >= `runH` px, vertical >= `runV` px: handwriting strokes
 * at 200 dpi stay under ~30 px, grid lines and underlines are longer), then cut to the remaining ink plus `margin` (and
 * `marginX` left and right: blur lightens stroke ends, a tight cut drops the last letter, "RAS" read "RA"), and
 * at least `minH` px high (paper added above and below: a lone "—" filling the whole crop is not read as a dash).
 * Falls back to the plain box when no ink is left.
 */
export function inkTrimCrop(masked: PageImage, bbox: BBoxFrac, expand: number, margin = 4, inkLuma = 140, runH = 40, runV = 45, minH = 32, marginX = 8): PageImage {
  const c = cellCrop(masked, bbox, expand);
  const { width: w, height: h } = c;
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = +(0.299 * c.data[3 * i] + 0.587 * c.data[3 * i + 1] + 0.114 * c.data[3 * i + 2] < inkLuma);
  const line = new Uint8Array(w * h);
  const mark = (start: number, len: number, step: number, min: number) => { if (len >= min) for (let k = 0; k < len; k++) line[start + k * step] = 1; };
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && dark[y * w + x]) run++;
      else { mark(y * w + x - run, run, 1, runH); run = 0; }
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && dark[y * w + x]) run++;
      else { mark((y - run) * w + x, run, w, runV); run = 0; }
    }
  }
  const paper = [c.data[0], c.data[1], c.data[2]]; // paper colour: median of a sample of non-dark pixels
  const light: number[][] = [];
  for (let i = 0; i < w * h && light.length < 200; i += 7) if (!dark[i]) light.push([c.data[3 * i], c.data[3 * i + 1], c.data[3 * i + 2]]);
  if (light.length) for (let k = 0; k < 3; k++) paper[k] = light.map((p) => p[k]).sort((a, b) => a - b)[light.length >> 1];
  // whiten the lines and their 1 px anti-aliased border; keep the ink left
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) near = y + dy >= 0 && y + dy < h && x + dx >= 0 && x + dx < w && !!line[i + dy * w + dx];
      if (near) { c.data[3 * i] = paper[0]; c.data[3 * i + 1] = paper[1]; c.data[3 * i + 2] = paper[2]; }
      else ink[i] = dark[i];
    }
  }
  // the band of rows (gaps <= 3 px) holding the most ink = the handwriting; stubs of cut grid lines lie in other bands
  const rowInk = Array.from({ length: h }, (_, y) => ink.subarray(y * w, (y + 1) * w).reduce((a, v) => a + v, 0));
  let best = { y0: 0, y1: -1, n: 0 };
  for (let y = 0, start = -1, n = 0, gap = 0; y <= h; y++) {
    if (y < h && rowInk[y] > 0) { if (start < 0) start = y; n += rowInk[y]; gap = 0; continue; }
    if (start >= 0 && y < h && ++gap <= 3) continue;
    if (start >= 0 && n > best.n) best = { y0: start, y1: y - gap, n };
    start = -1; n = 0; gap = 0;
  }
  let x0 = w, x1 = -1;
  const y0 = best.y0, y1 = best.y1;
  for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  if (x1 < 0) return cellCrop(masked, bbox, 0);
  const cx0 = Math.max(0, x0 - marginX), cy0 = Math.max(0, y0 - margin);
  const cw = Math.min(w, x1 + marginX + 1) - cx0, ch = Math.min(h, y1 + margin + 1) - cy0;
  const outH = Math.max(ch, minH);
  const top = (outH - ch) >> 1;
  const data = Buffer.alloc(cw * outH * 3);
  for (let i = 0; i < cw * outH; i++) data.set(paper, 3 * i);
  for (let y = 0; y < ch; y++) c.data.copy(data, (top + y) * cw * 3, ((cy0 + y) * w + cx0) * 3, ((cy0 + y) * w + cx0 + cw) * 3);
  return { data, width: cw, height: outH };
}

export type Prep = 'raw' | 'gray' | 'stretch';

/**
 * Line recognisers are trained on dark ink on white paper; the form is pink (TrOCR reads words that are not there on
 * the raw crop). `gray` = luma; `stretch` = luma with the paper (90th percentile) mapped to white and the darkest 1 % to black.
 */
export function prepCrop(crop: PageImage, prep: Prep): PageImage {
  if (prep === 'raw') return crop;
  const n = crop.width * crop.height;
  const luma = new Uint8Array(n);
  for (let i = 0; i < n; i++) luma[i] = Math.round(0.299 * crop.data[3 * i] + 0.587 * crop.data[3 * i + 1] + 0.114 * crop.data[3 * i + 2]);
  let lo = 0, hi = 255;
  if (prep === 'stretch') {
    const sorted = Uint8Array.from(luma).sort();
    lo = sorted[Math.floor(0.01 * (n - 1))];
    hi = Math.max(lo + 1, sorted[Math.floor(0.9 * (n - 1))]);
  }
  const data = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) data.fill(Math.max(0, Math.min(255, Math.round(((luma[i] - lo) * 255) / (hi - lo)))), 3 * i, 3 * i + 3);
  return { data, width: crop.width, height: crop.height };
}
