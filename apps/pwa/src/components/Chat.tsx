import { useEffect, useReducer, useRef } from 'react';
import type { RecordPage } from '@care-agent/schema';
import { api, type Auth } from '../api';
import { ApiError } from '../errors';
import { readEvents } from '../ndjson';
import { fieldLabel } from '../schemas';
import { errorText, initialState, reducer } from '../state';
import { Composer } from './Composer';
import { PageSummary } from './PageSummary';

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function Chat({ auth, onLogout }: { auth: Auth; onLogout: () => void }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stream = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [state.messages]);
  useEffect(() => () => void stream.current?.abort(), []);

  const bot = (text: string) => dispatch({ type: 'say', from: 'bot', text });
  const fail = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : 'network';
    if (code === 'unauthorized') onLogout();
    else bot(errorText(code));
  };

  const follow = async (sessionId: string) => {
    stream.current?.abort();
    const ac = (stream.current = new AbortController());
    try {
      for await (const event of readEvents(await api.openAnalysis(sessionId, ac.signal))) dispatch({ type: 'event', event });
    } catch (e) {
      if (!ac.signal.aborted) fail(e);
    }
  };

  const newSession = async (fiche: string, facility: string) => {
    try {
      const session = await api.createSession(fiche, facility);
      dispatch({ type: 'session_started', session });
      void follow(session.id);
    } catch (e) {
      fail(e);
    }
  };

  const capture = async (file: File, pageType: number) => {
    if (!state.session) return;
    const id = crypto.randomUUID();
    try {
      const sha256 = toHex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
      const meta: RecordPage = {
        id,
        session_id: state.session.id,
        page_type: pageType,
        captured_at: new Date().toISOString(),
        midwife_id: auth.userId,
        sha256,
        state: 'CAPTURED',
        flags: [],
      };
      dispatch({ type: 'page_added', pageId: id, pageType });
      await api.uploadPage(meta, file);
    } catch (e) {
      fail(e);
    }
  };

  const patch = async (pageId: string, fieldId: string, value: string | boolean | null) => {
    try {
      dispatch({ type: 'field_updated', pageId, field: await api.patchField(pageId, fieldId, value) });
    } catch (e) {
      fail(e);
    }
  };

  const confirm = async (pageId: string) => {
    try {
      await api.confirmPage(pageId);
      dispatch({ type: 'page_confirmed', pageId });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'fields_need_review') {
        bot(`Champs encore à vérifier : ${(e.field_ids ?? []).map(fieldLabel).join(', ')}.`);
      } else fail(e);
    }
  };

  return (
    <div className="chat">
      <header>
        <span>Care Agent</span>
        <button onClick={onLogout}>Quitter</button>
      </header>
      <main>
        {state.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.from}`}>
            {m.kind === 'text' ? (
              <>
                <p>{m.text}</p>
                {m.hint && <p className="hint">{m.hint}</p>}
              </>
            ) : (
              <PageSummary
                page={state.pages[m.pageId]}
                onPatch={(fieldId, value) => patch(m.pageId, fieldId, value)}
                onConfirm={() => confirm(m.pageId)}
              />
            )}
          </div>
        ))}
        <div ref={end} />
      </main>
      <Composer hasSession={!!state.session} onNewSession={newSession} onCapture={capture} />
    </div>
  );
}
