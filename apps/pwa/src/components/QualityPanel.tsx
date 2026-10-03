import { useEffect, useState } from 'react';
import type { QualityResult } from '@care-agent/schema';

interface Props {
  file: File;
  result: QualityResult;
  onRetake: () => void;
  onKeep: () => void;
}

/** Post-capture verdict. WARNING: Reprendre / Garder quand même. REJECT: Reprendre only (nothing to read). */
export function QualityPanel({ file, result, onRetake, onKeep }: Props) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const reject = result.outcome === 'REJECT';
  return (
    <div className="overlay" role="dialog" aria-label="Qualité de la photo">
      <div className={`quality ${result.outcome.toLowerCase()}`}>
        <h2>{reject ? 'Photo inutilisable' : 'Photo à vérifier'}</h2>
        {url && <img src={url} alt="Photo prise" />}
        <ul>
          {result.messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        {!reject && <p className="note">Si vous la gardez, les champs lus sur cette page seront à vérifier un par un.</p>}
        <div className="actions">
          <button className="primary" onClick={onRetake}>Reprendre</button>
          {!reject && <button onClick={onKeep}>Garder quand même</button>}
        </div>
      </div>
    </div>
  );
}
