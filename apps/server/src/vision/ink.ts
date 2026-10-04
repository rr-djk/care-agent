import type { BBoxFrac } from '@care-agent/schema';

/** Decoded page: raw RGB, 3 bytes per pixel. */
export interface PageImage {
  data: Buffer;
  width: number;
  height: number;
}

// Paper is pink (~245,190,205, luma ~208); handwriting and ticks are dark blue/black.
const INK_LUMA = 140;
// Pixels trimmed on every side of the cell: grid lines, dotted lines and checkbox borders sit on the edge
// (and pages are skewed up to ~15 px), so only the inside of the cell counts.
const MARGIN_PX = 10;

// A pixel row/column that is ink over this fraction of the cell is a grid line that leaked in (page skew shifts
// the printed grid by up to ~15 px against the PDF geometry), not handwriting.
const LINE_FRAC = 0.9;
// Dotted lines ("....") cover ~40% of a row, so rows are dropped from a lower fraction.
const ROW_LINE_FRAC = 0.2;

const isInk = (page: PageImage, x: number, y: number) => {
  const i = (y * page.width + x) * 3;
  return 0.299 * page.data[i] + 0.587 * page.data[i + 1] + 0.114 * page.data[i + 2] < INK_LUMA;
};

/** Fraction of ink pixels inside the cell shrunk by MARGIN_PX, leaked grid lines excluded. */
export function inkRatio(page: PageImage, bbox: BBoxFrac, margin = MARGIN_PX, dropLines = true): number {
  const x0 = Math.round(bbox[0] * page.width) + margin;
  const y0 = Math.round(bbox[1] * page.height) + margin;
  const x1 = Math.round(bbox[2] * page.width) - margin;
  const y1 = Math.round(bbox[3] * page.height) - margin;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return 0;
  const rows = new Array<number>(h).fill(0);
  const cols = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isInk(page, x0 + x, y0 + y)) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  let ink = 0;
  for (let y = 0; y < h; y++) {
    if (dropLines && rows[y] >= ROW_LINE_FRAC * w) continue;
    for (let x = 0; x < w; x++) if ((!dropLines || cols[x] < LINE_FRAC * h) && isInk(page, x0 + x, y0 + y)) ink++;
  }
  return ink / (w * h);
}

// Checkboxes are 22 px squares: the margin used for text would erase them, and a 15 px skew moves the printed
// border out of the PDF bbox. So the border is located first (best-matching square outline), then only its
// interior counts.
const BOX_SEARCH_PX = 15;
const BOX_INSET_PX = 4;

export function checkboxInkRatio(page: PageImage, bbox: BBoxFrac): number {
  const x0 = Math.round(bbox[0] * page.width);
  const y0 = Math.round(bbox[1] * page.height);
  const x1 = Math.round(bbox[2] * page.width);
  const y1 = Math.round(bbox[3] * page.height);
  // Score of a shifted outline: its weakest side first (a tick crosses a side or two, a border has all four).
  const outline = (dx: number, dy: number) => {
    let top = 0, bottom = 0, left = 0, right = 0;
    for (let x = x0 + dx; x <= x1 + dx; x++) {
      top += +isInk(page, x, y0 + dy);
      bottom += +isInk(page, x, y1 + dy);
    }
    for (let y = y0 + dy; y <= y1 + dy; y++) {
      left += +isInk(page, x0 + dx, y);
      right += +isInk(page, x1 + dx, y);
    }
    return Math.min(top, bottom, left, right) * 1000 + top + bottom + left + right;
  };
  let best = { dx: 0, dy: 0, n: -1 };
  for (let dy = -BOX_SEARCH_PX; dy <= BOX_SEARCH_PX; dy++) {
    for (let dx = -BOX_SEARCH_PX; dx <= BOX_SEARCH_PX; dx++) {
      const n = outline(dx, dy);
      if (n > best.n) best = { dx, dy, n };
    }
  }
  const shifted: BBoxFrac = [(x0 + best.dx) / page.width, (y0 + best.dy) / page.height, (x1 + best.dx) / page.width, (y1 + best.dy) / page.height];
  return inkRatio(page, shifted, BOX_INSET_PX, false); // a tick stroke would look like a line
}

// Thresholds chosen with `npm run ink-eval` on the 80 specimen pages: checkboxes precision/recall 1.00 (all layouts).
// Text: 0.002 gives precision 1.00 / recall ≥ 0.997 except on delivery, whose dotted lines leak (precision 0.77);
// 0.01 gives delivery precision and recall 1.00 but drops pregnancy recall to 0.88, hence one threshold per layout.
// The cover has the same dotted line ("Autres à préciser"): 0.01 gives precision and recall 1.00 on its 10 pages.
// The postpartum layouts have dotted lines too ("Autres à préciser"): 0.01 gives precision and recall 1.00 on their 20 pages each
// (0.002 leaks 28 and 10 empty cells; at 0.02 the newborn recall falls to 0.80).
const TEXT_INK_MIN: Record<string, number> = { delivery: 0.01, cover: 0.01, postpartum_mother: 0.01, postpartum_newborn: 0.01, real_cover: 0.01 }; // real_cover: the cover's value, not tuned on the photo
const TEXT_INK_DEFAULT = 0.002;
const CHECKBOX_INK_MIN = 0.05; // lowest ticked box measured: 0.107, highest empty box: < 0.002

/** Every constant that decides what counts as ink (part of the pipeline hash, `calibration.ts`). */
export const INK_PARAMS = { INK_LUMA, MARGIN_PX, LINE_FRAC, ROW_LINE_FRAC, BOX_SEARCH_PX, BOX_INSET_PX, TEXT_INK_MIN, TEXT_INK_DEFAULT, CHECKBOX_INK_MIN };

export const cellHasInk = (ratio: number, kind: 'text' | 'checkbox' = 'text', layout = '') =>
  ratio >= (kind === 'checkbox' ? CHECKBOX_INK_MIN : (TEXT_INK_MIN[layout] ?? TEXT_INK_DEFAULT));
