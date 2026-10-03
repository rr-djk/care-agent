import { z } from 'zod';

export const PageType = z.number().int().min(1).max(8);
export type PageType = z.infer<typeof PageType>;

// Pages 7 and 8 reuse the layouts of pages 5 and 6.
export const LAYOUT = {
  1: 'cover',
  2: 'identification',
  3: 'pregnancy',
  4: 'delivery',
  5: 'postpartum_mother',
  6: 'postpartum_newborn',
  7: 'postpartum_mother',
  8: 'postpartum_newborn',
} as const satisfies Record<PageType, string>;
export type Layout = (typeof LAYOUT)[keyof typeof LAYOUT];
