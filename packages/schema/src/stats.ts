import { z } from 'zod';

/** Counts below this are hidden (small-cell suppression): a handful of readings must not single a woman out. */
export const MIN_CELL = 5;

/** One bar of a dashboard distribution. `count` is null when it is hidden (1 to MIN_CELL - 1 readings). */
export const StatBin = z.object({ label_fr: z.string(), count: z.number().int().nullable() });
export type StatBin = z.infer<typeof StatBin>;

export const StatBlock = z.object({
  id: z.enum(['bp_systolic', 'temperature', 'hiv', 'syphilis', 'hepatitis']),
  title_fr: z.string(),
  note_fr: z.string().optional(),
  n: z.number().int(), // readings counted (a woman can have several)
  bins: z.array(StatBin),
});
export type StatBlock = z.infer<typeof StatBlock>;

/** Anonymized aggregates: counts per band over validated, linked readings; no id, no date finer than the source label. */
export const Aggregates = z.object({
  source: z.enum(['records', 'reference']),
  source_fr: z.string(),
  blocks: z.array(StatBlock),
});
export type Aggregates = z.infer<typeof Aggregates>;
