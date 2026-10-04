import { useEffect, useReducer, useRef, useState } from 'react';
import type { Difference, Flag, LinkDecision, QualityResult, RecordPage } from '@care-agent/schema';
import { api, type Auth, type FieldEdit } from '../api';
import { ApiError } from '../errors';
import { hasKey, t, useLang, type Key } from '../i18n';
import { readEvents } from '../ndjson';
import { isOffline, netBlocked, subscribeNet } from '../offline/network';
import * as store from '../offline/store';
import { sync } from '../offline/sync';
import { checkPhoto } from '../quality/client';
import { cameraAvailable } from '../quality/guide';
import { fieldLabel } from '../schemas';
import { activeItemMsg, activeLinkMsg, activeOfferMsg, currentItem, initialState, linkResultText, msgText, pageLabel, pageStateLabel, PAGE_TYPES, queueLabel, reducer, toReview, type PageView } from '../state';
import { buildSummary } from '../summary';
import { CameraCapture } from './CameraCapture';
import { DifferencesCard } from './DifferencesCard';
import { Icon, Ticks } from './Icon';
import { MatchCard } from './MatchCard';
import { PageSummary } from './PageSummary';
import { QualityPanel } from './QualityPanel';
import { ReviewCard } from './ReviewCard';
import { TopBar } from './TopBar';

const STREAM_IDLE_MS = 30_000; // the server pings every 10 s: silence means the connection is dead
const MAX_RECONNECT_MS = 15_000;

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The capture screen in progress: live camera, quality check running, or the verdict waiting for the midwife. */
type Capturing =
  | { step: 'camera'; pageType: number; replaces?: string }
  | { step: 'checking'; pageType: number; replaces?: string }
  | { step: 'verdict'; file: File; result: QualityResult; pageType: number; replaces?: string };

interface Props {
  auth: Auth;
  sessionId: string;
  fresh: boolean; // a fiche just opened (else resumed)
  local: store.LocalPage[]; // the device queue, owned by the shell
  onBack: () => void;
  onLocalChange: () => Promise<void> | void;
  onLogout: () => void;
  onOpenPatient: (patientId: string) => void;
}

