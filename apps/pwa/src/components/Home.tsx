import { useState, type FormEvent } from 'react';
import type { ReviewQueue } from '@care-agent/schema';
import type { Auth } from '../api';
import { homeRows, type HomeRow } from '../home';
import { fmtWhen, t } from '../i18n';
import type { LocalPage, LocalSession } from '../offline/store';
import { Icon, Ticks } from './Icon';
import { TopBar } from './TopBar';

type Filter = 'all' | 'review' | 'unsent';

const avatarTone: Record<HomeRow['tone'], string> = { failed: 'bad', unsent: '', review: 'warn', reading: '', ready: 'ok', linked: 'ok', ok: 'ok', empty: '' };
const badgeTone: Partial<Record<HomeRow['tone'], string>> = { failed: 'bad', review: 'warn', unsent: '' };
const tickLabel = (n: HomeRow['ticks']) => (n === 1 ? t('sync.tick1') : n === 2 ? t('sync.tick2') : n === 3 ? t('sync.tick3') : undefined);

interface Props {
  auth: Auth;
  sessions: LocalSession[];
  local: LocalPage[];
  reviews: Record<string, ReviewQueue>;
  unsent?: number;
  onLock: () => void;
  onOpen: (sessionId: string) => void;
  onNew: (fiche?: string, facility?: string) => void;
}

/** Discussions: one row per fiche, like a chat list. Search by fiche or facility; filters; « Nouvelle fiche ». */
export function Home({ auth, sessions, local, reviews, unsent, onLock, onOpen, onNew }: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(false);
  const rows = homeRows(sessions, local, reviews, { query, filter });
  const all = homeRows(sessions, local, reviews);
  const count = (tone: (r: HomeRow) => boolean) => all.filter(tone).length;

  return (
    <section className="view" aria-label={t('tab.chats')}>
      <TopBar title={t('app.name')} subtitle={auth.userId} onLock={onLock} unsent={unsent}>
        <label className="search">
          <Icon name="search" size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('home.search')} aria-label={t('home.search')} />
        </label>
      </TopBar>
      <div className="filters">
        <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('home.filter.all')}</button>
        <button className="chip" aria-pressed={filter === 'review'} onClick={() => setFilter('review')}>
          {t('home.filter.review')} · {count((r) => r.tone === 'review')}
        </button>
        <button className="chip" aria-pressed={filter === 'unsent'} onClick={() => setFilter('unsent')}>
          {t('home.filter.unsent')} · {count((r) => r.tone === 'unsent' || r.tone === 'failed')}
        </button>
      </div>
      <div className="scroll">
        {!sessions.length && <p className="empty-state">{t('home.empty')}</p>}
        {sessions.length > 0 && !rows.length && <p className="empty-state">{t('home.no_match')}</p>}
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id}>
              <button onClick={() => onOpen(r.id)}>
                <span className={`avatar ${avatarTone[r.tone]}`}>{r.pages ? `P${r.pages}` : '—'}</span>
                <span className="line">
                  <span className="top">
                    <strong>{r.fiche ? t('patients.fiche', { fiche: r.fiche }) : t('home.untitled')}</strong>
                    <span className="when">{fmtWhen(r.when)}</span>
                  </span>
                  <span className="bottom">
                    <span className={`sub${r.tone === 'failed' ? ' bad' : ''}`}>
                      <Ticks n={r.ticks} label={tickLabel(r.ticks)} />
                      {t(r.status.key, r.status.params)}
                    </span>
                    {r.badge ? <span className={`badge ${badgeTone[r.tone] ?? ''}`}>{r.badge}</span> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div style={{ height: 88 }} />
      </div>
      <button className="fab" onClick={() => setCreating(true)}>
        <Icon name="camera" />
        {t('home.new')}
      </button>
      {creating && <NewFiche onCancel={() => setCreating(false)} onStart={(f, fac) => (setCreating(false), onNew(f, fac))} />}
    </section>
  );
}

/** « Nouvelle fiche »: the number is optional (read on the cover), the facility too. */
function NewFiche({ onCancel, onStart }: { onCancel: () => void; onStart: (fiche: string, facility: string) => void }) {
  const [fiche, setFiche] = useState('');
  const [facility, setFacility] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onStart(fiche.trim(), facility.trim());
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t('new.title')} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="sheet" onSubmit={submit}>
        <h2>{t('new.title')}</h2>
        <p className="muted" style={{ margin: 0 }}>{t('new.intro')}</p>
        <label className="stack">
          {t('new.fiche')}
          <input className="field mono" value={fiche} onChange={(e) => setFiche(e.target.value)} inputMode="numeric" placeholder="2026-711-003" />
        </label>
        <label className="stack">
          {t('new.facility')}
          <input className="field" value={facility} onChange={(e) => setFacility(e.target.value)} />
        </label>
        <div className="grid2">
          <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="btn go">{t('new.start')}</button>
        </div>
      </form>
    </div>
  );
}
