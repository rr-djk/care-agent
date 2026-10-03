import { useEffect, useReducer, useRef, useState } from 'react';
import type { RecordPage } from '@care-agent/schema';
import { api, type Auth, type FieldEdit } from '../api';
import { ApiError } from '../errors';
import { readEvents } from '../ndjson';
import { isOffline, isSimulated, netBlocked, setSimulated, subscribeNet } from '../offline/network';
import * as store from '../offline/store';
import { sync } from '../offline/sync';
import { fieldLabel } from '../schemas';
import { activeItemMsg, currentItem, errorText, initialState, pageLabel, pageStateLabel, queueLabel, reducer } from '../state';
import { Composer } from './Composer';
import { PageSummary } from './PageSummary';
import { ReviewCard } from './ReviewCard';

const STREAM_IDLE_MS = 30_000; // the server pings every 10 s: silence means the connection is dead
const MAX_RECONNECT_MS = 15_000;

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function Chat({ auth, onLogout, onWipe }: { auth: Auth; onLogout: () => void; onWipe: () => void }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [local, setLocal] = useState<store.LocalPage[]>([]); // the device queue (decrypted in memory)
  const [, redraw] = useState(0);
  const stream = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const retakeInput = useRef<HTMLInputElement>(null);
  const retaking = useRef<{ pageId: string; pageType: number } | null>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [state.messages]);
  useEffect(() => () => void stream.current?.abort(), []);

  const reloadLocal = async () => setLocal(await store.listPages(auth.userId));

  // Sync engine: runs for the life of the screen; re-render on connectivity and queue changes.
  useEffect(() => {
    const stop = sync.start(auth.userId);
    const offNet = subscribeNet(() => redraw((n) => n + 1));
    const offSync = sync.subscribe((e) => {
      void reloadLocal();
      if (e.type === 'auth_expired') onLogout();
      if (e.type === 'uploaded' && e.page.replaces) void refresh(e.page.session_id); // the replaced page leaves the queue now
    });
    return () => (stop(), offNet(), offSync());
  }, []);

  // Back from a reload (or an unlock): the last local session and its queue come back.
  useEffect(() => {
    void (async () => {
      const last = (await store.listSessions(auth.userId)).at(-1);
      await reloadLocal();
      if (!last) return;
      const pages = (await store.listPages(auth.userId)).filter((p) => p.meta.session_id === last.id);
      dispatch({ type: 'session_restored', session: last.session, pages: pages.map((p) => ({ id: p.id, pageType: p.meta.page_type, replaces: p.meta.replaces })) });
      void follow(last.id);
    })();
  }, []);

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

  /** Analysis stream with reconnection: after a drop it reopens (the server replays the stored events; the reducer dedupes them). */
  const follow = async (sessionId: string) => {
    stream.current?.abort();
    const ac = (stream.current = new AbortController());
    // wakes early on a network change or when a page reached the server (the session may exist now)
    const nap = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => (clearTimeout(t), offNet(), offSync(), resolve());
        const t = setTimeout(done, ms);
        const offNet = subscribeNet(done);
        const offSync = sync.subscribe((e) => e.type === 'uploaded' && done());
        ac.signal.addEventListener('abort', done, { once: true });
      });
    for (let failures = 0; !ac.signal.aborted; ) {
      const conn = new AbortController();
      const close = () => conn.abort();
      ac.signal.addEventListener('abort', close, { once: true });
      const offNet = subscribeNet(() => netBlocked() && close());
      let idle: ReturnType<typeof setTimeout> | undefined;
      const watchdog = () => (clearTimeout(idle), (idle = setTimeout(close, STREAM_IDLE_MS)));
      try {
        const body = await api.openAnalysis(sessionId, conn.signal);
        failures = 0;
        watchdog();
        for await (const event of readEvents(body, watchdog)) {
          dispatch({ type: 'event', event });
          if (event.type === 'page_read') void refresh(sessionId);
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === 'unauthorized') return onLogout();
      } finally {
        clearTimeout(idle);
        offNet();
      }
      await nap(Math.min(MAX_RECONNECT_MS, 1000 * 2 ** failures++));
    }
  };

  const newSession = async (fiche: string, facility: string) => {
    try {
      // created on the phone (works offline); the sync engine creates it on the server, idempotently, with the first page
      const session = { id: crypto.randomUUID(), midwife_id: auth.userId, fiche_number: fiche || undefined, facility: facility || undefined, started_at: new Date().toISOString(), page_ids: [] };
      await store.createLocalSession(auth.userId, session);
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
      const bytes = new Uint8Array(await file.arrayBuffer()); // the original bytes: never re-encoded
      const sha256 = toHex(await crypto.subtle.digest('SHA-256', bytes));
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
      await store.addPage(auth.userId, meta, bytes, file.type || 'application/octet-stream');
      dispatch({ type: 'page_added', pageId: id, pageType, replaces });
      await reloadLocal();
      void sync.kick();
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
      await store.deletePage(pageId).then(reloadLocal); // final review state: the local meta is no longer needed
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
  const offline = isOffline();
  const unsent = local.filter((p) => p.state !== 'UPLOADED').length;
  const wipeDevice = () => {
    const warning = unsent ? ` ${unsent} page(s) non envoyée(s) seront perdues.` : '';
    if (window.confirm(`Effacer toutes les données de l'appareil ?${warning}`)) onWipe();
  };
  const labelOf = (id: string) => {
    const item = local.find((p) => p.id === id);
    const page = state.pages[id];
    const queued = item && queueLabel(item, { offline, sending: sync.sendingId() === id, analysed: page?.fields != null || !!page?.failed });
    return queued ?? pageStateLabel(page, progressOf(id));
  };

  return (
    <div className="chat">
      <header>
        <span>Care Agent</span>
        <span className={`badge ${offline ? 'off' : unsent ? 'sync' : 'on'}`} role="status">
          {offline ? 'Hors ligne' : unsent ? `Synchronisation (${unsent})` : 'En ligne'}
        </span>
        <button onClick={onLogout}>Quitter</button>
      </header>
      <div className="offline-bar">
        <label>
          <input type="checkbox" checked={isSimulated()} onChange={(e) => setSimulated(e.target.checked)} /> Mode hors ligne (simulation)
        </label>
        <button onClick={wipeDevice}>Effacer les données de l'appareil</button>
      </div>
      {state.order.length > 0 && (
        <ol className="pages" aria-label="Pages de la session">
          {state.order.map((id) => (
            <li key={id} className={state.pages[id]?.superseded ? 'superseded' : ''}>
              <strong>{state.pages[id]?.pageType}</strong> {pageLabel(state.pages[id]?.pageType)}
              <span>{labelOf(id)}</span>
              {local.find((p) => p.id === id)?.state === 'SYNC_FAILED' && <button onClick={() => void sync.retry(id)}>Réessayer</button>}
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
