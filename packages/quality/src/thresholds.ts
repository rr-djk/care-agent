/**
 * PROVISIONAL thresholds (step 10): chosen by eye on the specimen renders, the 5 real photos and synthetic degradations.
 * Step 13 recalibrates them from the "measured quality -> field accuracy" curve (docs/quality.md).
 */
export const THRESHOLDS = {
  workingSize: 1000, // px, long side of the analysed copy
  blurMin: 250, // median Laplacian variance of the inked tiles below this: blurry
  isotropyMin: 0.25, // min/max gradient ratio below this: motion blur
  lumaRejectMax: 20, // mean luma of the whole photo below this: black, nothing to read
  lumaDarkMax: 90, // page mean luma below this: too dark
  lumaBrightMin: 225, // page mean luma above this: too bright
  clippedMax: 0.15, // share of saturated pixels (> 250) on the page
  blackMax: 0.1, // share of black pixels (< 15) on the page
  spreadMin: 40, // p99 - p1 of the page luma below this: flat, washed out
  glareMax: 0.03, // share of the page under large white blobs
  areaMin: 0.4, // page area share of the image below this: too far
  cornerMargin: 0.005, // fraction of the width/height the 4 corners must stay away from the border
  skewMaxDeg: 10, // largest corner angle deviation from 90 degrees
} as const;
