import { z } from 'zod';
import { Status } from './status';

export const FieldType = z.enum(['checkbox', 'date', 'number', 'short_text', 'enum', 'free_text']);
export type FieldType = z.infer<typeof FieldType>;

export const Category = z.enum([
  'checkbox',
  'date_clinical',
  'date_admin',
  'vital_number',
  'admin_number',
  'short_text',
  'lab_result',
  'free_text',
]);
export type Category = z.infer<typeof Category>;

// Page schemas are data: one FieldDef per field of the paper form.
export const FieldDef = z.object({
  id: z.string(),
  label_fr: z.string(),
  label_en: z.string(),
  type: FieldType,
  category: Category,
  unit: z.string().optional(),
  allowed_values: z.array(z.string()).optional(),
  applicability: z.string().optional(),
  validators: z.array(z.string()),
  zone: z.string(),
});
export type FieldDef = z.infer<typeof FieldDef>;

export const ConfidenceSignals = z.object({
  token_prob: z.number().optional(),
  agreement: z.number().optional(),
  validators_passed: z.boolean(),
  quality: z.number().min(0).max(1),
});
export type ConfidenceSignals = z.infer<typeof ConfidenceSignals>;

export const ExtractedField = z.object({
  field_id: z.string(),
  value: z.union([z.string(), z.boolean(), z.null()]),
  verbatim: z.string().nullable().optional(),
  status: Status,
  confidence_signals: ConfidenceSignals,
  calibrated: z.number().min(0).max(1).optional(),
  source_page: z.number().int(),
  evidence: z.string().optional(), // crop id
  // Why a flagged field is in that state: 'manual' (to type), 'corrected' (typed value still failing), 'left_illegible'.
  reason: z.string().optional(),
});
export type ExtractedField = z.infer<typeof ExtractedField>;
