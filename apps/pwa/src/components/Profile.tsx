import { useEffect, useState } from 'react';
import type { PatientRecord } from '@care-agent/schema';
import { api } from '../api';
import { ApiError } from '../errors';
import { errorText, fmtDate, t, useLang, type Key } from '../i18n';
import { indicators, latestMeasures, valuesByPage, type Indicator, type Measure } from '../profile';
import { fieldLabel, rowLabel } from '../schemas';
import { pageLabel } from '../state';
import { Icon } from './Icon';
import { TopBar } from './TopBar';

type Tab = 'summary' | 'visits' | 'values';

const show = (v: PatientRecord['values'][number]['value']) => (v === true ? t('summary.checked') : v === false ? t('summary.unchecked') : String(v));
const IND: Record<Indicator['key'], Key> = { term: 'profile.term', ddr: 'match.row.ddr', dpa: 'patients.dpa', blood: 'profile.blood', gp: 'profile.gp', age: 'profile.age' };
const MEASURE_UNIT: Partial<Record<Measure['key'], string>> = { ta: 'mmHg', weight: 'kg', hb: 'g/dL', temp: '°C' };

/** One patient's record (behind the PIN like everything else): key indicators, latest measurements, visits, all values. */
export function Profile({ id, onBack, onNewVisit }: { id: string; onBack: () => void; onNewVisit?: (fiche: string, facility: string) => void }) {
  useLang();
  const [record, setRecord] = useState<PatientRecord | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('summary');

  useEffect(() => {
    api.getPatient(id).then(setRecord, (e) => setError(errorText(e instanceof ApiError ? e.code : 'network')));
  }, [id]);

  const last = record?.visits.at(-1);
  return (
    <section className="view" aria-label={id}>
      <TopBar
        title={<span className="mono">{id}</span>}
        subtitle={record ? `${t('patients.fiche', { fiche: record.patient.fiche_number })}${record.patient.facility ? ` · ${record.patient.facility}` : ''}` : undefined}
        onBack={onBack}
        right={<span className="net"><Icon name="lock" size={14} />{t('profile.protected')}</span>}
      />
      <div className="scroll">
        {error && <p className="empty-state error" role="alert">{error}</p>}
        {!record && !error && <p className="empty-state">{t('common.loading')}</p>}
        {record && (
          <>
            <div className="seg" style={{ margin: '12px 12px 0' }} role="tablist">
              {(['summary', 'visits', 'values'] as const).map((x) => (
                <button key={x} role="tab" aria-selected={tab === x} aria-pressed={tab === x} onClick={() => setTab(x)}>{t(`profile.tab.${x}`)}</button>
              ))}
            </div>
            <div className="stack-pad">
              {last && <p className="muted" style={{ margin: 0 }}>{t('profile.subtitle', { n: record.visits.length, date: fmtDate(last.date) })}</p>}
              {tab === 'summary' && <Overview record={record} />}
              {tab === 'visits' && <Visits record={record} />}
              {tab === 'values' && <AllValues record={record} />}
              {onNewVisit && (
                <button className="btn go wide" onClick={() => onNewVisit(record.patient.fiche_number, record.patient.facility)}>
                  <Icon name="camera" />
                  {t('profile.new_visit')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Overview({ record }: { record: PatientRecord }) {
  const inds = indicators(record);
  const measures = latestMeasures(record);
  const history = record.values.filter((v) => v.page_type === 2 && !['p02.age', 'p02.gestation', 'p02.parite'].includes(v.field_id) && v.value !== false);
  return (
    <>
      {inds.length > 0 && (
        <section style={{ display: 'grid', gap: 8 }}>
          <h2 className="section-h">{t('profile.pregnancy')}</h2>
          <div className="ind-grid">
            {inds.map((i) => (
              <div key={i.key} className="ind">
                <span className="k">{t(IND[i.key])}</span>
                <span className="v">{i.key === 'term' ? t('profile.term_value', { sa: i.value }) : i.key === 'age' ? t('match.years', { n: i.value }) : i.value}</span>
                <small>{i.source ? t('profile.source', { type: i.source.page_type ?? '', date: fmtDate(i.source.date) }) : t('profile.term_source')}</small>
              </div>
            ))}
          </div>
        </section>
      )}
      <section style={{ display: 'grid', gap: 8 }}>
        <h2 className="section-h">{t('profile.measures')}</h2>
        {measures.length ? (
          <div className="card measures">
            {measures.map((m) => (
              <div key={m.key}>
                <span className="k" style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{rowLabel(m.field_id)}</span>
                <span className="v">{m.value}{MEASURE_UNIT[m.key] && !m.value.includes(MEASURE_UNIT[m.key]!) ? ` ${MEASURE_UNIT[m.key]}` : ''}</span>
                <span className="src">{fmtDate(m.date)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>{t('profile.no_measure')}</p>
        )}
      </section>
      {history.length > 0 && (
        <section style={{ display: 'grid', gap: 8 }}>
          <h2 className="section-h">{t('profile.history')}</h2>
          <ul className="card values-list">
            {history.map((v) => (
              <li key={v.field_id}>
                <span>{fieldLabel(v.field_id)}</span>
                <strong>{show(v.value)}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Visits({ record }: { record: PatientRecord }) {
  return (
    <div className="card timeline">
      {[...record.visits].reverse().map((v, i) => (
        <div key={v.session_id}>
          <span className={`dot${i ? ' old' : ''}`} />
          <span className="line">
            <strong>{t('profile.visit', { n: record.visits.length - i, date: fmtDate(v.date) })}</strong>
            <span className="muted" style={{ fontSize: 13 }}>{v.pages.map((p) => `${p.page_type} · ${pageLabel(p.page_type)}`).join(', ')}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function AllValues({ record }: { record: PatientRecord }) {
  const groups = valuesByPage(record);
  if (!groups.length) return <p className="muted">{t('profile.nothing')}</p>;
  return (
    <>
      {groups.map(([type, values]) => (
        <details key={type} className="card">
          <summary>
            <span>{type} · {pageLabel(type)}</span>
            <span className="count">{t('profile.values_count', { n: values.length })}</span>
          </summary>
          <ul className="values-list">
            {values.map((v) => (
              <li key={v.field_id}>
                <span>
                  {fieldLabel(v.field_id)}
                  <span className="src" style={{ display: 'block' }}>{fmtDate(v.source_date)}</span>
                </span>
                <strong>{show(v.value)}</strong>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}
