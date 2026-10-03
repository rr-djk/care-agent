import { getCv, Scope, type CV, type RawImage } from './cv';
import { THRESHOLDS } from './thresholds';

type Mat = InstanceType<CV['Mat']>;

/** RGB (8UC3) Mat of the image, whatever its channels. Owned by `s`. */
export function toRgbMat(image: RawImage, s: Scope): Mat {
  const cv = getCv();
  const src = s.add(cv.matFromArray(image.height, image.width, image.channels === 4 ? cv.CV_8UC4 : cv.CV_8UC3, image.data as unknown as number[]));
  if (image.channels === 3) return src;
  const rgb = s.add(new cv.Mat());
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  return rgb;
}

/** The working copy of an RGB Mat: scaled so that the long side is `workingSize`. `scale` = working px per source px. */
export function workingCopy(rgb: Mat, s: Scope): { rgb: Mat; scale: number } {
  const cv = getCv();
  const scale = THRESHOLDS.workingSize / Math.max(rgb.cols, rgb.rows);
  if (scale === 1) return { rgb, scale };
  const out = s.add(new cv.Mat());
  cv.resize(rgb, out, new cv.Size(Math.round(rgb.cols * scale), Math.round(rgb.rows * scale)), 0, 0, scale < 1 ? cv.INTER_AREA : cv.INTER_LINEAR);
  return { rgb: out, scale };
}
