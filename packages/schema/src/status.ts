import { z } from 'zod';

export const Status = z.enum([
  'KNOWN',
  'UNKNOWN',
  'NOT_PROVIDED',
  'ILLEGIBLE',
  'NOT_APPLICABLE',
  'NEEDS_REVIEW',
]);
export type Status = z.infer<typeof Status>;
