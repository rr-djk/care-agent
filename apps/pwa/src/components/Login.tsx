import { useState, type FormEvent } from 'react';
import { api, type Auth } from '../api';
import { ApiError, DeviceError } from '../errors';
import { errorText, t, useLang } from '../i18n';
import { enroll } from '../offline/store';
import { Icon } from './Icon';
import { LangToggle } from './LangToggle';

/** First sign-in on a device (online): the PIN then also derives the key that unlocks the device offline. */
export function Login({ onLogin }: { onLogin: (auth: Auth) => void }) {
  useLang();
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const auth = await api.login(userId.trim(), pin);
      await enroll(auth, pin); // key from the PIN + encrypted token: the same PIN unlocks the device offline later
      onLogin(auth);
    } catch (err) {
      setError(errorText(err instanceof ApiError || err instanceof DeviceError ? err.code : 'network'));
      setBusy(false);
    }
  };

  return (
    <main className="gate">
      <div className="top"><LangToggle /></div>
      <div className="hello">
        <span className="lockmark"><Icon name="chat" size={34} /></span>
        <h1>{t('app.name')}</h1>
        <p>{t('login.intro')}</p>
      </div>
      <form onSubmit={submit}>
        <label>
          {t('login.user')}
          <input value={userId} onChange={(e) => setUserId(e.target.value)} autoCapitalize="none" autoComplete="username" required />
        </label>
        <label>
          {t('login.pin')}
          <input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" autoComplete="current-password" required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn go wide" disabled={busy}>{t('login.submit')}</button>
      </form>
    </main>
  );
}
