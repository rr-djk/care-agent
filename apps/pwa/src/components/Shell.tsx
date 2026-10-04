import { useCallback, useEffect, useState } from 'react';
import type { ReviewQueue, Session } from '@care-agent/schema';
import { api, type Auth } from '../api';
import { t, useLang } from '../i18n';
import { isOffline, subscribeNet } from '../offline/network';
import * as store from '../offline/store';
import { sync } from '../offline/sync';
import { Chat } from './Chat';
import { Home } from './Home';
import { Icon, type IconName } from './Icon';
import { Patients } from './Patients';
import { Profile } from './Profile';
import { Stats } from './Stats';
import { SyncView } from './SyncView';

type Tab = 'chats' | 'patients' | 'sync' | 'stats';

const IDLE_LOCK_MS = 5 * 60_000;

/** What the open fiche needs to know at start: a new one says « Fiche ouverte », a resumed one reloads its queue. */
type OpenFiche = { id: string; fresh: boolean };

/**
 * The app after unlock. A midwife: Discussions (one row per fiche), Patientes (her records), Synchro (the phone's queue).
 * The supervisor: Statistiques (anonymized aggregates) and Patientes, read-only. The sync engine runs for the whole
 * shell, so pages keep going whatever the open tab; the app locks itself after 5 minutes without activity.
 */
export function Shell({ auth, onLock, onLogout, onWipe }: { auth: Auth; onLock: () => void; onLogout: () => void; onWipe: () => void }) {
  useLang();
  const supervisor = auth.role === 'supervisor';
  const [tab, setTab] = useState<Tab>(supervisor ? 'stats' : 'chats');
  const [fiche, setFiche] = useState<OpenFiche | null>(null);
  const [patient, setPatient] = useState<string | null>(null);
  const [sessions, setSessions] = useState<store.LocalSession[]>([]);
  const [local, setLocal] = useState<store.LocalPage[]>([]);
  const [reviews, setReviews] = useState<Record<string, ReviewQueue>>({});
  const [, redraw] = useState(0);

  const reload = useCallback(async () => {
    if (supervisor) return;
    const [s, p] = await Promise.all([store.listSessions(auth.userId), store.listPages(auth.userId)]);
    setSessions(s);
    setLocal(p);
    if (isOffline()) return;
    // the review state of each fiche the server knows (best effort: a fiche with no page sent yet is unknown there)
    const entries = await Promise.all(s.filter((x) => x.synced).map(async (x) => [x.id, await api.getReview(x.id).catch(() => null)] as const));
    setReviews(Object.fromEntries(entries.filter((e): e is readonly [string, ReviewQueue] => e[1] !== null)));
  }, [auth.userId, supervisor]);

  // sync engine + connectivity
  useEffect(() => {
    const offNet = subscribeNet(() => redraw((n) => n + 1));
    if (supervisor) return offNet;
    const stop = sync.start(auth.userId);
    const offSync = sync.subscribe((e) => {
      if (e.type === 'auth_expired') onLogout();
      void reload();
    });
    void reload();
    return () => (stop(), offNet(), offSync());
  }, []);

  // auto-lock after inactivity
  useEffect(() => {
    let timer = setTimeout(onLock, IDLE_LOCK_MS);
    const poke = () => {
      clearTimeout(timer);
      timer = setTimeout(onLock, IDLE_LOCK_MS);
    };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, poke, { passive: true, capture: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, poke, { capture: true });
    };
  }, [onLock]);

  const startFiche = async (fiche_number?: string, facility?: string) => {
    // created on the phone (works offline); the sync engine creates it on the server with its first page
    const session: Session = { id: crypto.randomUUID(), midwife_id: auth.userId, fiche_number: fiche_number || undefined, facility: facility || undefined, started_at: new Date().toISOString(), page_ids: [] };
    await store.createLocalSession(auth.userId, session);
    await reload();
    setPatient(null);
    setFiche({ id: session.id, fresh: true });
  };

  const unsent = local.filter((p) => p.state !== 'UPLOADED').length;
  const failed = local.filter((p) => p.state === 'SYNC_FAILED').length;
  const common = { onLock, unsent: supervisor ? undefined : unsent };

  if (patient) {
    return (
      <div className="app">
        <Profile id={patient} onBack={() => setPatient(null)} onNewVisit={supervisor ? undefined : (fiche_number, facility) => void startFiche(fiche_number, facility)} />
      </div>
    );
  }
  if (fiche) {
    return (
      <div className="app">
        <Chat
          auth={auth}
          sessionId={fiche.id}
          fresh={fiche.fresh}
          local={local}
          onBack={() => (setFiche(null), void reload())}
          onLocalChange={reload}
          onLogout={onLogout}
          onOpenPatient={setPatient}
        />
      </div>
    );
  }

  const tabs: { id: Tab; icon: IconName; label: string; badge?: number }[] = supervisor
    ? [
        { id: 'stats', icon: 'stats', label: t('tab.stats') },
        { id: 'patients', icon: 'records', label: t('tab.patients') },
      ]
    : [
        { id: 'chats', icon: 'chat', label: t('tab.chats') },
        { id: 'patients', icon: 'records', label: t('tab.patients') },
        { id: 'sync', icon: 'sync', label: t('tab.sync'), badge: failed || undefined },
      ];

  return (
    <div className="app">
      {tab === 'chats' && <Home {...common} auth={auth} sessions={sessions} local={local} reviews={reviews} onOpen={(id) => setFiche({ id, fresh: false })} onNew={startFiche} />}
      {tab === 'patients' && <Patients {...common} supervisor={supervisor} onOpen={setPatient} />}
      {tab === 'sync' && <SyncView {...common} local={local} sessions={sessions} onRetry={(id) => void sync.retry(id).then(reload)} onLogout={onLogout} onWipe={onWipe} />}
      {tab === 'stats' && <Stats onLock={onLock} />}
      <nav className="tabs" aria-label="Navigation">
        {tabs.map((x) => (
          <button key={x.id} aria-current={tab === x.id ? 'page' : undefined} onClick={() => setTab(x.id)}>
            <Icon name={x.icon} size={24} />
            {x.label}
            {x.badge ? <span className="badge bad">{x.badge}</span> : null}
          </button>
        ))}
      </nav>
    </div>
  );
}
