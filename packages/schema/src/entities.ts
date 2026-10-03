import { z } from 'zod';
import { LifecycleState, Flag } from './lifecycle';
import { PageType } from './page';

export const Role = z.enum(['midwife', 'supervisor']);
export type Role = z.infer<typeof Role>;

export const Session = z.object({
  id: z.string(),
  midwife_id: z.string(),
  fiche_number: z.string().optional(),
  facility: z.string().optional(),
  started_at: z.string(),
  page_ids: z.array(z.string()),
});
export type Session = z.infer<typeof Session>;

export const QualityOutcome = z.enum(['OK', 'WARNING', 'REJECT']);

export const QualityResult = z.object({
  outcome: QualityOutcome,
  metrics: z.object({
    blur: z.number(),
    brightness: z.number(),
    glare: z.number(),
    framing: z.number(),
  }),
  messages: z.array(z.string()),
});
export type QualityResult = z.infer<typeof QualityResult>;

export const RecordPage = z.object({
  id: z.string().uuid(), // created on the phone
  session_id: z.string(),
  page_type: PageType.optional(),
  captured_at: z.string(),
  midwife_id: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  state: LifecycleState,
  flags: z.array(Flag),
  quality: QualityResult.optional(),
});
export type RecordPage = z.infer<typeof RecordPage>;

// No personal identifiers: a patient is only a fiche number at a facility.
export const Patient = z.object({
  id: z.string().regex(/^PAT-\d{6}$/),
  fiche_number: z.string(),
  facility: z.string(),
  created_at: z.string(),
});
export type Patient = z.infer<typeof Patient>;

export const Candidate = z.object({
  patient_id: z.string(),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type Candidate = z.infer<typeof Candidate>;

export const LinkDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('patient'), patient_id: z.string() }),
  z.object({ kind: z.literal('create_new') }),
  z.object({ kind: z.literal('not_sure') }),
]);
export type LinkDecision = z.infer<typeof LinkDecision>;
