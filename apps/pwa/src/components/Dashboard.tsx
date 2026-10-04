import { useEffect, useState } from 'react';
import type { Aggregates } from '@care-agent/schema';
import { api, type Auth } from '../api';
import { barWidths, countText } from '../dashboard';
import { errorText } from '../state';
import { ApiError } from '../errors';

function Section({ data }: { data: Aggregates }) {
  return (
    <section className="dash-section">
      <h2>{data.source_fr}</h2>
      {data.blocks.map((block) => {
        const widths = barWidths(block);
        return (
          <div key={block.id} className="dash-block">
            <h3>{block.title_fr}</h3>
            <p className="hint">{block.n} lecture{block.n > 1 ? 's' : ''}{block.note_fr ? ` · ${block.note_fr}` : ''}</p>
            <ul className="bars">
              {block.bins.map((b, i) => (
                <li key={b.label_fr}>
                  <span className="bar-label">{b.label_fr}</span>
                  <span className="bar"><span style={{ width: `${widths[i]}%` }} /></span>
                  <span className="bar-count">{countText(b.count)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/** Supervisor's read-only dashboard: anonymized counts, small cells hidden (« < 5 »). No woman, no date, no page. */
export function Dashboard({ auth, onLogout }: { auth: Auth; onLogout: () => void }) {
  const [records, setRecords] = useState<Aggregates | null>(null);
  const [reference, setReference] = useState<Aggregates | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.getStats(), api.getReferenceStats()])
      .then(([r, ref]) => {
        setRecords(r);
        setReference(ref);
      })
      .catch((e) => setError(errorText(e instanceof ApiError ? e.code : 'network')));
  }, []);

  return (
    <div className="dashboard">
      <header>
        <span>Tableau de bord · {auth.userId}</span>
        <button onClick={onLogout}>Quitter</button>
      </header>
      <main>
        <p className="hint">Comptages anonymisés par tranche : aucune patiente, aucune date. Un effectif de 1 à 4 est masqué (« &lt; 5 »).</p>
        {error && <p className="error" role="alert">{error}</p>}
        {records && <Section data={records} />}
        {reference && <Section data={reference} />}
        {!records && !error && <p className="hint">Chargement…</p>}
      </main>
    </div>
  );
}
