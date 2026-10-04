import { useState } from 'react';
import type { ReviewItem } from '@care-agent/schema';
import { getLang, t, useLang, type Key } from '../i18n';
import { columnPart, fieldDef, fieldLabel, rowLabel } from '../schemas';
import { Icon } from './Icon';

type Value = string | boolean | null;

const showValue = (v: Value) => (v === null || v === '' ? null : typeof v === 'boolean' ? (v ? t('summary.checked') : t('summary.unchecked')) : v);
const isoToFr = (iso: string) => iso.split('-').reverse().join('/'); // <input type="date"> gives yyyy-mm-dd

/** The doubt in the current language: the server's French sentence, or the same sentence built from the reason code. */
export function reviewText(item: ReviewItem): string {
  if (getLang() === 'fr') return item.text_fr;
  const value = showValue(item.value) ?? '';
  return t(`review.text.${item.reason_code}` as Key, { label: fieldLabel(item.field_id), value });
}

interface Props {
  item: ReviewItem;
  progress: { done: number; total: number };
  active: boolean; // only the current question has buttons
  onConfirm: () => void;
  onCorrect: (value: Value) => void;
  onRetake: () => void;
  onLeave: () => void;
}

/** One review question: the doubt, the value read (large), and C'est juste / Corriger / Reprendre la photo / Illisible. */
export function ReviewCard({ item, progress, active, onConfirm, onCorrect, onRetake, onLeave }: Props) {
  useLang();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [details, setDetails] = useState(false);
  const def = fieldDef(item.field_id);
  const value = showValue(item.value);
  const chips = def?.type === 'enum' ? (def.allowed_values ?? []).map((v) => [v, v] as const) : def?.type === 'checkbox' ? ([[t('summary.checked'), true], [t('summary.unchecked'), false]] as const) : null;
  const has = (a: ReviewItem['actions'][number]) => item.actions.includes(a);
  const where = columnPart(item.field_id);
  const tone = item.kind === 'doubt' ? '' : 'bad';

  const save = () => {
    if (!draft.trim()) return;
    onCorrect(def?.type === 'date' && draft.includes('-') ? isoToFr(draft) : draft.trim());
    setEditing(false);
    setDraft('');
  };

  return (
    <div className="bubble bot card">
      <div className={`card-head ${tone}`}>
        <span>{active ? t('review.header', { done: progress.done + 1, total: progress.total }) : t('status.NEEDS_REVIEW')}</span>
        <span>{rowLabel(item.field_id)}{where ? ` · ${where}` : ''}</span>
      </div>
      <div className="card-body">
        <p>{reviewText(item)}</p>
        {value && (
          <div className="value-box">
            <span className="k">{rowLabel(item.field_id)}</span>
            <span className="v">{value}</span>
            {def?.unit && <span className="k">{def.unit}</span>}
          </div>
        )}
        {item.detail_fr && (
          <p className="hint">
            <button className="linkish" onClick={() => setDetails(!details)}>{t('review.details')}</button>
            {details && <span> {item.detail_fr}</span>}
          </p>
        )}
        {active &&
          (editing ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {chips ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {chips.map(([label, v]) => (
                    <button key={label} className="chip answer" onClick={() => onCorrect(v)}>{label}</button>
                  ))}
                </div>
              ) : (
                <input
                  className="field mono"
                  type={def?.type === 'date' ? 'date' : 'text'}
                  inputMode={def?.type === 'number' ? 'decimal' : undefined}
                  placeholder={def?.validators.includes('bp') ? '120/80' : def?.unit ? t('review.value_in', { unit: def.unit }) : t('review.new_value')}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && save()}
                  aria-label={t('review.new_value')}
                  autoFocus
                />
              )}
              <div className="grid2">
                <button className="btn" onClick={() => setEditing(false)}>{t('common.cancel')}</button>
                {!chips && <button className="btn go" onClick={save}>{t('common.save')}</button>}
              </div>
            </div>
          ) : (
            <div className="grid2">
              {has('confirm') && <button className="btn go" onClick={onConfirm}><Icon name="check" size={18} />{t('review.confirm')}</button>}
              {has('correct') && (
                <button
                  className="btn"
                  onClick={() => {
                    setDraft(typeof item.value === 'string' && def?.type !== 'date' && !chips ? item.value : '');
                    setEditing(true);
                  }}
                >
                  <Icon name="edit" size={18} />
                  {t('review.correct')}
                </button>
              )}
              {has('retake') && <button className="btn" onClick={onRetake}><Icon name="camera" size={18} />{t('review.retake')}</button>}
              {has('leave_illegible') && <button className="btn" onClick={onLeave}><Icon name="minus" size={18} />{t('review.leave')}</button>}
            </div>
          ))}
      </div>
    </div>
  );
}
