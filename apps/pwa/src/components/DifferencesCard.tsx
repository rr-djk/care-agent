import type { Difference } from '@care-agent/schema';
import { fmtDate, t, useLang } from '../i18n';
import { fieldLabel } from '../schemas';

const show = (v: Difference['old_value']) => (v === null || v === '' || v === false ? '—' : v === true ? t('summary.checked') : v);

interface Props {
  differences: Difference[];
  onChoose: (d: Difference, choice: 'old' | 'new') => void;
}

/** Re-digitization: a page type already in the record. One row per field that differs; both photos are kept either way. */
export function DifferencesCard({ differences, onChoose }: Props) {
  useLang();
  if (!differences.length) return null;
  return (
    <div className="bubble bot card">
      <div className="card-head">{t('diff.intro')}</div>
      <div className="card-body">
        <p className="hint" style={{ marginTop: 0 }}>{t('diff.hint')}</p>
        {differences.map((d) => (
          <div key={`${d.page_id}|${d.field_id}`} style={{ display: 'grid', gap: 6, paddingTop: 8, borderTop: '1px solid var(--line-2)' }}>
            <strong>{fieldLabel(d.field_id)}</strong>
            <span className="muted">
              {t('diff.old', { date: fmtDate(d.old_date) })} : <span className="mono">{show(d.old_value)}</span> · {t('diff.new')} : <span className="mono">{show(d.new_value)}</span>
            </span>
            <div className="grid2">
              <button className={`btn ${d.choice === 'old' ? 'go' : ''}`} aria-pressed={d.choice === 'old'} onClick={() => onChoose(d, 'old')}>{t('diff.keep_old')}</button>
              <button className={`btn ${d.choice === 'new' ? 'go' : ''}`} aria-pressed={d.choice === 'new'} onClick={() => onChoose(d, 'new')}>{t('diff.take_new')}</button>
            </div>
            {!d.decided && <span className="hint">{t('diff.default')}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
