import { useEffect, useState } from 'react';
import type { QualityResult } from '@care-agent/schema';
import { qualityText, t, useLang } from '../i18n';

interface Props {
  file: File;
  result: QualityResult;
  onRetake: () => void;
  onKeep: () => void;
}

/** Post-capture verdict. WARNING: Reprendre / Garder quand même. REJECT: Reprendre only (nothing to read). */
export function QualityPanel({ file, result, onRetake, onKeep }: Props) {
  useLang();
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const reject = result.outcome === 'REJECT';
  return (
    <div className="overlay center" role="dialog" aria-modal="true" aria-label={t('quality.title')}>
      <div className={`panel ${result.outcome.toLowerCase()}`}>
        <h2>{reject ? t('quality.reject') : t('quality.warning')}</h2>
        {url && <img src={url} alt={t('quality.photo')} />}
        <ul>
          {result.messages.map((m) => (
            <li key={m}>{qualityText(m)}</li>
          ))}
        </ul>
        {!reject && <p className="hint" style={{ margin: 0 }}>{t('quality.note')}</p>}
        <div className="grid2">
          <button className="btn go" onClick={onRetake}>{t('quality.retake')}</button>
          {!reject && <button className="btn" onClick={onKeep}>{t('quality.keep')}</button>}
        </div>
      </div>
    </div>
  );
}
