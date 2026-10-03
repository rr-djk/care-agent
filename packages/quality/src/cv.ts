import type { CV } from '@techstark/opencv-js';

export type { CV };

/** Raw pixels, row-major, interleaved: RGB (Node, sharp) or RGBA (canvas ImageData). */
export interface RawImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 3 | 4;
}

let loaded: CV | undefined;

/**
 * Loads the single OpenCV.js build (wasm inlined in the npm file) once. Node: imported from the package. Browser worker:
 * pass the URL of the same file (the PWA ships it as a precached asset); a module worker cannot import its UMD wrapper,
 * so it is fetched and run as a classic script, which defines `cv` on the worker global.
 */
export async function loadCv(scriptUrl?: string): Promise<void> {
  if (loaded) return;
  let cv: CV & { onRuntimeInitialized?: () => void };
  if (scriptUrl) {
    (0, eval)(await (await fetch(scriptUrl)).text());
    cv = (globalThis as unknown as { cv: typeof cv }).cv;
  } else {
    const name = '@techstark/opencv-js'; // not a literal: the browser bundle must not pull the npm file in through here
    const mod = (await import(/* @vite-ignore */ name)) as { default?: typeof cv };
    cv = (mod.default ?? mod) as typeof cv;
  }
  // The module object is thenable: awaiting it never settles. Wait for the runtime callback instead.
  await new Promise<void>((resolve) => {
    if (cv.Mat) resolve();
    else cv.onRuntimeInitialized = () => resolve();
  });
  loaded = cv;
}

export function getCv(): CV {
  if (!loaded) throw new Error('OpenCV is not loaded: await loadCv() first');
  return loaded;
}

/** Collects OpenCV objects (wasm memory, not garbage collected) to free them all in one place. */
export class Scope {
  private items: { delete(): void }[] = [];
  add<T extends { delete(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }
  free() {
    for (const i of this.items) i.delete();
    this.items = [];
  }
}
