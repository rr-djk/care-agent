import { useEffect, useState } from 'react';
import type { Auth } from '../api';
import { DeviceError } from '../errors';
import { errorText, t, useLang } from '../i18n';
import { unlock } from '../offline/store';
import { Icon } from './Icon';
import { LangToggle } from './LangToggle';

const MAX_DIGITS = 8;

/** Unlock with the PIN, no server needed: the key is derived on the device and decrypts the stored token. */
export function Unlock({ userId, online, onUnlock, onOther, onWipe }: { userId: string; online: boolean; onUnlock: (auth: Auth) => void; onOther: () => void; onWipe: () => void }) {
  useLang();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pin || busy) return;
    setBusy(true);
    setError('');
    try {
      onUnlock(await unlock(userId, pin));
    } catch (err) {
      const code = err instanceof DeviceError ? err.code : 'wrong_pin';
      setError(code === 'locked' && err instanceof DeviceError ? t('unlock.too_many', { s: Math.ceil(err.retryInMs / 1000) }) : errorText(code));
      setBusy(false);
      setPin('');
    }
  };
  const press = (d: string) => setPin((p) => (p.length < MAX_DIGITS ? p + d : p));

  // a physical keyboard works too (laptop, tablet)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') void submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <main className="gate">
      <div className="top"><LangToggle /></div>
      <div className="hello">
        <span className="lockmark"><Icon name="lock" size={34} /></span>
        <h1>{t('unlock.hello', { user: userId })}</h1>
        <p>{online ? t('unlock.intro') : t('unlock.offline')}</p>
      </div>
      <div className="dots" role="status" aria-label={t('unlock.pin_progress', { n: pin.length })}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" onClick={() => press(d)} disabled={busy}>{d}</button>
        ))}
        <button type="button" className="plain" onClick={() => setPin((p) => p.slice(0, -1))} aria-label={t('unlock.erase_digit')} disabled={busy}>
          <Icon name="erase" size={26} />
        </button>
        <button type="button" onClick={() => press('0')} disabled={busy}>0</button>
        <button type="button" className="ok" onClick={() => void submit()} aria-label={t('unlock.submit')} disabled={busy || !pin}>
          <Icon name="check" size={28} />
        </button>
      </div>
      <div className="foot">
        <span>{t('unlock.autolock')}</span>
        <button type="button" onClick={onOther}>{t('unlock.other')}</button>
        <button type="button" onClick={onWipe}>{t('unlock.wipe')}</button>
      </div>
    </main>
  );
}
