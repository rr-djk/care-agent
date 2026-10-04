import { useEffect, useState } from 'react';
import type { Aggregates, StatBlock } from '@care-agent/schema';
import { api } from '../api';
import { barWidths, countText, sourceTitle, statText } from '../dashboard';
import { ApiError } from '../errors';
import { errorText, t, useLang } from '../i18n';
import { TopBar } from './TopBar';

function Block({ block }: { block: StatBlock }) {
  const widths = barWidths(block);
  return (
    <div>
      <div className="block-head">
        <h3>{statText(block.title_fr)}</h3>
        <p>{t('stats.readings', { n: block.n })}{block.note_fr ? ` · ${statText(block.note_fr)}` : ''}</p>
      </div>
      <ul className="bars">
        {block.bins.map((b, i) => (
          <li key={b.label_fr}>
            <span>{statText(b.label_fr)}</span>
            <span className="bar" aria-hidden="true"><span style={{ width: `${widths[i]}%` }} /></span>
            <span className="n">{countText(b.count)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Source({ data }: { data: Aggregates }) {
  return (
    <section className="card">
      <div className="card-title">{sourceTitle(data)}</div>
      {data.blocks.map((b) => <Block key={b.id} block={b} />)}
    </section>
  );
}

/** Supervisor's dashboard: anonymized counts per band, small cells hidden (« < 5 »). No woman, no date, no page. */
export function Stats({ onLock }: { onLock: () => void }) {
  useLang();
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
    <section className="view" aria-label={t('tab.stats')}>
      <TopBar title={t('stats.title')} subtitle={t('stats.supervisor')} onLock={onLock} />
      <div className="scroll">
        <div className="stack-pad">
          <p className="muted" style={{ margin: 0 }}>{t('stats.intro')}</p>
          {error && <p className="error" role="alert">{error}</p>}
          {!records && !error && <p className="muted">{t('common.loading')}</p>}
          {records && <Source data={records} />}
          {reference && <Source data={reference} />}
        </div>
      </div>
    </section>
  );
}
