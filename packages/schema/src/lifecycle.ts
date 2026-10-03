import { z } from 'zod';

export const LifecycleState = z.enum([
  'CAPTURED',
  'PENDING_AI',
  'AI_PROCESSED',
  'NEEDS_REVIEW',
  'VALIDATED',
  'PATIENT_MATCHED',
  'REGISTERED',
  'SYNCED',
  'PROCESSING_FAILED',
  'SYNC_FAILED',
  'DUPLICATE_SUSPECTED',
  'MANUAL_REVIEW_REQUIRED',
]);
export type LifecycleState = z.infer<typeof LifecycleState>;

export const Flag = z.enum(['LOW_QUALITY']);
export type Flag = z.infer<typeof Flag>;

export const ALLOWED_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  CAPTURED: ['PENDING_AI', 'MANUAL_REVIEW_REQUIRED'], // second edge: AI unavailable, manual entry
  PENDING_AI: ['AI_PROCESSED', 'PROCESSING_FAILED'],
  PROCESSING_FAILED: ['PENDING_AI', 'MANUAL_REVIEW_REQUIRED'], // retry
  AI_PROCESSED: ['NEEDS_REVIEW'], // the midwife always reviews; no auto-validation
  NEEDS_REVIEW: ['VALIDATED', 'MANUAL_REVIEW_REQUIRED'],
  MANUAL_REVIEW_REQUIRED: ['VALIDATED'],
  VALIDATED: ['PATIENT_MATCHED', 'DUPLICATE_SUSPECTED'],
  DUPLICATE_SUSPECTED: ['PATIENT_MATCHED'],
  PATIENT_MATCHED: ['REGISTERED'],
  REGISTERED: ['SYNCED', 'SYNC_FAILED'],
  SYNC_FAILED: ['REGISTERED'], // retry
  SYNCED: [],
};

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
