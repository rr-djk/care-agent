import { useState, type FormEvent } from 'react';
import { PAGE_TYPES } from '../state';

interface Props {
  hasSession: boolean;
  onNewSession: (fiche: string, facility: string) => void;
  onCapture: (file: File, pageType: number) => void;
}

export function Composer({ hasSession, onNewSession, onCapture }: Props) {
  const [form, setForm] = useState(false);
  const [fiche, setFiche] = useState('');
  const [facility, setFacility] = useState('');
  const [pageType, setPageType] = useState(3);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onNewSession(fiche.trim(), facility.trim());
    setForm(false);
  };

  return (
    <footer className="composer">
      {form && (
        <form onSubmit={submit}>
          <input value={fiche} onChange={(e) => setFiche(e.target.value)} placeholder="Numéro de fiche" aria-label="Numéro de fiche" />
          <input value={facility} onChange={(e) => setFacility(e.target.value)} placeholder="Établissement" aria-label="Établissement" />
          <button className="primary">Démarrer</button>
        </form>
      )}
      {hasSession && (
        <select value={pageType} onChange={(e) => setPageType(Number(e.target.value))} aria-label="Type de page">
          {PAGE_TYPES.map((p) => (
            <option key={p.type} value={p.type}>
              {p.type} · {p.label}
            </option>
          ))}
        </select>
      )}
      <div className="actions">
        <button onClick={() => setForm(!form)}>Nouvelle session</button>
        {hasSession && (
          <label className="button primary">
            Photographier une page
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ''; // allow retaking the same file
                if (file) onCapture(file, pageType);
              }}
            />
          </label>
        )}
      </div>
    </footer>
  );
}
