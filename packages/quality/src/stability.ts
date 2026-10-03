import type { Quad } from './quad';

export const HOLD_MS = 500; // all-pass and still for this long triggers the auto-capture
export const MAX_SHIFT = 0.02; // largest corner move between two samples, as a fraction of the image size

/** Auto-capture trigger fed with each analysed live frame; true once the frame has passed and held still for `holdMs`. */
export function createStability(holdMs = HOLD_MS, maxShift = MAX_SHIFT) {
  let since: number | null = null;
  let last: Quad | null = null;
  return {
    push(now: number, ok: boolean, quad: Quad | null): boolean {
      if (!ok || !quad) {
        since = last = null;
        return false;
      }
      if (last && Math.max(...quad.map((p, i) => Math.hypot(p.x - last![i].x, p.y - last![i].y))) > maxShift) since = null;
      since ??= now;
      last = quad;
      return now - since >= holdMs;
    },
    reset() {
      since = last = null;
    },
  };
}
