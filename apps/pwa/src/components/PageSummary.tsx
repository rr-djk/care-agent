import { useState } from 'react';
import { fieldDef, fieldLabel } from '../schemas';
import { countByStatus, groupFields, pageLabel, STATUS_FR, toReview, type PageView } from '../state';
import type { ExtractedField } from '@care-agent/schema';

type Value = string | boolean | null;

const showValue = (v: Value) => (v === null || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'coché' : 'non coché') : v);

interface RowProps {
  field: ExtractedField;
  editable: boolean;
  onPatch: (fieldId: string, value: Value) => Promise<void>;
}

function FieldRow({ field, editable, onPatch }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isCheckbox = fieldDef(field.field_id)?.type === 'checkbox';

  const save = async () => {
    await onPatch(field.field_id, isCheckbox ? draft === 'true' : draft);
    setEditing(false);
  };

  return (
    <li className={`field ${field.status}`}>
      <div className="field-head">
        <span className="label">{fieldLabel(field.field_id)}</span>
        <span className="value">{showValue(field.value)}</span>
        {field.status !== 'KNOWN' && <span className="reason">{STATUS_FR[field.status]}</span>}
      </div>
      {editable &&
        (editing ? (
          <div className="field-edit">
            {isCheckbox ? (
              <select value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Nouvelle valeur">
                <option value="true">coché</option>
                <option value="false">non coché</option>
              </select>
            ) : (
              <input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Nouvelle valeur" autoFocus />
            )}
            <button className="primary" onClick={save}>Enregistrer</button>
            <button onClick={() => setEditing(false)}>Annuler</button>
          </div>
        ) : (
          <div className="field-actions">
            <button disabled title="Bientôt">Confirmer</button>
            <button
              onClick={() => {
                setDraft(isCheckbox ? String(field.value === true) : typeof field.value === 'string' ? field.value : '');
                setEditing(true);
              }}
            >
              Corriger
            </button>
            <button disabled title="Bientôt">Reprendre la photo</button>
          </div>
        ))}
    </li>
  );
}

interface Props {
  page: PageView;
  onPatch: (fieldId: string, value: Value) => Promise<void>;
  onConfirm: () => void;
}

export function PageSummary({ page, onPatch, onConfirm }: Props) {
  const fields = page.fields ?? [];
  const { flagged, known } = groupFields(fields);
  const counts = Object.entries(countByStatus(fields)) as [keyof typeof STATUS_FR, number][];
  const pending = toReview(page).length;
  const editable = !page.validated;

  return (
    <div className="summary">
      <strong>
        Page {page.pageType ?? ''} · {pageLabel(page.pageType)}
      </strong>
      <p className="counts">{counts.map(([status, n]) => `${n} ${STATUS_FR[status]}`).join(' · ')}</p>
      {pending > 0 && <p className="pending">{pending} champ{pending > 1 ? 's' : ''} à contrôler</p>}
      <ul>
        {flagged.map((f) => (
          <FieldRow key={f.field_id} field={f} editable={editable} onPatch={onPatch} />
        ))}
      </ul>
      {known.length > 0 && (
        <details>
          <summary>{known.length} champ{known.length > 1 ? 's' : ''} lu{known.length > 1 ? 's' : ''}</summary>
          <ul>
            {known.map((f) => (
              <FieldRow key={f.field_id} field={f} editable={editable} onPatch={onPatch} />
            ))}
          </ul>
        </details>
      )}
      {editable && <button className="primary" onClick={onConfirm}>Confirmer la page</button>}
    </div>
  );
}
