import { useEffect, useState } from 'react';
import type { PatientRecord } from '@care-agent/schema';
import { api } from '../api';
import { ApiError } from '../errors';
import { errorText, keyValuesByVisit, pageLabel } from '../state';

const dateFr = (iso: string) => new Date(iso).toLocaleDateString('fr-FR');
const shown = (v: PatientRecord['values'][number]['value']) => (v === true ? 'coché' : String(v));

/** Simple longitudinal record: visits in date order with their key values, then every retained value with its source page. */
export function RecordView({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const [record, setRecord] = useState<PatientRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getPatient(patientId).then(setRecord, (e) => setError(errorText(e instanceof ApiError ? e.code : 'network')));
  }, [patientId]);

  const byType = new Map<number, PatientRecord['values']>();
  for (const v of record?.values ?? []) byType.set(v.page_type ?? 0, [...(byType.get(v.page_type ?? 0) ?? []), v]);
  const keys = record ? keyValuesByVisit(record) : [];

  return (
    <div className="overlay record" role="dialog" aria-label={`Dossier ${patientId}`}>
      <div className="quality">
        <button className="close" onClick={onClose}>Fermer</button>
        <h2>Dossier {patientId}</h2>
        {error && <p>{error}</p>}
        {!record && !error && <p>Chargement…</p>}
        {record && (
          <>
            <p className="hint">Fiche {record.patient.fiche_number} · {record.patient.facility} · {record.visits.length} visite{record.visits.length > 1 ? 's' : ''}</p>
            <ol className="visits">
              {record.visits.map((v, i) => (
                <li key={v.session_id}>
                  <strong>Visite {i + 1} · {dateFr(v.date)}</strong>
                  <span>{v.pages.map((p) => pageLabel(p.page_type)).join(', ')}</span>
                  <span>{keys[i].length ? keys[i].map((k) => `${k.label_fr} : ${shown(k.value)}`).join(' · ') : 'Aucune valeur clé retenue'}</span>
                </li>
              ))}
            </ol>
            {[...byType].map(([type, values]) => (
              <details key={type}>
                <summary>{pageLabel(type)} : {values.length} valeur{values.length > 1 ? 's' : ''} retenue{values.length > 1 ? 's' : ''}</summary>
                <ul className="values">
                  {values.map((v) => (
                    <li key={v.field_id}>
                      <span>{v.label_fr}</span> <strong>{shown(v.value)}</strong> <em>(source : {dateFr(v.source_date)})</em>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
