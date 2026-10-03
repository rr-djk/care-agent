import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraAvailable, guideRect } from './guide';

describe('A4 guide', () => {
  it.each([
    [1080, 1920],
    [1920, 1080],
    [720, 1080],
    [1000, 1000],
  ])('frame %ix%i: the guide is inside the frame, centred, with the A4 ratio (pixels of the captured image)', (w, h) => {
    const g = guideRect(w, h);
    expect(g.x).toBeGreaterThanOrEqual(0);
    expect(g.y).toBeGreaterThanOrEqual(0);
    expect(g.x + g.w).toBeLessThanOrEqual(1);
    expect(g.y + g.h).toBeLessThanOrEqual(1);
    expect(g.x + g.w / 2).toBeCloseTo(0.5);
    expect(g.y + g.h / 2).toBeCloseTo(0.5);
    expect((g.h * h) / (g.w * w)).toBeCloseTo(297 / 210);
  });
});

describe('cameraAvailable', () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = (secure: boolean, getUserMedia?: unknown) => {
    vi.stubGlobal('window', { isSecureContext: secure });
    vi.stubGlobal('navigator', { mediaDevices: getUserMedia ? { getUserMedia } : undefined });
  };
  it('needs getUserMedia AND a secure origin; otherwise the file picker is used', () => {
    env(true, () => {});
    expect(cameraAvailable()).toBe(true);
    env(false, () => {}); // plain HTTP on the LAN
    expect(cameraAvailable()).toBe(false);
    env(true); // no mediaDevices
    expect(cameraAvailable()).toBe(false);
  });
});
