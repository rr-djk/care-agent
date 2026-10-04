import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Quad } from '@care-agent/quality';
import { createStability } from '@care-agent/quality/stability';
import { qualityText, t, useLang, type Key } from '../i18n';
import { checkFrame } from '../quality/client';
import { guideRect } from '../quality/guide';

const FRAME_MS = 250; // ~4 analysed frames per second
const ANALYSIS_SIDE = 1000; // frames are analysed at the same size as the post-capture check, so blur values compare

interface Props {
  onCapture: (file: File) => void;
  onCancel: () => void;
}

/** Live camera with an A4 guide: green when framing, blur and exposure pass; auto-capture once green and still for ~0.5 s. */
export function CameraCapture({ onCapture, onCancel }: Props) {
  useLang();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const shooting = useRef(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [pass, setPass] = useState(false);
  // what the hint says: one of the app's sentences, or a message of the quality gate (French, translated when shown)
  const [hint, setHint] = useState<{ key: Key } | { gate: string }>({ key: 'camera.starting' });
  const [failed, setFailed] = useState(false);

  const stop = () => stream.current?.getTracks().forEach((t) => t.stop());

  const shoot = async () => {
    const v = video.current;
    if (!v || shooting.current) return;
    shooting.current = true;
    const blob = (await stillPhoto(stream.current!, v)) ?? (await frameBlob(v));
    stop();
    onCapture(new File([blob], `page-${Date.now()}.jpg`, { type: 'image/jpeg' }));
  };
  const shootRef = useRef(shoot);
  shootRef.current = shoot;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stability = createStability();

    const loop = async () => {
      const v = video.current;
      if (!alive || !v) return;
      if (v.videoWidth && !shooting.current) {
        try {
          const k = ANALYSIS_SIDE / Math.max(v.videoWidth, v.videoHeight);
          const bitmap = await createImageBitmap(v, { resizeWidth: Math.round(v.videoWidth * k), resizeHeight: Math.round(v.videoHeight * k), resizeQuality: 'medium' });
          const { result, details } = await checkFrame(bitmap);
          const ok = result.outcome === 'OK';
          if (!alive) return;
          setPass(ok);
          setHint(ok ? { key: 'camera.hold' } : result.messages[0] ? { gate: result.messages[0] } : { key: 'camera.frame' });
          if (stability.push(performance.now(), ok, details.quad as Quad | null)) void shootRef.current();
        } catch {
          // a failed frame is skipped; a dead worker restarts on the next call
        }
      }
      timer = setTimeout(loop, FRAME_MS);
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(async (s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        const v = video.current!;
        v.srcObject = s;
        await v.play();
        setSize({ w: v.videoWidth, h: v.videoHeight });
        setHint({ key: 'camera.frame' });
        void loop();
      })
      .catch(() => {
        setFailed(true);
        setHint({ key: 'camera.unavailable' });
      });

    return () => {
      alive = false;
      clearTimeout(timer);
      stop();
    };
  }, []);

  const g = size ? guideRect(size.w, size.h) : null;
  return (
    <div className="camera" role="dialog" aria-label={t('camera.title')}>
      {!failed && (
        <div className="camera-stage">
          {/* the frame has exactly the aspect ratio of the video, so guide fractions are fractions of the captured image */}
          <div className="camera-frame" style={{ '--r': size ? size.w / size.h : 16 / 9 } as CSSProperties}>
            <video ref={video} playsInline muted />
            {g && (
              <div
                className={`guide ${pass ? 'ok' : ''}`}
                data-testid="guide"
                style={{ left: `${g.x * 100}%`, top: `${g.y * 100}%`, width: `${g.w * 100}%`, height: `${g.h * 100}%` }}
              />
            )}
          </div>
        </div>
      )}
      <p className={`camera-hint ${pass ? 'ok' : ''}`} role="status">
        {'key' in hint ? t(hint.key) : qualityText(hint.gate)}
      </p>
      <div className="camera-actions">
        <button className="btn" onClick={onCancel}>{t('camera.cancel')}</button>
        {failed ? (
          <label className="btn go">
            {t('chat.import')}
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && onCapture(e.target.files[0])} />
          </label>
        ) : (
          <button className="btn go" onClick={() => void shoot()} disabled={!size}>
            {t('camera.shoot')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Full-resolution still through ImageCapture when it exists AND has the frame's aspect ratio (so the guide still maps); else null. */
async function stillPhoto(s: MediaStream, v: HTMLVideoElement): Promise<Blob | null> {
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
  if (!IC) return null;
  try {
    const blob = await new IC(s.getVideoTracks()[0]).takePhoto();
    const bmp = await createImageBitmap(blob);
    const same = Math.abs(bmp.width / bmp.height / (v.videoWidth / v.videoHeight) - 1) < 0.02;
    bmp.close();
    return same ? blob : null; // another aspect = another field of view: the guide would not map
  } catch {
    return null;
  }
}

/** The current video frame at the video's own resolution, as a JPEG. */
function frameBlob(v: HTMLVideoElement): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d')!.drawImage(v, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('capture_failed'))), 'image/jpeg', 0.92));
}
