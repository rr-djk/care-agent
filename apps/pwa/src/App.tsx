import { useState } from 'react';
import { getAuth, setAuth, type Auth } from './api';
import { Chat } from './components/Chat';
import { Login } from './components/Login';

export function App() {
  const [auth, setCurrent] = useState<Auth | null>(getAuth());
  const update = (next: Auth | null) => {
    setAuth(next);
    setCurrent(next);
  };
  return auth ? <Chat auth={auth} onLogout={() => update(null)} /> : <Login onLogin={update} />;
}
