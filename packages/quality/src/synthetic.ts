// Test helper (also used by tools/quality-eval.mjs): degradations of a page image, done with OpenCV so no other dependency.
import { getCv, Scope, type CV, type RawImage } from './cv';
import { toRgbMat } from './prepare';

type Mat = InstanceType<CV['Mat']>;

const PAPER = [245, 190, 205];
const INK = [40, 50, 140];

function fromMat(m: Mat): RawImage {
  return { data: new Uint8Array(m.data), width: m.cols, height: m.rows, channels: 3 };
}

/** Runs `f` on an RGB Mat copy of the image and returns its result as an image. */
function withMat(image: RawImage, f: (src: Mat, s: Scope) => Mat): RawImage {
  const s = new Scope();
  try {
    return fromMat(f(toRgbMat(image, s), s));
  } finally {
    s.free();
  }
}

/** A pink page with a printed grid and hand-written strokes, A4 ratio, paper to the edges (like the specimen renders). */
export function syntheticPage(width = 707, height = 1000): RawImage {
  const cv = getCv();
  const s = new Scope();
  try {
    const m = s.add(new cv.Mat(height, width, cv.CV_8UC3, new cv.Scalar(...PAPER, 255)));
    const grey = new cv.Scalar(90, 90, 100, 255);
    for (let y = 60; y < height - 40; y += 55) cv.line(m, new cv.Point(30, y), new cv.Point(width - 30, y), grey, 1, cv.LINE_AA);
    for (let x = 30; x < width; x += 130) cv.line(m, new cv.Point(x, 60), new cv.Point(x, height - 60), grey, 1, cv.LINE_AA);
    const ink = new cv.Scalar(...INK, 255);
    let seed = 7; // deterministic strokes
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 160; i++) {
      const x = 40 + rnd() * (width - 120);
      const y = 70 + rnd() * (height - 160);
      for (let k = 0; k < 4; k++) cv.line(m, new cv.Point(x + k * 7, y + rnd() * 14), new cv.Point(x + k * 7 + 6, y + rnd() * 14), ink, 2, cv.LINE_AA);
    }
    return fromMat(m);
  } finally {
    s.free();
  }
}

export const gaussianBlur = (image: RawImage, sigma: number) =>
  withMat(image, (src, s) => {
    const out = s.add(new (getCv().Mat)());
    getCv().GaussianBlur(src, out, new (getCv().Size)(0, 0), sigma, sigma);
    return out;
  });

/** Horizontal motion blur over `length` px. */
export const motionBlur = (image: RawImage, length: number) =>
  withMat(image, (src, s) => {
    const cv = getCv();
    const out = s.add(new cv.Mat());
    const kernel = s.add(cv.Mat.ones(1, length, cv.CV_32F));
    cv.divide(kernel, s.add(new cv.Mat(1, length, cv.CV_32F, new cv.Scalar(length))), kernel);
    cv.filter2D(src, out, -1, kernel);
    return out;
  });

/** Pixel value = value * gain + offset, clipped. gain < 1 darkens, gain > 1 with an offset overexposes. */
export const exposure = (image: RawImage, gain: number, offset = 0) =>
  withMat(image, (src, s) => {
    const out = s.add(new (getCv().Mat)());
    src.convertTo(out, -1, gain, offset);
    return out;
  });

/** A soft white reflection covering about `share` of the image. */
export const glareBlob = (image: RawImage, share = 0.08) =>
  withMat(image, (src, s) => {
    const cv = getCv();
    const layer = s.add(cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC3));
    const radius = Math.sqrt((share * src.rows * src.cols) / Math.PI);
    cv.circle(layer, new cv.Point(Math.round(src.cols * 0.6), Math.round(src.rows * 0.35)), Math.round(radius * 1.1), new cv.Scalar(255, 255, 255, 255), -1);
    cv.GaussianBlur(layer, layer, new cv.Size(0, 0), radius * 0.08, radius * 0.08);
    const out = s.add(new cv.Mat());
    cv.add(src, layer, out); // saturating add: the blob centre clips to white
    return out;
  });

/** Cuts `fraction` of the width off the left side (the page edge and two corners leave the frame). */
export const cropLeft = (image: RawImage, fraction: number): RawImage =>
  withMat(image, (src, s) => {
    const cv = getCv();
    const x = Math.round(src.cols * fraction);
    return s.add(src.roi(new cv.Rect(x, 0, src.cols - x, src.rows)).clone());
  });

/**
 * The page photographed on a dark table: warped into `corners` (fractions of the canvas, TL TR BR BL) on a canvas of the
 * given size, over a dark textured background.
 */
export function onTable(image: RawImage, corners: [number, number][], width = 900, height = 1200): RawImage {
  return withMat(image, (src, s) => {
    const cv = getCv();
    const from = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, src.cols, 0, src.cols, src.rows, 0, src.rows]));
    const to = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, corners.flatMap(([x, y]) => [x * width, y * height])));
    const m = s.add(cv.getPerspectiveTransform(from, to));
    const out = s.add(new cv.Mat(height, width, cv.CV_8UC3, new cv.Scalar(35, 33, 30, 255)));
    cv.warpPerspective(src, out, m, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_TRANSPARENT, new cv.Scalar());
    return out;
  });
}

/** Mild, realistic framing: slightly rotated and a little perspective. */
export const MILD: [number, number][] = [[0.1, 0.07], [0.9, 0.05], [0.92, 0.94], [0.08, 0.95]];
/** Strong perspective: phone tilted, the far edge is well under half as wide as the near one. */
export const STRONG: [number, number][] = [[0.3, 0.2], [0.7, 0.2], [0.98, 0.95], [0.02, 0.95]];
