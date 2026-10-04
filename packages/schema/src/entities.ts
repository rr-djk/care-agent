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
  replaces: z.string().uuid().optional(), // retake: id of the page this one replaces
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

/** Non-identifying card of a possible match: a fiche number, a facility and a few clinical anchors. */
export const CandidateSummary = z.object({
  fiche_number: z.string(),
  facility: z.string(),
  age: z.number().optional(),
  ddr: z.string().optional(), // dd/mm/yyyy
  gestation: z.number().optional(), // gravidity
  parite: z.number().optional(),
  visits: z.number().int(),
  last_visit: z.string().optional(), // ISO date of the last linked session
});
export type CandidateSummary = z.infer<typeof CandidateSummary>;

/** The cross-check values read on this session's own pages, shown next to each candidate (no identifier). */
export const SessionAttributes = z.object({ age: z.number().optional(), ddr: z.string().optional(), gestation: z.number().optional(), parite: z.number().optional() });
export type SessionAttributes = z.infer<typeof SessionAttributes>;

/** One line of the midwife's patient list: the key, the stage and a few anchors; no identifier. */
export const PatientSummary = z.object({
  id: z.string(),
  fiche_number: z.string(),
  facility: z.string(),
  visits: z.number().int(),
  last_visit: z.string().optional(), // ISO date of the last linked session
  stage: z.enum(['pregnancy', 'postpartum', 'unknown']), // postpartum once a delivery or postpartum page is in the record
  age: z.number().optional(),
  ddr: z.string().optional(),
  dpa: z.string().optional(), // expected delivery date, dd/mm/yyyy
  gestation: z.number().optional(),
  parite: z.number().optional(),
  duplicate: z.boolean(), // a later session of this fiche was parked as "Je ne sais pas"
});
export type PatientSummary = z.infer<typeof PatientSummary>;

export const CandidateKind = z.enum(['exact', 'near_fiche', 'near_facility', 'near_attributes']);
export type CandidateKind = z.infer<typeof CandidateKind>;

export const Candidate = z.object({
  patient_id: z.string(),
  score: z.number().min(0).max(1),
  kind: CandidateKind,
  consistent: z.boolean(), // no cross-check attribute (age, LMP, gravidity/parity, province) contradicts the session
  reasons: z.array(z.string()), // French, shown on the card
  summary: CandidateSummary,
});
export type Candidate = z.infer<typeof Candidate>;

/** What the bot asks: type the key, confirm a doubtful reading, propose one patient, propose to create, or the 4-button choice. */
export const LinkQuestion = z.enum(['need_key', 'confirm_fiche', 'propose', 'create', 'choose']);
export type LinkQuestion = z.infer<typeof LinkQuestion>;

export const LinkProposal = z.object({
  session_id: z.string(),
  fiche: z.object({
    value: z.string().nullable(),
    source: z.enum(['typed', 'cover', 'none']), // typed or confirmed by the midwife / read on the cover / missing
    low_confidence: z.boolean(),
  }),
  facility: z.string().nullable(),
  current: SessionAttributes.optional(), // this session's own cross-check values (the comparison column of the matching screen)
  question: LinkQuestion,
  text_fr: z.string(),
  candidates: z.array(Candidate), // best first, at most 2 (the 4-button question has Patient 1 and Patient 2)
});
export type LinkProposal = z.infer<typeof LinkProposal>;

const FieldValue = z.union([z.string(), z.boolean(), z.null()]);

/** Re-digitization: a page type already in the record; the midwife keeps the old value or takes the new one. */
export const Difference = z.object({
  page_id: z.string(), // the new page
  field_id: z.string(),
  label_fr: z.string(),
  page_type: z.number().int().optional(),
  old_value: FieldValue,
  old_date: z.string(), // capture date of the page the old value comes from
  new_value: FieldValue,
  choice: z.enum(['old', 'new']),
  decided: z.boolean(), // false while the choice is still the default
});
export type Difference = z.infer<typeof Difference>;

export const LinkResult = z.object({
  status: z.enum(['linked', 'not_sure']),
  patient: Patient.optional(),
  visits: z.number().int().optional(),
  differences: z.array(Difference),
});
export type LinkResult = z.infer<typeof LinkResult>;

export const PatientRecord = z.object({
  patient: Patient,
  visits: z.array(
    z.object({
      session_id: z.string(),
      date: z.string(),
      pages: z.array(z.object({ page_id: z.string(), page_type: z.number().int().optional(), captured_at: z.string(), state: LifecycleState })),
    }),
  ),
  // the retained value of each non-empty field, with the page and date it comes from
  values: z.array(
    z.object({ page_type: z.number().int().optional(), field_id: z.string(), label_fr: z.string(), value: FieldValue, source_page_id: z.string(), source_date: z.string() }),
  ),
});
export type PatientRecord = z.infer<typeof PatientRecord>;

export const LinkDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('patient'), patient_id: z.string() }),
  z.object({ kind: z.literal('create_new') }),
  z.object({ kind: z.literal('not_sure') }),
]);
export type LinkDecision = z.infer<typeof LinkDecision>;
