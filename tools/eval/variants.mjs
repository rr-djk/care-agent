// Degraded variants of the specimen pages: ids, manifest entries and the no-leakage check (a variant keeps the split
// group of its source page). The image operations are in degrade.mjs.

/** id -> family and level (the x axis of the quality curve). */
export const VARIANTS = [
  { id: 'blur-s1', family: 'gaussian blur (sigma)', level: 1 },
  { id: 'blur-s2', family: 'gaussian blur (sigma)', level: 2 },
  { id: 'blur-s4', family: 'gaussian blur (sigma)', level: 4 },
  { id: 'motion-15', family: 'motion blur (px)', level: 15 },
  { id: 'dark-0.6', family: 'darkness (gain)', level: 0.6 },
  { id: 'dark-0.4', family: 'darkness (gain)', level: 0.4 },
  { id: 'glare', family: 'glare (page share)', level: 0.08 },
  { id: 'jpeg-q30', family: 'JPEG (quality)', level: 30 },
  { id: 'down-0.5', family: 'downscale (factor)', level: 0.5 },
  { id: 'persp-mild', family: 'perspective', level: 1 },
  { id: 'persp-strong', family: 'perspective', level: 2 },
];

/** Split group name of a page ('tune' | 'calibrate' | 'verify'), undefined when the page is in none. */
export const groupOf = (split, pageNo) => Object.keys(split.groups).find((g) => split.groups[g].pages.includes(Number(pageNo)));

/** Manifest entry of one variant of one page; `patient` and `group` are those of the source page. */
export function manifestEntry(page, variantId, split) {
  const v = VARIANTS.find((x) => x.id === variantId);
  if (!v) throw new Error(`unknown variant "${variantId}" (known: ${VARIANTS.map((x) => x.id).join(', ')})`);
  const group = groupOf(split, page.page_no);
  if (!group) throw new Error(`page ${page.page_no} is in no split group`);
  return { id: `${page.page_no}/${variantId}`, page_no: page.page_no, variant: variantId, family: v.family, level: v.level, patient: page.patient, group, file: `${page.page_no}/${variantId}.png` };
}

/** Throws when an entry's patient or group differs from its source page's (leakage between tune, calibrate and verify). */
export function verifyManifest(manifest, split, pages) {
  for (const e of manifest.variants) {
    const page = pages.find((p) => p.page_no === e.page_no);
    if (!page) throw new Error(`variant ${e.id}: unknown source page ${e.page_no}`);
    if (e.patient !== page.patient) throw new Error(`variant ${e.id}: patient ${e.patient} != source patient ${page.patient}`);
    if (e.group !== groupOf(split, e.page_no)) throw new Error(`variant ${e.id}: group ${e.group} != source group ${groupOf(split, e.page_no)} (leakage)`);
  }
}
