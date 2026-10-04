import { useState } from 'react';
import type { Candidate, LinkDecision, LinkProposal } from '@care-agent/schema';
import { t, useLang } from '../i18n';
import { linkButtons } from '../state';
import { Icon } from './Icon';

interface Props {
  proposal: LinkProposal;
  active: boolean; // only the current question has buttons
  offline: boolean; // the question needs the server: it waits
  onDecide: (decision: LinkDecision) => void;
  onSetKey: (key: { fiche_number?: string; facility?: string }) => void;
}

type Mark = 'same' | 'diff' | 'none';
export interface CompareRow {
  label: string;
  mine: string;
  theirs: string;
  mark: Mark;
  code?: boolean; // a number or a date: monospaced, on one line
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const day = (d?: string) => {
  const m = d ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d) : null;
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86_400_000 : undefined;
};

/**
 * This fiche next to a candidate record, item by item. The "same" rules are the server's cross-checks (linking.ts): age
 * within 1 year, LMP within 14 days, gravidity and parity equal; fiche and facility equal once case and separators are set aside.
 */
export function compareRows(p: LinkProposal, c: Candidate): CompareRow[] {
  const cur = p.current ?? {};
  const s = c.summary;
  const row = (label: string, a: string | undefined, b: string | undefined, same: (a: string, b: string) => boolean, code = false): CompareRow => ({
    label,
    mine: a ?? '—',
    theirs: b ?? '—',
    mark: a === undefined || b === undefined || a === '' || b === '' ? 'none' : same(a, b) ? 'same' : 'diff',
    ...(code && { code }),
  });
  const gp = (g?: number, par?: number) => (g === undefined && par === undefined ? undefined : `G${g ?? '?'} P${par ?? '?'}`);
  return [
    row(t('match.row.fiche'), p.fiche.value ?? undefined, s.fiche_number, (a, b) => norm(a) === norm(b), true),
    row(t('match.row.facility'), p.facility ?? undefined, s.facility || undefined, (a, b) => norm(a) === norm(b)),
    row(t('match.row.age'), cur.age === undefined ? undefined : t('match.years', { n: cur.age }), s.age === undefined ? undefined : t('match.years', { n: s.age }), () => Math.abs(cur.age! - s.age!) <= 1),
    row(t('match.row.ddr'), cur.ddr, s.ddr, (a, b) => Math.abs((day(a) ?? NaN) - (day(b) ?? NaN)) <= 14, true),
    row(t('match.row.gp'), gp(cur.gestation, cur.parite), gp(s.gestation, s.parite), (a, b) => a === b),
  ];
}

