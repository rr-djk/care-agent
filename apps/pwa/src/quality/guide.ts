/** A4 portrait guide, as fractions of the video frame (0..1). The captured image is the WHOLE frame (no crop). */
export interface Guide {
  x: number;
  y: number;
  w: number;
  h: number;
}

const A4_RATIO = 297 / 210;
const FILL = 0.92; // the guide takes this share of the frame on its limiting side

export function guideRect(frameWidth: number, frameHeight: number): Guide {
  let h = FILL * frameHeight;
  let w = h / A4_RATIO;
  if (w > FILL * frameWidth) {
    w = FILL * frameWidth;
    h = w * A4_RATIO;
  }
  return { x: (1 - w / frameWidth) / 2, y: (1 - h / frameHeight) / 2, w: w / frameWidth, h: h / frameHeight };
}

/** Camera screen only when the browser allows it: getUserMedia exists and the origin is secure (HTTPS or localhost). */
export const cameraAvailable = () => typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
