import { useEffect, useState } from 'react';
import type { PatientSummary } from '@care-agent/schema';
import { api } from '../api';
import { ApiError } from '../errors';
import { errorText, fmtDate, t, useLang } from '../i18n';
import { isOffline } from '../offline/network';
import { matchesSearch, weeksSince } from '../profile';
import { Icon } from './Icon';
import { TopBar } from './TopBar';

type Filter = 'all' | 'pregnancy' | 'postpartum' | 'duplicate';

interface Props {
  supervisor: boolean;
  unsent?: number;
  onLock: () => void;
  onOpen: (patientId: string) => void;
}

/** The patient dashboard: the midwife's records (all of them, read-only, for the supervisor). Records live on the server. */
export function Patients({ supervisor, unsent, onLock, onOpen }: Props) {
  useLang();
  const [list, setList] = useState<PatientSummary[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const offline = isOffline();

  useEffect(() => {
    if (offline) return;
    api.listPatients().then(setList, (e) => setError(errorText(e instanceof ApiError ? e.code : 'network')));
  }, [offline]);

  const shown = (list ?? [])
    .filter((p) => matchesSearch(p, query))
    .filter((p) => (filter === 'all' ? true : filter === 'duplicate' ? p.duplicate : p.stage === filter));
  const stage = (p: PatientSummary) => {
    if (p.duplicate) return { cls: 'bad', text: t('patients.duplicate') };
    if (p.stage === 'pregnancy') {
      const sa = weeksSince(p.ddr);
      return { cls: 'ok', text: sa === null ? t('patients.stage.pregnancy') : t('patients.stage.pregnancy_sa', { sa }) };
    }
    return p.stage === 'postpartum' ? { cls: 'info', text: t('patients.stage.postpartum') } : { cls: '', text: t('patients.stage.unknown') };
  };

  return (
    <section className="view" aria-label={t('tab.patients')}>
      <TopBar title={supervisor ? t('patients.title_all') : t('patients.title')} onLock={onLock} unsent={unsent}>
        <label className="search">
          <Icon name="search" size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('patients.search')} aria-label={t('patients.search')} />
        </label>
      </TopBar>
      <div className="scroll">
        {offline && <p className="empty-state">{t('patients.offline')}</p>}
        {!offline && error && <p className="empty-state error" role="alert">{error}</p>}
        {!offline && !error && !list && <p className="empty-state">{t('common.loading')}</p>}
        {list && (
          <>
            <div className="stats-row">
              <div className="stat"><b>{list.length}</b><span>{t('patients.followed')}</span></div>
              <div className="stat"><b style={{ color: 'var(--bad-ink)' }}>{list.filter((p) => p.duplicate).length}</b><span>{t('patients.duplicates')}</span></div>
            </div>
            <div className="filters" style={{ background: 'transparent', border: 0 }}>
              {(['all', 'pregnancy', 'postpartum', 'duplicate'] as const).map((f) => (
                <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`patients.filter.${f}`)}</button>
              ))}
            </div>
            {!list.length && <p className="empty-state">{t('patients.empty')}</p>}
            <div className="stack-pad" style={{ paddingTop: 0 }}>
              {shown.map((p) => {
                const st = stage(p);
                return (
                  <button key={p.id} className={`pt ${p.duplicate ? 'bad' : ''}`} onClick={() => onOpen(p.id)}>
                    <span className="r">
                      <strong className="mono" style={{ fontSize: 16 }}>{p.id}</strong>
                      <span className={`pill ${st.cls}`}>{st.text}</span>
                    </span>
                    <span className="r">
                      <span className="mono">{t('patients.fiche', { fiche: p.fiche_number })}</span>
                      <span>{p.facility}</span>
                    </span>
                    <span className="r" style={{ justifyContent: 'flex-start', gap: 16, color: 'var(--ink-2)' }}>
                      {p.dpa && <span>{t('patients.dpa')} <strong className="mono">{p.dpa}</strong></span>}
                      {p.last_visit && <span>{t('patients.last_visit')} <strong>{fmtDate(p.last_visit)}</strong></span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
