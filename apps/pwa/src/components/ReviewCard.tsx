import { useState } from 'react';
import type { ReviewItem } from '@care-agent/schema';
import { fieldDef } from '../schemas';

type Value = string | boolean | null;

const showValue = (v: Value) => (v === null || v === '' ? null : typeof v === 'boolean' ? (v ? 'coché' : 'non coché') : v);
const isoToFr = (iso: string) => iso.split('-').reverse().join('/'); // <input type="date"> gives yyyy-mm-dd

interface Props {
  item: ReviewItem;
  progress: { done: number; total: number };
  active: boolean; // only the current question has buttons
  onConfirm: () => void;
  onCorrect: (value: Value) => void;
  onRetake: () => void;
  onLeave: () => void;
}

/** One review question: the agent's doubt in French, the value it read, and Confirmer / Corriger / Reprendre / Laisser illisible. */
export function ReviewCard({ item, progress, active, onConfirm, onCorrect, onRetake, onLeave }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const def = fieldDef(item.field_id);
  const value = showValue(item.value);
  const chips = def?.type === 'enum' ? (def.allowed_values ?? []).map((v) => [v, v] as const) : def?.type === 'checkbox' ? ([['coché', true], ['non coché', false]] as const) : null;
  const has = (a: ReviewItem['actions'][number]) => item.actions.includes(a);

  const save = () => {
    if (!draft.trim()) return;
    onCorrect(def?.type === 'date' && draft.includes('-') ? isoToFr(draft) : draft.trim());
    setEditing(false);
    setDraft('');
  };

  return (
    <div className={`item ${item.kind}`}>
      {active && <p className="progress">{progress.done}/{progress.total} champs vérifiés</p>}
      <p className="item-text">{item.text_fr}</p>
      {value && <p className="read-value">Valeur lue : <strong>{value}</strong></p>}
      {active &&
        (editing ? (
          <div className="item-edit">
            {chips ? (
              <div className="chips">
                {chips.map(([label, v]) => (
                  <button key={label} className="chip" onClick={() => onCorrect(v)}>{label}</button>
                ))}
              </div>
            ) : (
              <input
                type={def?.type === 'date' ? 'date' : 'text'}
                inputMode={def?.type === 'number' ? 'decimal' : undefined}
                placeholder={def?.validators.includes('bp') ? '120/80' : def?.unit ? `Valeur en ${def.unit}` : 'Nouvelle valeur'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && save()}
                aria-label="Nouvelle valeur"
                autoFocus
              />
            )}
            <div className="item-actions">
              {!chips && <button className="primary" onClick={save}>Enregistrer</button>}
              <button onClick={() => setEditing(false)}>Annuler</button>
            </div>
          </div>
        ) : (
          <div className="item-actions">
            {has('confirm') && <button className="primary" onClick={onConfirm}>Confirmer</button>}
            {has('correct') && (
              <button
                onClick={() => {
                  setDraft(typeof item.value === 'string' && def?.type !== 'date' && !chips ? item.value : '');
                  setEditing(true);
                }}
              >
                Corriger
              </button>
            )}
            {has('retake') && <button onClick={onRetake}>Reprendre la photo</button>}
            {has('leave_illegible') && <button onClick={onLeave}>Laisser illisible</button>}
          </div>
        ))}
    </div>
  );
}
