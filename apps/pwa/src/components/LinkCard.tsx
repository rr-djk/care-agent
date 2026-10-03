import { useState } from 'react';
import type { LinkDecision, LinkProposal } from '@care-agent/schema';
import { linkButtons } from '../state';

interface Props {
  proposal: LinkProposal;
  active: boolean; // only the current question has buttons
  offline: boolean; // the question needs the server: it waits
  onDecide: (decision: LinkDecision) => void;
  onSetKey: (key: { fiche_number?: string; facility?: string }) => void;
}

const dateFr = (iso: string) => new Date(iso).toLocaleDateString('fr-FR');

/**
 * The link question: the fiche number read (or typed), the candidate cards (no personal identifier: fiche, facility, age,
 * LMP, visits) and the buttons of `linkButtons`. A doubtful or missing key is typed or confirmed here first.
 */
export function LinkCard({ proposal, active, offline, onDecide, onSetKey }: Props) {
  const [typing, setTyping] = useState(proposal.question === 'need_key');
  const [fiche, setFiche] = useState(proposal.fiche.value ?? '');
  const [facility, setFacility] = useState(proposal.facility ?? '');
  const buttons = linkButtons(proposal);
  const submit = () => fiche.trim() && onSetKey({ fiche_number: fiche.trim(), ...(facility.trim() && { facility: facility.trim() }) });

  return (
    <div className="link-card">
      <p className="item-text">{proposal.text_fr}</p>
      {proposal.fiche.value && proposal.question !== 'confirm_fiche' && (
        <p className="hint">N° de la fiche : {proposal.fiche.value} · {proposal.facility ?? 'établissement inconnu'}</p>
      )}
      {proposal.candidates.length > 0 && (
        <ul className="candidates">
          {proposal.candidates.map((c, i) => (
            <li key={c.patient_id} className={c.consistent ? '' : 'inconsistent'}>
              <strong>Patient {i + 1} · {c.patient_id}</strong>
              <span>
                Fiche {c.summary.fiche_number} · {c.summary.facility}
                {c.summary.age !== undefined && ` · ${c.summary.age} ans`}
                {c.summary.ddr && ` · DDR ${c.summary.ddr}`} · {c.summary.visits} visite{c.summary.visits > 1 ? 's' : ''}
                {c.summary.last_visit && ` · dernière le ${dateFr(c.summary.last_visit)}`}
              </span>
              <ul>{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </li>
          ))}
        </ul>
      )}
      {active && typing && (
        <div className="item-edit">
          <input value={fiche} onChange={(e) => setFiche(e.target.value)} placeholder="N° de la fiche" aria-label="N° de la fiche" />
          {proposal.question === 'need_key' && <input value={facility} onChange={(e) => setFacility(e.target.value)} placeholder="Établissement" aria-label="Établissement" />}
          <div className="item-actions">
            <button className="primary" onClick={submit} disabled={offline}>Valider</button>
          </div>
        </div>
      )}
      {active && !typing && (
        <div className="link-buttons">
          {buttons.map((b, i) => (
            <button
              key={`${b.id}-${i}`}
              className={b.id === 'not_sure' || b.id === 'retype' ? '' : 'primary'}
              disabled={offline}
              onClick={() => (b.decision ? onDecide(b.decision) : b.id === 'retype' ? setTyping(true) : onSetKey({ fiche_number: proposal.fiche.value ?? undefined }))}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
      {active && offline && <p className="hint">Hors ligne : la question attend la connexion au serveur.</p>}
    </div>
  );
}