/** The link question as a matching screen: the fiche number, each candidate side by side with this fiche, the decisions. */
export function MatchCard({ proposal, active, offline, onDecide, onSetKey }: Props) {
  useLang();
  const [typing, setTyping] = useState(proposal.question === 'need_key');
  const [fiche, setFiche] = useState(proposal.fiche.value ?? '');
  const [facility, setFacility] = useState(proposal.facility ?? '');
  const buttons = linkButtons(proposal);
  const decisions = buttons.filter((b) => b.id === 'create_new' || b.id === 'not_sure');
  const submit = () => fiche.trim() && onSetKey({ fiche_number: fiche.trim(), ...(facility.trim() && { facility: facility.trim() }) });
  const showFiche = proposal.fiche.value && proposal.question !== 'confirm_fiche';

  return (
    <div className="bubble bot card" style={{ width: '100%', maxWidth: '100%' }}>
      <div className="card-head ok">
        <span>{t('match.title')}</span>
      </div>
      <div className="card-body">
        {proposal.question === 'need_key' && <p>{t('match.fiche_missing')}</p>}
        {proposal.question === 'confirm_fiche' && <p>{t('match.confirm_fiche', { fiche: proposal.fiche.value ?? '' })}</p>}
        {proposal.question === 'create' && <p>{t('match.create_question')}</p>}

        {showFiche && !typing && (
          <div className="card fiche-card">
            <span className="muted" style={{ fontSize: 13, fontWeight: 600 }}>{proposal.fiche.source === 'typed' ? t('match.fiche_typed') : t('match.fiche_read')}</span>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span className="big">{proposal.fiche.value}</span>
              {active && <button className="btn small" onClick={() => setTyping(true)} disabled={offline}>{t('match.retype')}</button>}
            </div>
            {proposal.facility && <span className="muted">{proposal.facility}</span>}
          </div>
        )}

        {active && typing && (
          <div style={{ display: 'grid', gap: 8 }}>
            <input className="field mono" value={fiche} onChange={(e) => setFiche(e.target.value)} placeholder={t('match.fiche_input')} aria-label={t('match.fiche_input')} autoFocus />
            <input className="field" value={facility} onChange={(e) => setFacility(e.target.value)} placeholder={t('match.facility_input')} aria-label={t('match.facility_input')} />
            <button className="btn go" onClick={submit} disabled={offline || !fiche.trim()}>{t('match.validate')}</button>
          </div>
        )}

        {proposal.candidates.map((c) => {
          const rows = compareRows(proposal, c);
          const compared = rows.filter((r) => r.mark !== 'none');
          const likely = c.kind === 'exact' && c.consistent;
          return (
            <section key={c.patient_id} className={`card ${likely ? 'go' : 'warn'}`}>
              <div className={`cand-head ${likely ? 'ok' : 'warn'}`}>
                <span>
                  <strong>{likely ? t('match.likely') : t('match.possible')}</strong>
                  <span className="mono">{c.patient_id} · {t('match.visits', { n: c.summary.visits })}</span>
                </span>
                <span className="pill" style={{ background: 'var(--surface)' }}>{t('match.score', { ok: compared.filter((r) => r.mark === 'same').length, n: compared.length })}</span>
              </div>
              <table className="cmp">
                <thead>
                  <tr><th /><th>{t('match.this_fiche')}</th><th>{t('match.record')}</th><th /></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className={r.code ? 'code' : undefined}>{r.mine}</td>
                      <td className={r.code ? 'code' : undefined}>{r.theirs}</td>
                      <td className={`mark ${r.mark}`} aria-label={r.mark}>{r.mark === 'same' ? '=' : r.mark === 'diff' ? '≠' : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {compared.length <= 1 && <p className="hint" style={{ padding: '0 16px' }}>{t('match.only_key')}</p>}
              {active && !typing && (
                <div style={{ padding: '12px 16px' }}>
                  <button className={`btn wide ${likely ? 'go' : ''}`} disabled={offline} onClick={() => onDecide({ kind: 'patient', patient_id: c.patient_id })}>
                    {likely && <Icon name="check" size={18} />}
                    {proposal.question === 'propose' ? t('match.pick_propose', { id: c.patient_id }) : t('match.pick', { id: c.patient_id })}
                  </button>
                </div>
              )}
            </section>
          );
        })}

        {active && !typing && proposal.question === 'confirm_fiche' && (
          <div className="grid2">
            <button className="btn go" disabled={offline} onClick={() => onSetKey({ fiche_number: proposal.fiche.value ?? undefined })}>{t('match.confirm_yes')}</button>
            <button className="btn" disabled={offline} onClick={() => setTyping(true)}>{t('match.confirm_no')}</button>
          </div>
        )}
        {active && !typing && decisions.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            {decisions.map((b) => (
              <button key={b.id} className={`btn ${b.id === 'not_sure' ? 'ghost' : proposal.question === 'create' ? 'go' : ''}`} disabled={offline} onClick={() => b.decision && onDecide(b.decision)}>
                {b.id === 'create_new' && <Icon name="plus" size={18} />}
                {b.label}
              </button>
            ))}
          </div>
        )}
        {active && offline && <p className="hint">{t('card.needs_server')}</p>}
      </div>
    </div>
  );
}
