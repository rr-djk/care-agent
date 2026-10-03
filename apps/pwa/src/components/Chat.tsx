import { useEffect, useReducer, useRef } from 'react';
import type { RecordPage } from '@care-agent/schema';
import { api, type Auth, type FieldEdit } from '../api';
import { ApiError } from '../errors';
import { readEvents } from '../ndjson';
import { fieldLabel } from '../schemas';
import { activeItemMsg, currentItem, errorText, initialState, pageLabel, pageStateLabel, reducer } from '../state';
import { Composer } from './Composer';
import { PageSummary } from './PageSummary';
import { ReviewCard } from './ReviewCard';

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function Chat({ auth, onLogout }: { auth: Auth; onLogout: () => void }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stream = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const retakeInput = useRef<HTMLInputElement>(null);
  const retaking = useRef<{ pageId: string; pageType: number } | null>(null);

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

  /** Reloads the review queue: the bot asks the next question (or announces a cleared page) on its own. */
  const refresh = async (sessionId = state.session?.id) => {
    if (!sessionId) return;
    try {
      dispatch({ type: 'review_loaded', queue: await api.getReview(sessionId) });
    } catch (e) {
      fail(e);
    }
  };

  const follow = async (sessionId: string) => {
    stream.current?.abort();
    const ac = (stream.current = new AbortController());
    try {
      for await (const event of readEvents(await api.openAnalysis(sessionId, ac.signal))) {
        dispatch({ type: 'event', event });
        if (event.type === 'page_read') void refresh(sessionId);
      }
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

  const capture = async (file: File, pageType: number, replaces?: string) => {
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
        replaces,
      };
      dispatch({ type: 'page_added', pageId: id, pageType, replaces });
      await api.uploadPage(meta, file);
      if (replaces) void refresh(); // the replaced page leaves the queue now
    } catch (e) {
      fail(e);
    }
  };

  /** Reprendre la photo: the same page type again, uploaded with meta.replaces. */
  const retake = (pageId: string) => {
    const pageType = state.pages[pageId]?.pageType ?? state.review?.progress.pages.find((p) => p.page_id === pageId)?.page_type;
    if (!pageType) return;
    retaking.current = { pageId, pageType };
    retakeInput.current?.click();
  };

  const edit = async (pageId: string, fieldId: string, change: FieldEdit) => {
    try {
      const field = await api.patchField(pageId, fieldId, change);
      dispatch({ type: 'field_updated', pageId, field });
      if (field.text_fr) bot(field.text_fr); // why a value was not accepted, or what was masked
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const manual = async (pageId: string) => {
    try {
      await api.startManual(pageId);
      bot('Saisie manuelle : je vous demande les champs écrits, un par un.');
    } catch (e) {
      fail(e);
    }
  };

  const confirm = async (pageId: string) => {
    try {
      await api.confirmPage(pageId);
      dispatch({ type: 'page_confirmed', pageId });
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'fields_need_review') {
        bot(`Champs encore à vérifier : ${(e.field_ids ?? []).map(fieldLabel).join(', ')}.`);
      } else fail(e);
    }
  };

  const head = currentItem(state);
  const chat = async (message: string) => {
    if (!state.session || !head) return;
    dispatch({ type: 'say', from: 'user', text: message });
    try {
      const body = { session_id: state.session.id, page_id: head.page_id, field_id: head.field_id, message };
      for await (const event of readEvents(await api.chat(body))) dispatch({ type: 'event', event });
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const active = activeItemMsg(state);
  const progressOf = (pageId: string) => state.review?.progress.pages.find((p) => p.page_id === pageId);

  return (
    <div className="chat">
      <header>
        <span>Care Agent</span>
        <button onClick={onLogout}>Quitter</button>
      </header>
      {state.order.length > 0 && (
        <ol className="pages" aria-label="Pages de la session">
          {state.order.map((id) => (
            <li key={id} className={state.pages[id]?.superseded ? 'superseded' : ''}>
              <strong>{state.pages[id]?.pageType}</strong> {pageLabel(state.pages[id]?.pageType)}
              <span>{pageStateLabel(state.pages[id], progressOf(id))}</span>
            </li>
          ))}
        </ol>
      )}
      <main>
        {state.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.from}`}>
            {m.kind === 'text' && (
              <>
                <p>{m.text}</p>
                {m.hint && <p className="hint">{m.hint}</p>}
              </>
            )}
            {m.kind === 'summary' && (
              <PageSummary
                page={state.pages[m.pageId]}
                onPatch={(fieldId, value) => edit(m.pageId, fieldId, { value })}
                onConfirm={(fieldId) => edit(m.pageId, fieldId, { confirm: true })}
                onRetake={() => retake(m.pageId)}
              />
            )}
            {m.kind === 'item' && (
              <ReviewCard
                item={m.item}
                progress={state.review?.progress ?? { done: 0, total: 0 }}
                active={m.id === active}
                onConfirm={() => edit(m.item.page_id, m.item.field_id, { confirm: true })}
                onCorrect={(value) => edit(m.item.page_id, m.item.field_id, { value })}
                onRetake={() => retake(m.item.page_id)}
                onLeave={() => edit(m.item.page_id, m.item.field_id, { status: 'ILLEGIBLE' })}
              />
            )}
            {m.kind === 'page_clear' && (
              <>
                <p>Tout est vérifié pour la page {state.pages[m.pageId]?.pageType ?? ''}.</p>
                {!state.pages[m.pageId]?.validated && (
                  <button className="primary wide" onClick={() => confirm(m.pageId)}>Confirmer la page</button>
                )}
              </>
            )}
            {m.kind === 'manual_offer' && (
              <>
                <p>L'assistant d'analyse est indisponible pour cette page. Vous pouvez la saisir à la main : je vous guiderai champ par champ.</p>
                {state.pages[m.pageId]?.failed && <button className="primary wide" onClick={() => manual(m.pageId)}>Saisie manuelle</button>}
              </>
            )}
          </div>
        ))}
        <div ref={end} />
      </main>
      <input
        ref={retakeInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file && retaking.current) void capture(file, retaking.current.pageType, retaking.current.pageId);
        }}
      />
      <Composer hasSession={!!state.session} canChat={!!head} onChat={chat} onNewSession={newSession} onCapture={capture} />
    </div>
  );
}