/** One fiche as a conversation: photos go up, the assistant reads, asks about doubtful fields, then links the record. */
export function Chat({ auth, sessionId, fresh, local, onBack, onLocalChange, onLogout, onOpenPatient }: Props) {
  useLang();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [, redraw] = useState(0);
  const stream = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const picking = useRef<{ pageType: number; replaces?: string } | null>(null);
  const [capturing, setCapturing] = useState<Capturing | null>(null);
  const [choosing, setChoosing] = useState(false); // the page type sheet
  const [summaryOf, setSummaryOf] = useState<string | null>(null); // page id of the open summary
  const [text, setText] = useState('');

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [state.messages]);
  useEffect(() => () => void stream.current?.abort(), []);
  useEffect(() => subscribeNet(() => redraw((n) => n + 1)), []);
  useEffect(
    () =>
      sync.subscribe((e) => {
        if (e.type === 'uploaded' && e.page.session_id === sessionId && e.page.replaces) void refresh(); // the replaced page leaves the queue now
      }),
    [],
  );

  // open the fiche: a new one says hello, a resumed one gets its pages back (the stream replays what the server read)
  useEffect(() => {
    void (async () => {
      const found = (await store.listSessions(auth.userId)).find((s) => s.id === sessionId);
      if (!found) return onBack();
      if (fresh) dispatch({ type: 'session_started', session: found.session });
      else {
        const pages = (await store.listPages(auth.userId)).filter((p) => p.meta.session_id === sessionId);
        dispatch({ type: 'session_restored', session: found.session, pages: pages.map((p) => ({ id: p.id, pageType: p.meta.page_type, replaces: p.meta.replaces })) });
      }
      void follow();
    })();
  }, [sessionId]);

  const say = (key: Key, params?: Record<string, string | number>) => dispatch({ type: 'say', from: 'bot', key, params });
  const fail = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : 'network';
    if (code === 'unauthorized') onLogout();
    else say(hasKey(`error.${code}`) ? (`error.${code}` as Key) : 'error.unknown');
  };

  /** Reloads the review queue: the bot asks the next question (or announces a cleared page) on its own. */
  const refresh = async () => {
    try {
      dispatch({ type: 'review_loaded', queue: await api.getReview(sessionId) });
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'session_not_found')) fail(e); // not on the server yet: nothing to review
    }
  };

  /** Analysis stream with reconnection: after a drop it reopens (the server replays the stored events; the reducer dedupes them). */
  const follow = async () => {
    stream.current?.abort();
    const ac = (stream.current = new AbortController());
    // wakes early on a network change or when a page reached the server (the session may exist now)
    const nap = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => (clearTimeout(timer), offNet(), offSync(), resolve());
        const timer = setTimeout(done, ms);
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
          if (event.type === 'page_read') void refresh();
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

  const capture = async (file: File, pageType: number, replaces?: string, quality?: QualityResult, flags: Flag[] = []) => {
    if (!state.session) return;
    const id = crypto.randomUUID();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); // the original bytes: never re-encoded
      const sha256 = toHex(await crypto.subtle.digest('SHA-256', bytes));
      const meta: RecordPage = { id, session_id: state.session.id, page_type: pageType, captured_at: new Date().toISOString(), midwife_id: auth.userId, sha256, state: 'CAPTURED', flags, quality, replaces };
      await store.addPage(auth.userId, meta, bytes, file.type || 'application/octet-stream');
      dispatch({ type: 'page_added', pageId: id, pageType, replaces });
      await onLocalChange();
      void sync.kick();
    } catch (e) {
      fail(e);
    }
  };

  /** The file picker (gallery or the phone's own camera app): no live guide, the post-capture check still runs. */
  const pick = (pageType: number, replaces?: string) => {
    picking.current = { pageType, replaces };
    fileInput.current?.click();
  };

  /** Live camera with the guide when the browser allows it, else the file picker. */
  const startCapture = (pageType: number, replaces?: string) => (cameraAvailable() ? setCapturing({ step: 'camera', pageType, replaces }) : pick(pageType, replaces));

  /**
   * Post-capture check, before the page is queued (works offline). OK: queued with its quality. WARNING / REJECT: the
   * midwife decides; « Garder quand même » queues it with the LOW_QUALITY flag. A failing check never blocks the capture.
   */
  const inspect = async (file: File, pageType: number, replaces?: string) => {
    setCapturing({ step: 'checking', pageType, replaces });
    let result: QualityResult | undefined;
    try {
      result = await checkPhoto(file);
    } catch {
      result = undefined; // OpenCV could not run: capture without a verdict rather than block the midwife
    }
    if (result && result.outcome !== 'OK') return setCapturing({ step: 'verdict', file, result, pageType, replaces });
    setCapturing(null);
    await capture(file, pageType, replaces, result);
  };

  /** Reprendre la photo: the same page type again, uploaded with meta.replaces. */
  const retake = (pageId: string) => {
    const pageType = state.pages[pageId]?.pageType ?? state.review?.progress.pages.find((p) => p.page_id === pageId)?.page_type;
    setSummaryOf(null);
    if (pageType) startCapture(pageType, pageId);
  };

  const edit = async (pageId: string, fieldId: string, change: FieldEdit) => {
    try {
      const field = await api.patchField(pageId, fieldId, change);
      dispatch({ type: 'field_updated', pageId, field });
      if (field.text_fr) dispatch({ type: 'say', from: 'bot', text: field.text_fr }); // why a value was not accepted (server's words)
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const manual = async (pageId: string) => {
    try {
      await api.startManual(pageId);
      say('msg.manual_started');
    } catch (e) {
      fail(e);
    }
  };

  const confirm = async (pageId: string) => {
    try {
      await api.confirmPage(pageId);
      await store.deletePage(pageId); // final review state: the local meta is no longer needed
      await onLocalChange();
      dispatch({ type: 'page_confirmed', pageId });
      setSummaryOf(null);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'fields_need_review') say('msg.fields_left', { list: (e.field_ids ?? []).map((id) => fieldLabel(id)).join(', ') });
      else fail(e);
    }
  };

  /**
   * The fiche number once known (read on the cover and accepted, typed, or the linked record's): kept on the phone's copy
   * of the fiche so the home list shows it. Display only: the server keeps its own key. Re-read before writing, because
   * the sync engine writes the same record (a stale « synced » flag only makes it create the fiche again: idempotent).
   */
  const remember = async (fiche?: string | null, facility?: string | null) => {
    if (!fiche) return;
    const found = (await store.listSessions(auth.userId)).find((s) => s.id === sessionId);
    if (!found || (found.session.fiche_number === fiche && (!facility || found.session.facility === facility))) return;
    await store.saveSession({ ...found, session: { ...found.session, fiche_number: fiche, facility: facility || found.session.facility } });
    await onLocalChange();
  };

  /** The link question. Needs the server: offline (or unreachable) the question simply waits and the button stays. */
  const askLink = async () => {
    try {
      const proposal = await api.getProposal(sessionId);
      dispatch({ type: 'link_proposal', proposal });
      if (!proposal.fiche.low_confidence) void remember(proposal.fiche.value, proposal.facility);
    } catch (e) {
      fail(e);
    }
  };

  /** The midwife types or confirms the fiche number: the question is asked again with the new key. */
  const setKey = async (key: { fiche_number?: string; facility?: string }) => {
    try {
      const proposal = await api.setSessionKey(sessionId, key);
      dispatch({ type: 'link_proposal', proposal });
      void remember(proposal.fiche.value, proposal.facility);
    } catch (e) {
      fail(e);
    }
  };

  /** Stores the decision, then acknowledges the registered record (SYNCED) once the phone has it. */
  const decide = async (decision: LinkDecision) => {
    try {
      const result = await api.link(sessionId, decision);
      dispatch({ type: 'link_decided', result });
      if (result.patient) void remember(result.patient.fiche_number, result.patient.facility);
      if (result.status === 'linked') await api.acknowledge(sessionId);
      await refresh();
      await onLocalChange();
    } catch (e) {
      fail(e);
    }
  };

  const choose = async (d: Difference, choice: 'old' | 'new') => {
    try {
      dispatch({ type: 'differences_updated', differences: await api.saveChoices(sessionId, [{ page_id: d.page_id, field_id: d.field_id, choice }]) });
    } catch (e) {
      fail(e);
    }
  };

  const head = currentItem(state);
  const send = async () => {
    const message = text.trim();
    if (!head || !message) return;
    setText('');
    dispatch({ type: 'say', from: 'user', text: message });
    try {
      const body = { session_id: sessionId, page_id: head.page_id, field_id: head.field_id, message };
      for await (const event of readEvents(await api.chat(body))) dispatch({ type: 'event', event });
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const active = activeItemMsg(state);
  const activeOffer = activeOfferMsg(state);
  const activeLink = activeLinkMsg(state);
  const progressOf = (pageId: string) => state.review?.progress.pages.find((p) => p.page_id === pageId);
  const offline = isOffline();
  const pageLine = (id: string) => {
    const item = local.find((p) => p.id === id);
    const page = state.pages[id];
    const queued = item && queueLabel(item, { offline, sending: sync.sendingId() === id, analysed: page?.fields != null || !!page?.failed });
    return queued ?? pageStateLabel(page, progressOf(id));
  };
  const ticksOf = (id: string): 0 | 1 | 2 | 3 => {
    const item = local.find((p) => p.id === id);
    if (item && item.state !== 'UPLOADED') return 1;
    return ['PATIENT_MATCHED', 'REGISTERED', 'SYNCED'].includes(progressOf(id)?.state ?? '') ? 3 : 2;
  };
  const lastRead = [...state.order].reverse().find((id) => state.pages[id]?.fields && !state.pages[id]?.superseded);
  const fiche = state.session?.fiche_number ?? state.link.proposal?.fiche.value ?? undefined;
  const pageCount = state.order.filter((id) => !state.pages[id]?.superseded).length;
  const summaryPage: PageView | undefined = summaryOf ? state.pages[summaryOf] : undefined;

  return (
    <section className="view" aria-label={fiche ? t('patients.fiche', { fiche }) : t('home.untitled')}>
      <TopBar
        title={<span className="mono">{fiche ? t('patients.fiche', { fiche }) : t('home.untitled')}</span>}
        subtitle={[state.session?.facility, t('home.pages', { n: pageCount })].filter(Boolean).join(' · ')}
        onBack={onBack}
        right={lastRead && <button className="btn small" style={{ background: 'transparent', color: 'inherit', borderColor: 'rgba(255,255,255,.6)' }} onClick={() => setSummaryOf(lastRead)}>{t('chat.summary')}</button>}
      />
      <div className="chat">
        {state.order.length > 0 && (
          <nav className="pages" aria-label={t('home.pages', { n: pageCount })}>
            {state.order.map((id) => {
              const page = state.pages[id];
              const pending = page ? toReview(page).length : 0;
              return (
                <button key={id} className={`${page?.superseded ? 'superseded' : ''} ${pending ? 'warn' : ''}`} onClick={() => page?.fields && setSummaryOf(id)} title={pageLine(id)}>
                  <Ticks n={ticksOf(id)} />
                  {page?.pageType} · {pageLabel(page?.pageType)}
                  <span className="muted" style={{ fontWeight: 500 }}>· {pageLine(id)}</span>
                </button>
              );
            })}
            {local.filter((p) => p.meta.session_id === sessionId && p.state === 'SYNC_FAILED').map((p) => (
              <button key={`retry-${p.id}`} className="warn" onClick={() => void sync.retry(p.id).then(onLocalChange)}>{t('common.retry')}</button>
            ))}
          </nav>
        )}
        <main>
          {state.messages.map((m) => {
            switch (m.kind) {
              case 'text':
                return (
                  <div key={m.id} className={`bubble ${m.from}`}>
                    <p>{msgText(m)}</p>
                    {m.hint && <p className="hint">{t(m.hint)}</p>}
                  </div>
                );
              case 'summary': {
                const page = state.pages[m.pageId];
                const s = buildSummary(page?.pageType, page?.fields ?? []);
                return (
                  <div key={m.id} className="bubble bot">
                    <p><strong>{t('card.page_read', { type: page?.pageType ?? '', label: pageLabel(page?.pageType) })}</strong></p>
                    <p>{t('card.page_counts', { read: s.read, review: page ? toReview(page).length : 0 })}</p>
                    <button className="open-summary" onClick={() => setSummaryOf(m.pageId)}>
                      <span>{t('card.open_summary')}<small>{s.sections.slice(0, 4).map((x) => x.title).join(' · ')}</small></span>
                      <Icon name="next" />
                    </button>
                  </div>
                );
              }
              case 'item':
                return (
                  <ReviewCard
                    key={m.id}
                    item={m.item}
                    progress={state.review?.progress ?? { done: 0, total: 0 }}
                    active={m.id === active}
                    onConfirm={() => edit(m.item.page_id, m.item.field_id, { confirm: true })}
                    onCorrect={(value) => edit(m.item.page_id, m.item.field_id, { value })}
                    onRetake={() => retake(m.item.page_id)}
                    onLeave={() => edit(m.item.page_id, m.item.field_id, { status: 'ILLEGIBLE' })}
                  />
                );
              case 'page_clear':
                return (
                  <div key={m.id} className="bubble bot">
                    <p>{t('card.page_clear', { type: state.pages[m.pageId]?.pageType ?? '' })}</p>
                    {!state.pages[m.pageId]?.validated && (
                      <div className="actions">
                        <button className="btn go" onClick={() => confirm(m.pageId)}><Icon name="check" />{t('card.confirm_page')}</button>
                      </div>
                    )}
                  </div>
                );
              case 'finish_offer':
                return (
                  <div key={m.id} className="bubble bot">
                    <p>{t('card.finish')}</p>
                    {m.id === activeOffer && (
                      <div className="actions">
                        <button className="btn go" onClick={() => void askLink()} disabled={offline}>{t('card.finish_button')}</button>
                        {offline && <p className="hint">{t('card.needs_server')}</p>}
                      </div>
                    )}
                  </div>
                );
              case 'link':
                return <MatchCard key={m.id} proposal={m.proposal} active={m.id === activeLink} offline={offline} onDecide={(d) => void decide(d)} onSetKey={(k) => void setKey(k)} />;
              case 'link_done':
                return (
                  <div key={m.id} className="bubble bot">
                    <p>{linkResultText(m.result)}</p>
                    {m.result.patient && (
                      <div className="actions">
                        <button className="btn" onClick={() => onOpenPatient(m.result.patient!.id)}>{t('card.open_record', { id: m.result.patient.id })}</button>
                      </div>
                    )}
                  </div>
                );
              case 'differences':
                return <DifferencesCard key={m.id} differences={state.differences} onChoose={(d, c) => void choose(d, c)} />;
              case 'manual_offer':
                return (
                  <div key={m.id} className="bubble bot">
                    <p>{t('card.manual_offer')}</p>
                    {state.pages[m.pageId]?.failed && (
                      <div className="actions">
                        <button className="btn go" onClick={() => manual(m.pageId)}>{t('card.manual_button')}</button>
                      </div>
                    )}
                  </div>
                );
            }
          })}
          <div ref={end} />
        </main>
        <footer className="composer">
          <button className="round" onClick={() => setChoosing(true)} aria-label={t('chat.capture')}>
            <Icon name="camera" size={24} />
          </button>
          {head ? (
            <>
              <label>
                <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} placeholder={t('chat.input')} aria-label={t('chat.input')} />
              </label>
              <button className="round go" onClick={() => void send()} aria-label={t('chat.send')} disabled={!text.trim()}>
                <Icon name="send" />
              </button>
            </>
          ) : (
            <button className="btn go capture-cta" onClick={() => setChoosing(true)}>{t('chat.capture')}</button>
          )}
        </footer>
      </div>

      {choosing && (
        <PageTypeSheet
          onCancel={() => setChoosing(false)}
          onPick={(type, from) => {
            setChoosing(false);
            if (from === 'gallery') pick(type);
            else startCapture(type);
          }}
        />
      )}
      {summaryPage && summaryOf && (
        <PageSummary
          page={summaryPage}
          progress={progressOf(summaryOf)}
          onClose={() => setSummaryOf(null)}
          onConfirmField={(fieldId) => edit(summaryOf, fieldId, { confirm: true })}
          onCorrect={(fieldId, value) => edit(summaryOf, fieldId, { value })}
          onLeave={(fieldId) => edit(summaryOf, fieldId, { status: 'ILLEGIBLE' })}
          onRetake={() => retake(summaryOf)}
          onConfirmPage={() => confirm(summaryOf)}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // allow choosing the same file again
          if (file && picking.current) void inspect(file, picking.current.pageType, picking.current.replaces);
        }}
      />
      {capturing?.step === 'camera' && <CameraCapture onCapture={(file) => void inspect(file, capturing.pageType, capturing.replaces)} onCancel={() => setCapturing(null)} />}
      {capturing?.step === 'checking' && (
        <div className="overlay center" role="status">
          <div className="panel">{t('quality.checking')}</div>
        </div>
      )}
      {capturing?.step === 'verdict' && (
        <QualityPanel
          file={capturing.file}
          result={capturing.result}
          onRetake={() => startCapture(capturing.pageType, capturing.replaces)}
          onKeep={() => {
            setCapturing(null);
            void capture(capturing.file, capturing.pageType, capturing.replaces, capturing.result, ['LOW_QUALITY']);
          }}
        />
      )}
    </section>
  );
}

/** Which page is being photographed: 8 large buttons, then the camera (or the gallery). */
function PageTypeSheet({ onCancel, onPick }: { onCancel: () => void; onPick: (type: number, from: 'camera' | 'gallery') => void }) {
  const [from, setFrom] = useState<'camera' | 'gallery'>('camera');
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t('chat.choose_type')} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="sheet">
        <h2>{t('chat.choose_type')}</h2>
        <div className="types">
          {PAGE_TYPES.map((type) => (
            <button key={type} onClick={() => onPick(type, from)}>
              {pageLabel(type)}
              <small>page {type}</small>
            </button>
          ))}
        </div>
        <div className="seg" style={{ margin: 0 }}>
          <button aria-pressed={from === 'camera'} onClick={() => setFrom('camera')}><Icon name="camera" size={18} /> {t('chat.capture')}</button>
          <button aria-pressed={from === 'gallery'} onClick={() => setFrom('gallery')}><Icon name="image" size={18} /> {t('chat.import')}</button>
        </div>
        <button className="btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}
