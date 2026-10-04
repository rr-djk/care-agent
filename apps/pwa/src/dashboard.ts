import type { Aggregates, StatBlock } from '@care-agent/schema';
import { getLang } from './i18n';

/** Bar widths in percent of the largest visible count; hidden counts (null) and empty blocks get 0. */
export function barWidths(block: StatBlock): number[] {
  const max = Math.max(0, ...block.bins.map((b) => b.count ?? 0));
  return block.bins.map((b) => (max && b.count ? Math.round((100 * b.count) / max) : 0));
}

/** « < 5 » for a hidden count (small-cell suppression), the number otherwise. */
export const countText = (count: number | null) => (count === null ? '< 5' : String(count));

// The server writes the dashboard in French (stats.ts); its English version, by exact text.
const EN: Record<string, string> = {
  'Dossiers validés et reliés': 'Validated, linked records',
  'Jeu synthétique de référence (200 femmes, non issu de photos)': 'Synthetic reference dataset (200 women, not from photos)',
  'Tension artérielle systolique (mmHg)': 'Systolic blood pressure (mmHg)',
  'Tension artérielle systolique moyenne (mmHg)': 'Mean systolic blood pressure (mmHg)',
  'Température (°C)': 'Temperature (°C)',
  'Mères (post-partum) et nouveau-nés.': 'Mothers (postpartum) and newborns.',
  'Sérologie VIH': 'HIV serology',
  'Syphilis (TPHA/VDRL)': 'Syphilis (TPHA/VDRL)',
  Syphilis: 'Syphilis',
  'Hépatite B (Ag HBs)': 'Hepatitis B (HBsAg)',
  "Le registre papier porte l'Ag HBs, pas l'hépatite C.": 'The paper register records HBsAg, not hepatitis C.',
  'Hépatite C': 'Hepatitis C',
  Négatif: 'Negative',
  Positif: 'Positive',
};

/** A dashboard text in the current language: the server's French, or its English version (bands: "36,0 à 37,4" -> "36.0 to 37.4"). */
export function statText(fr: string): string {
  if (getLang() === 'fr') return fr;
  return EN[fr] ?? fr.replace(/(\d),(\d)/g, '$1.$2').replace(' à ', ' to ');
}

export const sourceTitle = (a: Aggregates) => statText(a.source_fr);
