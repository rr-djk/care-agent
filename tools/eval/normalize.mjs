// Same rule as normalize.py (see the comparison rule there): case-fold, strip accents,
// decimal comma -> dot, remove all whitespace. A dropped letter is not repaired ("N ant" != "Néant").
const MAP = { œ: 'oe', æ: 'ae', '’': "'", '‘': "'", '–': '-', '—': '-', '−': '-' };

export function normalize(value) {
  return String(value)
    .normalize('NFD')
    .toLowerCase()
    .replace(/[œæ’‘–—−]/g, (c) => MAP[c])
    .replace(/\p{M}/gu, '')
    .replace(/(\d)\s*,\s*(\d)/g, '$1.$2')
    .replace(/\s+/g, '');
}
