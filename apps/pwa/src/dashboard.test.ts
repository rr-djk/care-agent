import type { StatBlock } from '@care-agent/schema';
import { describe, expect, it } from 'vitest';
import { barWidths, countText } from './dashboard';

const block = (counts: (number | null)[]): StatBlock => ({ id: 'hiv', title_fr: 't', n: 0, bins: counts.map((count, i) => ({ label_fr: `b${i}`, count })) });

describe('dashboard helpers', () => {
  it('scales the bars to the largest visible count; hidden and zero counts have no bar', () => {
    expect(barWidths(block([20, 10, null, 0]))).toEqual([100, 50, 0, 0]);
    expect(barWidths(block([null, null]))).toEqual([0, 0]);
    expect(barWidths(block([]))).toEqual([]);
  });
  it('shows a hidden count as « < 5 »', () => {
    expect([countText(null), countText(0), countText(12)]).toEqual(['< 5', '0', '12']);
  });
});
