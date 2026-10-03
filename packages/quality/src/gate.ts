import type { QualityResult } from '@care-agent/schema';
import { getCv, Scope, type CV, type RawImage } from './cv';
import { blurMetric, exposureMetric, glareMetric, type Blur, type Exposure } from './metrics';
import { toRgbMat, workingCopy } from './prepare';
import { cornersInside, detectPage, maxAngleDeviation, quadArea, type Quad } from './quad';
import { THRESHOLDS as T } from './thresholds';

type Mat = InstanceType<CV['Mat']>;

export interface QualityDetails {
  blur: Blur;
  exposure: Exposure;
  glare: number | null; // null in live mode (not measured)
  quad: Quad | null; // page corners as fractions of the image (0..1)
  fullPage: boolean;
  paperShare: number;
  skewDeg: number;
  cornersInside: boolean;
}

export interface Assessment {
  result: QualityResult;
  details: QualityDetails;
}

/** 8UC1 mask of the page interior (eroded so the paper edge and the table do not count), null when the page is the image. */
function pageMask(quad: Quad | null, fullPage: boolean, w: number, h: number, s: Scope): Mat | null {
  if (!quad || fullPage) return null;
  const cv = getCv();
  const mask = s.add(cv.Mat.zeros(h, w, cv.CV_8UC1));
  const pts = s.add(cv.matFromArray(4, 1, cv.CV_32SC2, quad.flatMap((p) => [Math.round(p.x), Math.round(p.y)])));
  cv.fillConvexPoly(mask, pts, new cv.Scalar(255), cv.LINE_8, 0);
  cv.erode(mask, mask, s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9))));
  return mask;
}

/**
 * The gate: metrics on a ~1000 px grayscale copy, then three outcomes. REJECT only for hopeless photos (black, no paper);
 * everything else that is doubtful is a WARNING the midwife may override. `live` skips the glare measure (video frames).
 */
export function assess(image: RawImage, opts: { live?: boolean } = {}): Assessment {
  const cv = getCv();
  const s = new Scope();
  try {
    const { rgb } = workingCopy(toRgbMat(image, s), s);
    const { cols: w, rows: h } = rgb;
    const gray = s.add(new cv.Mat());
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

    const page = detectPage(rgb);
    const mask = pageMask(page.quad, page.fullPage, w, h, s);
    const blur = blurMetric(gray, page.quad);
    const exposure = exposureMetric(gray, mask);
    const wholeMean = mask ? exposureMetric(gray, null).mean : exposure.mean;
    const area = page.quad ? quadArea(page.quad) : 0;
    const glare = opts.live || !page.quad ? null : glareMetric(rgb, mask, page.fullPage ? w * h : area);
    const skewDeg = page.quad ? maxAngleDeviation(page.quad) : 0;
    const inside = !!page.quad && (page.fullPage || cornersInside(page.quad, w, h, T.cornerMargin));
    const areaShare = page.fullPage ? 1 : area / (w * h);

    const messages: string[] = [];
    let outcome: QualityResult['outcome'] = 'OK';
    const warn = (m: string) => {
      outcome = 'WARNING';
      messages.push(m);
    };

    if (wholeMean < T.lumaRejectMax) {
      outcome = 'REJECT';
      messages.push('Photo noire : rien n\'est visible. Vérifiez l\'objectif et la lumière');
    } else if (!page.quad && page.paperShare < 0.05) {
      outcome = 'REJECT';
      messages.push('Aucune page visible : cadrez la page entière');
    } else {
      if (!page.quad) warn('Page non détectée : posez la page à plat sur un fond sombre et cadrez-la entièrement');
      else if (!inside) warn('Page coupée : reculez pour voir les 4 coins');
      else if (areaShare < T.areaMin) warn('Page trop petite dans l\'image : rapprochez-vous');
      else if (skewDeg > T.skewMaxDeg) warn('Photo prise de biais : placez-vous au-dessus de la page');
      if (blur.tiles > 0 && blur.sharpness < T.blurMin) warn('Photo floue : rapprochez-vous et tenez le téléphone immobile');
      else if (blur.tiles > 0 && blur.isotropy < T.isotropyMin) warn('Photo bougée : tenez le téléphone immobile');
      if (exposure.mean < T.lumaDarkMax || exposure.black > T.blackMax) warn('Trop sombre : approchez-vous d\'une source de lumière');
      else if (exposure.mean > T.lumaBrightMin || exposure.clipped > T.clippedMax) warn('Trop clair : évitez la lumière directe sur la page');
      else if (exposure.spread < T.spreadMin) warn('Contraste trop faible : changez l\'éclairage');
      if (glare !== null && glare > T.glareMax) warn('Reflet sur la page : inclinez légèrement le téléphone');
    }

    const norm = (q: Quad | null): Quad | null => (q ? (q.map((p) => ({ x: p.x / w, y: p.y / h })) as Quad) : null);
    return {
      result: { outcome, metrics: { blur: blur.sharpness, brightness: exposure.mean, glare: glare ?? 0, framing: page.quad ? areaShare : 0 }, messages },
      details: { blur, exposure, glare, quad: norm(page.quad), fullPage: page.fullPage, paperShare: page.paperShare, skewDeg, cornersInside: inside },
    };
  } finally {
    s.free();
  }
}
