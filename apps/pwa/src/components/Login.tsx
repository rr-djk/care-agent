import { useState, type FormEvent } from 'react';
import { api, type Auth } from '../api';
import { ApiError, DeviceError } from '../errors';
import { enroll } from '../offline/store';
import { errorText } from '../state';

export function Login({ onLogin }: { onLogin: (auth: Auth) => void }) {
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
    <main className="login">
      <h1>Care Agent</h1>
      <form onSubmit={submit}>
        <label>
          Identifiant
          <input value={userId} onChange={(e) => setUserId(e.target.value)} autoCapitalize="none" autoComplete="username" required />
        </label>
        <label>
          Code PIN
          <input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" autoComplete="current-password" required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>Se connecter</button>
      </form>
    </main>
  );
}
