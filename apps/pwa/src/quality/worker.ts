// Web Worker: OpenCV.js lives here, never on the UI thread. One request in, one answer out.
import { assess, loadCv, type Assessment } from '@care-agent/quality';
import opencvUrl from '@techstark/opencv-js/dist/opencv.js?url'; // emitted as a hashed asset, precached by the service worker

export type Body = { kind: 'file'; blob: Blob } | { kind: 'frame'; bitmap: ImageBitmap };
export type Request = { id: number } & Body;
export type Answer = { id: number; ok: true; assessment: Assessment } | { id: number; ok: false; error: string };

const LONG_SIDE = 1000; // the gate works on ~1000 px; decoding a 12 MP photo to full RGBA would cost 48 MB

const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(m: Answer): void };

/** Pixels of the bitmap scaled so that its long side is at most LONG_SIDE. */
function pixels(bitmap: ImageBitmap) {
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, width, height);
  return { data, width, height, channels: 4 as const };
}

scope.onmessage = async ({ data: req }) => {
  try {
    await loadCv(opencvUrl);
    // createImageBitmap applies the EXIF orientation, so the check sees the photo the way the midwife does
    const bitmap = req.kind === 'file' ? await createImageBitmap(req.blob) : req.bitmap;
    scope.postMessage({ id: req.id, ok: true, assessment: assess(pixels(bitmap), { live: req.kind === 'frame' }) });
  } catch (e) {
    scope.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : 'quality_failed' });
  }
};
