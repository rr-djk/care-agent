import { z } from 'zod';

/**
 * Compact model output for one zone: values only, no keys. The order of `cells`
 * is NOT in the answer; it comes from the page schema (FieldDef list of the zone,
 * rows then visits). "" = the cell is empty, null = the cell is illegible.
 */
export const ZoneAnswer = z.object({
  cells: z.array(z.string().nullable()),
});
export type ZoneAnswer = z.infer<typeof ZoneAnswer>;
