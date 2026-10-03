import type { QualityResult } from '@care-agent/schema';
import type { Assessment } from '@care-agent/quality';
import type { Answer, Body } from './worker';

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (a: Assessment) => void; reject: (e: Error) => void }>();

function start(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<Answer>) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.ok) p?.resolve(data.assessment);
    else p?.reject(new Error(data.error));
  };
  worker.onerror = () => {
    // the worker died (OpenCV failed to load): every waiting caller fails, the next call starts a fresh worker
    for (const p of pending.values()) p.reject(new Error('quality_worker_failed'));
    pending.clear();
    worker = undefined;
  };
  return worker;
}

function ask(req: Body, transfer: Transferable[] = []): Promise<Assessment> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    start().postMessage({ ...req, id }, transfer);
  });
}

/** Post-capture check of a photo (works offline: OpenCV is precached by the service worker). */
export async function checkPhoto(file: Blob): Promise<QualityResult> {
  return (await ask({ kind: 'file', blob: file })).result;
}

/** Live check of a downscaled video frame (framing, blur, exposure); the bitmap is transferred and consumed. */
export const checkFrame = (bitmap: ImageBitmap) => ask({ kind: 'frame', bitmap }, [bitmap]);

/** Starts the worker (and OpenCV) ahead of the first photo. */
export const warmUp = () => void start();
