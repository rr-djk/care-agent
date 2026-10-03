import { useState, type FormEvent } from 'react';
import type { Auth } from '../api';
import { DeviceError } from '../errors';
import { errorText } from '../state';
import { unlock } from '../offline/store';

/** Unlock with the PIN, no server needed: the key is derived on the device and decrypts the stored token. */
export function Unlock({ userId, online, onUnlock, onOther, onWipe }: { userId: string; online: boolean; onUnlock: (auth: Auth) => void; onOther: () => void; onWipe: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onUnlock(await unlock(userId, pin));
    } catch (err) {
      const code = err instanceof DeviceError ? err.code : 'wrong_pin';
      setError(code === 'locked' && err instanceof DeviceError ? `Trop d'essais. Réessayez dans ${Math.ceil(err.retryInMs / 1000)} s.` : errorText(code));
      setBusy(false);
      setPin('');
    }
  };

  return (
    <main className="login">
      <h1>Care Agent</h1>
      <p className="hint">{online ? 'Appareil déjà utilisé.' : 'Serveur injoignable : déverrouillage hors ligne.'}</p>
      <form onSubmit={submit}>
        <label>
          Identifiant
          <input value={userId} readOnly />
        </label>
        <label>
          Code PIN
          <input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" autoComplete="current-password" required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>Déverrouiller</button>
      </form>
      <p>
        <button onClick={onOther}>Autre compte</button> <button onClick={onWipe}>Effacer les données de l'appareil</button>
      </p>
    </main>
  );
}
