import type { ExtractedField, FieldDef } from '@care-agent/schema';
import type { EditResult, FieldEdit } from './fields';

// Deterministic chat engine: a regex/intent parser for the short French answers a midwife gives about the CURRENT
// review item. It only produces an intent; the action runs through the same code as the buttons (applyFieldEdit).

export type Intent =
  | { kind: 'confirm' | 'leave_illegible' | 'retake' | 'unknown' }
  | { kind: 'value'; value: string | boolean };

const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').replace(/[\s.!?]+$/, '').trim();
const key = (s: string) => fold(s).replace(/[^a-z0-9]/g, '');

const CONFIRM = /^(?:oui,? )?(?:c'?est (?:bon|ca|correct|exact|juste)|ok|okay|d'?accord|correct|exact|confirme|confirmer|valide)(?: merci)?$/;
const LEAVE = /\b(?:je (?:ne )?sais pas|illisible|ne se lit pas|je ne vois pas)\b/;
const RETAKE = /\b(?:reprendre|reprise|nouvelle photo|refaire la photo)\b/;
const YES = /^(?:oui|yes|x|coche|coché)$/;
const NO = /^(?:non|no|vide|non coche)$/;
const NUMBER = /^(?:c'?est |environ |de )?(\d+(?:[.,]\d+)?)\s*([a-z%]*)$/;
const DATE = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/;
const BP = /(\d{2,3})\s*(?:\/|sur)\s*(\d{2,3})/;

/** The allowed value the answer names: exact (accents and case ignored), else a unique prefix ("negatif" -> "Neg"). */
function enumValue(allowed: string[], answer: string): string | undefined {
  const k = key(answer);
  const exact = allowed.filter((a) => key(a) === k);
  if (exact.length === 1) return exact[0];
  const near = k.length >= 3 ? allowed.filter((a) => key(a).startsWith(k) || k.startsWith(key(a))) : [];
  return near.length === 1 ? near[0] : undefined;
}

/** What a message means for a field (its type decides which value shapes are understood). */
export function parseAnswer(message: string, def?: FieldDef): Intent {
  const m = fold(message);
  if (CONFIRM.test(m)) return { kind: 'confirm' };
  if (LEAVE.test(m)) return { kind: 'leave_illegible' };
  if (RETAKE.test(m)) return { kind: 'retake' };
  const value = (v: string | boolean): Intent => ({ kind: 'value', value: v });
  switch (def?.type) {
    case 'checkbox':
      return YES.test(m) ? value(true) : NO.test(m) ? value(false) : { kind: 'unknown' };
    case 'date': {
      const d = DATE.exec(m);
      return d ? value(`${d[1]}/${d[2]}/${d[3]}`) : { kind: 'unknown' };
    }
    case 'number': {
      const n = NUMBER.exec(m);
      if (n) return value(n[2] ? `${n[1]} ${n[2]}` : n[1]);
      break;
    }
    case 'enum': {
      const v = enumValue(def.allowed_values ?? [], m);
      if (v) return value(v);
      break;
    }
    case 'short_text': {
      const bp = def.validators.includes('bp') ? BP.exec(m) : null;
      if (bp) return value(`${bp[1]}/${bp[2]}`);
      break;
    }
  }
  return /^(?:oui|yes)$/.test(m) ? { kind: 'confirm' } : { kind: 'unknown' }; // "oui" to a read value
}

export const NOT_UNDERSTOOD = "Je n'ai pas compris. Tapez la valeur, ou utilisez les boutons.";
export const NOTHING_TO_REVIEW = 'Il n’y a rien à vérifier pour le moment.';
export const RETAKE_HINT = 'D’accord. Touchez « Reprendre la photo » pour refaire la page.';
const NO_VALUE = 'Il n’y a pas de valeur à confirmer : tapez la valeur, ou laissez le champ illisible.';

export interface ChatTarget {
  field: ExtractedField;
  label: string;
  def?: FieldDef;
}

const show = (v: ExtractedField['value']) => (typeof v === 'boolean' ? (v ? 'coché' : 'non coché') : v === null ? '—' : v);

/** French reply describing the result of an edit (the field after the edit, with the guard's note if any). */
export function describeEdit(label: string, r: EditResult, verb: 'confirm' | 'correct' | 'leave_illegible'): string {
  if (verb === 'leave_illegible') return `${label} reste illisible.`;
  if (r.status === 'NEEDS_REVIEW') return r.text_fr ?? `${label} reste à vérifier.`;
  const done = verb === 'confirm' ? `${label} confirmé : ${show(r.value)}.` : `C’est noté : ${label} = ${show(r.value)}.`;
  return r.text_fr ? `${done} ${r.text_fr}` : done;
}

/** Interprets `message` for the current item and applies it with `apply`; returns the French reply. */
export function deterministicReply(message: string, target: ChatTarget | null, apply: (edit: FieldEdit) => EditResult): string {
  if (!target) return NOTHING_TO_REVIEW;
  const intent = parseAnswer(message, target.def);
  const { field, label } = target;
  switch (intent.kind) {
    case 'confirm':
      return field.value === null || field.value === '' ? NO_VALUE : describeEdit(label, apply({ confirm: true }), 'confirm');
    case 'leave_illegible':
      return describeEdit(label, apply({ value: null, status: 'ILLEGIBLE' }), 'leave_illegible');
    case 'retake':
      return RETAKE_HINT;
    case 'value':
      return describeEdit(label, apply({ value: intent.value }), 'correct');
    default:
      return NOT_UNDERSTOOD;
  }
}
