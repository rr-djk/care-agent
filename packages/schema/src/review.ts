import { z } from 'zod';
import { LifecycleState } from './lifecycle';
import { PageType } from './page';

export const ReviewKind = z.enum(['doubt', 'illegible', 'unread', 'manual']);
export type ReviewKind = z.infer<typeof ReviewKind>;

export const ReviewReason = z.enum(['unusual_value', 'ink_but_empty', 'illegible', 'not_read', 'manual', 'low_quality']);
export type ReviewReason = z.infer<typeof ReviewReason>;

export const ReviewAction = z.enum(['confirm', 'correct', 'retake', 'leave_illegible']);
export type ReviewAction = z.infer<typeof ReviewAction>;

/** One field that needs the midwife, with the agent's doubt said out loud in French. */
export const ReviewItem = z.object({
  page_id: z.string(),
  field_id: z.string(),
  kind: ReviewKind,
  label_fr: z.string(),
  value: z.union([z.string(), z.boolean(), z.null()]),
  reason_code: ReviewReason,
  text_fr: z.string(),
  actions: z.array(ReviewAction),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const PageProgress = z.object({
  page_id: z.string(),
  page_type: PageType.optional(),
  state: LifecycleState,
  total: z.number().int(), // flagged fields of the page: still open + already reviewed
  done: z.number().int(),
});
export type PageProgress = z.infer<typeof PageProgress>;

/** GET /api/sessions/:id/review: the ordered queue (pages in capture order) and the progress counts. */
export const ReviewQueue = z.object({
  items: z.array(ReviewItem),
  progress: z.object({ total: z.number().int(), done: z.number().int(), pages: z.array(PageProgress) }),
});
export type ReviewQueue = z.infer<typeof ReviewQueue>;
