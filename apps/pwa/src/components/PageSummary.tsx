import { useState } from 'react';
import type { ExtractedField, PageProgress } from '@care-agent/schema';
import { t, useLang } from '../i18n';
import { columnPart, fieldDef, fieldLabel, rowLabel } from '../schemas';
import { pageLabel, statusLabel, toReview, type PageView } from '../state';
import { buildSummary, showValue, type Section, type TableSection } from '../summary';
import { Icon } from './Icon';
import { TopBar } from './TopBar';

type Value = string | boolean | null;

interface Props {
  page: PageView;
  progress?: PageProgress;
  onClose: () => void;
  onConfirmField: (fieldId: string) => void;
  onCorrect: (fieldId: string, value: Value) => void;
  onLeave: (fieldId: string) => void;
  onRetake: () => void;
  onConfirmPage: () => void;
}

/** One page, organized like the paper: what to check first, then each part of the form (values, or a visit grid). */
export function PageSummary({ page, progress, onClose, onConfirmField, onCorrect, onLeave, onRetake, onConfirmPage }: Props) {
  useLang();
  const s = buildSummary(page.pageType, page.fields ?? []);
  const pending = toReview(page).length || s.review;
  const total = s.read + s.review;
  const share = total ? Math.round((100 * s.read) / total) : 100;
  const validated = page.validated || progress?.state === 'VALIDATED' || ['PATIENT_MATCHED', 'REGISTERED', 'SYNCED'].includes(progress?.state ?? '');
  const flaggedIds = new Set(s.flagged.map((f) => f.field_id));
  const [allFlagged, setAllFlagged] = useState(false);
  const FIRST = 8; // a long list (manual entry) opens on demand

  return (
    <div className="full" role="dialog" aria-modal="true" aria-label={t('summary.title', { type: page.pageType ?? '', label: pageLabel(page.pageType) })}>
      <TopBar
        title={t('summary.title', { type: page.pageType ?? '', label: pageLabel(page.pageType) })}
        onBack={onClose}
        right={<button className="icon-btn" onClick={onRetake} aria-label={t('review.retake')} title={t('review.retake')}><Icon name="camera" /></button>}
      />
      <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="stack-pad">
          {page.fields === null ? (
            <p className="empty-state">{t('summary.reading')}</p>
          ) : (
            <>
              <section className="card ring">
                <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
                  <circle cx="32" cy="32" r="27" fill="none" stroke="var(--line-2)" strokeWidth="8" />
                  <circle cx="32" cy="32" r="27" fill="none" stroke="var(--go)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(170 * share) / 100} 170`} transform="rotate(-90 32 32)" />
                  <text x="32" y="37" textAnchor="middle" fontSize="15" fontWeight="700" fill="currentColor">{share}%</text>
                </svg>
                <div>
                  <strong>{t('summary.counts', { read: s.read, review: s.review })}</strong>
                  <div className="muted" style={{ fontSize: 13 }}>{t('summary.detail', { empty: s.empty, checked: s.checked })}</div>
                </div>
              </section>

              {s.flagged.length > 0 && (
                <section className="card warn" aria-label={t('summary.to_check')}>
                  <div className="card-head" style={{ fontSize: 15 }}>
                    <span>{t('summary.to_check')}</span>
                    <span className="badge warn">{s.flagged.length}</span>
                  </div>
                  {(allFlagged ? s.flagged : s.flagged.slice(0, FIRST)).map((f) => (
                    <FlaggedRow key={f.field_id} field={f} editable={!validated} onConfirm={() => onConfirmField(f.field_id)} onCorrect={(v) => onCorrect(f.field_id, v)} onLeave={() => onLeave(f.field_id)} />
                  ))}
                  {!allFlagged && s.flagged.length > FIRST && (
                    <div style={{ padding: 12 }}>
                      <button className="btn wide" onClick={() => setAllFlagged(true)}>{t('summary.show_all', { n: s.flagged.length })}</button>
                    </div>
                  )}
                </section>
              )}

              {s.sections.map((sec) => (
                <SectionCard key={sec.id} section={sec} flagged={flaggedIds} />
              ))}
            </>
          )}
        </div>
      </div>
      <footer className="sticky-foot">
        {validated ? (
          <span className="pill ok" style={{ justifySelf: 'center' }}><Icon name="check" size={16} />{t('summary.confirmed')}</span>
        ) : (
          <>
            <button className="btn go wide" disabled={pending > 0 || page.fields === null} onClick={onConfirmPage}>
              {pending > 0 ? t('summary.confirm_wait', { n: pending }) : t('summary.confirm')}
            </button>
            {pending > 0 && <small>{t('summary.confirm_hint')}</small>}
          </>
        )}
      </footer>
    </div>
  );
}

