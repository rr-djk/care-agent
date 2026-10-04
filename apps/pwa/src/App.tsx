import { useEffect, useState } from 'react';
import { getAuth, setAuth, type Auth } from './api';
import { Login } from './components/Login';
import { Shell } from './components/Shell';
import { Unlock } from './components/Unlock';
import { t, useLang } from './i18n';
import { isOffline, subscribeNet } from './offline/network';
import { listProfiles, lock, logout, wipe } from './offline/store';

type Phase = { name: 'loading' } | { name: 'unlock'; userId: string } | { name: 'login' };

export function App() {
  const lang = useLang();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [auth, setCurrent] = useState<Auth | null>(getAuth());
  const [, redraw] = useState(0);
  useEffect(() => subscribeNet(() => redraw((n) => n + 1)), []);
  useEffect(() => void (document.documentElement.lang = lang), [lang]);

  // The token only lives in memory: after a reload a device with a profile unlocks with the PIN (online or not).
  useEffect(() => {
    listProfiles()
      .then((profiles) => {
        const last = profiles.filter((p) => p.secret).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        setPhase(last ? { name: 'unlock', userId: last.userId } : { name: 'login' });
      })
      .catch(() => setPhase({ name: 'login' }));
  }, []);

  const update = (next: Auth | null) => {
    setAuth(next);
    setCurrent(next);
  };
  // Lock (button or 5 minutes without activity): the key leaves memory, the encrypted token stays; the PIN reopens.
  const lockNow = () => {
    if (!auth) return;
    lock();
    const userId = auth.userId;
    update(null);
    setPhase({ name: 'unlock', userId });
  };
  const leave = async () => {
    if (auth) await logout(auth.userId); // forgets the key and deletes the stored token
    update(null);
    setPhase({ name: 'login' });
  };
  const erase = async () => {
    await wipe();
    update(null);
    setPhase({ name: 'login' });
  };

  if (auth) return <Shell auth={auth} onLock={lockNow} onLogout={leave} onWipe={erase} />;
  if (phase.name === 'loading') return null;
  if (phase.name === 'unlock') {
    return <Unlock userId={phase.userId} online={!isOffline()} onUnlock={update} onOther={() => setPhase({ name: 'login' })} onWipe={() => window.confirm(t('unlock.wipe_confirm')) && void erase()} />;
  }
  return <Login onLogin={update} />;
}
