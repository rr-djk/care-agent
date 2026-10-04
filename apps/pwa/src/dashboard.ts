import type { StatBlock } from '@care-agent/schema';

/** Bar widths in percent of the largest visible count; hidden counts (null) and empty blocks get 0. */
export function barWidths(block: StatBlock): number[] {
  const max = Math.max(0, ...block.bins.map((b) => b.count ?? 0));
  return block.bins.map((b) => (max && b.count ? Math.round((100 * b.count) / max) : 0));
}

/** « < 5 » for a hidden count (small-cell suppression), the number otherwise. */
export const countText = (count: number | null) => (count === null ? '< 5' : String(count));