/** A field to check: tap to open its actions (C'est juste / Corriger / Illisible). */
function FlaggedRow({ field, editable, onConfirm, onCorrect, onLeave }: { field: ExtractedField; editable: boolean; onConfirm: () => void; onCorrect: (v: Value) => void; onLeave: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const def = fieldDef(field.field_id);
  const chips = def?.type === 'enum' ? def.allowed_values ?? [] : null;
  const where = columnPart(field.field_id);
  const hasValue = field.value !== null && field.value !== '';
  return (
    <div>
      <button className="check-row" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!editable}>
        <span>
          <span style={{ fontWeight: 600 }}>{rowLabel(field.field_id)}{where ? ` · ${where}` : ''}</span>
          <small>{hasValue ? `« ${showValue(field)} » · ${statusLabel(field.status)}` : statusLabel(field.status)}</small>
        </span>
        <b>{t('summary.verify')}</b>
      </button>
      {open && editable && (
        <div style={{ padding: '0 16px 14px', display: 'grid', gap: 8 }}>
          {chips ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {chips.map((v) => <button key={v} className="chip answer" onClick={() => onCorrect(v)}>{v}</button>)}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="field mono" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={def?.unit ? t('review.value_in', { unit: def.unit }) : t('review.new_value')} aria-label={fieldLabel(field.field_id)} />
              <button className="btn go" onClick={() => draft.trim() && onCorrect(draft.trim())} disabled={!draft.trim()}>{t('common.save')}</button>
            </div>
          )}
          <div className="grid2">
            {hasValue && <button className="btn" onClick={onConfirm}><Icon name="check" size={18} />{t('review.confirm')}</button>}
            <button className="btn" onClick={onLeave}><Icon name="minus" size={18} />{t('review.leave')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionCard({ section, flagged }: { section: Section; flagged: Set<string> }) {
  const count = section.kind === 'table' ? section.filled : section.values.length + section.ticked.length;
  return (
    <details className="card" open={section.flagged > 0 || count > 0}>
      <summary>
        <span>{section.title}</span>
        <span className="count">{section.flagged ? t('home.status.review', { n: section.flagged }) : t('summary.fields', { n: count })}</span>
      </summary>
      {section.kind === 'table' ? <TableBody section={section} flagged={flagged} /> : count === 0 ? (
        <p className="muted" style={{ padding: '0 16px 12px', margin: 0 }}>{t('summary.empty_section')}</p>
      ) : (
        <>
          {section.values.length > 0 && (
            <div className="kv">
              {section.values.map((f) => (
                <div key={f.field_id}>
                  <span className="k">{fieldLabel(f.field_id)}</span>
                  <span className={`v${flagged.has(f.field_id) ? ' flag' : ''}`}>{showValue(f)}</span>
                </div>
              ))}
            </div>
          )}
          {section.ticked.length > 0 && (
            <div className="ticked">
              {section.ticked.map((f) => <span key={f.field_id} className="pill ok"><Icon name="check" size={14} />{fieldLabel(f.field_id)}</span>)}
            </div>
          )}
        </>
      )}
    </details>
  );
}

/** A visit grid; the pregnancy table switches trimester (the one holding the latest writing opens first). */
function TableBody({ section, flagged }: { section: TableSection; flagged: Set<string> }) {
  const filled = (i: number) => section.segments[i].rows.some((r) => r.cells.some((c) => c && c.value !== null && c.value !== '' && c.value !== false));
  const last = [...section.segments.keys()].reverse().find(filled) ?? 0;
  const [seg, setSeg] = useState(last);
  const s = section.segments[seg];
  return (
    <>
      {section.segments.length > 1 && (
        <div className="seg" role="group">
          {section.segments.map((x, i) => <button key={x.label || i} aria-pressed={i === seg} onClick={() => setSeg(i)}>{x.label}</button>)}
        </div>
      )}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th />
              {s.columns.map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                {r.cells.map((c, i) => <td key={i} className={c && flagged.has(c.field_id) ? 'flag' : ''}>{showValue(c)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
