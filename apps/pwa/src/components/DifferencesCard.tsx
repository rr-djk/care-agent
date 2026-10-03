import type { Difference } from '@care-agent/schema';

const show = (v: Difference['old_value']) => (v === null || v === '' || v === false ? '—' : v === true ? 'coché' : v);
const dateFr = (iso: string) => new Date(iso).toLocaleDateString('fr-FR');

interface Props {
  differences: Difference[];
  onChoose: (d: Difference, choice: 'old' | 'new') => void;
}

/** Re-digitization: a page type already in the record. One row per field that differs; both photos are kept either way. */
export function DifferencesCard({ differences, onChoose }: Props) {
  if (!differences.length) return null;
  return (
    <div className="differences">
      <p className="item-text">Cette page existe déjà dans le dossier. Pour chaque champ qui diffère, que faut-il garder ?</p>
      <p className="hint">Les deux photos restent enregistrées. Par défaut : le nouveau si la lecture est fiable, l'ancien sinon.</p>
      <ul>
        {differences.map((d) => (
          <li key={`${d.page_id}|${d.field_id}`}>
            <strong>{d.label_fr}</strong>
            <span>Ancien ({dateFr(d.old_date)}) : {show(d.old_value)} · Nouveau : {show(d.new_value)}</span>
            <div className="item-actions">
              <button className={d.choice === 'old' ? 'primary' : ''} aria-pressed={d.choice === 'old'} onClick={() => onChoose(d, 'old')}>Garder l'ancien</button>
              <button className={d.choice === 'new' ? 'primary' : ''} aria-pressed={d.choice === 'new'} onClick={() => onChoose(d, 'new')}>Prendre le nouveau</button>
            </div>
            {!d.decided && <span className="hint">choix par défaut</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
