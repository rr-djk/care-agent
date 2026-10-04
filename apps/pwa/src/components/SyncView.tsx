import { errorText, fmtWhen, t, useLang } from '../i18n';
import { isOffline, isSimulated, setSimulated } from '../offline/network';
import type { LocalPage, LocalSession } from '../offline/store';
import { sync } from '../offline/sync';
import { pageLabel } from '../state';
import { Icon, Ticks } from './Icon';
import { TopBar } from './TopBar';

interface Props {
  local: LocalPage[];
  sessions: LocalSession[];
  unsent?: number;
  onLock: () => void;
  onRetry: (pageId: string) => void;
  onLogout: () => void;
  onWipe: () => void;
}

/** Synchro: the connection, every page still on the phone with its ticks, what the ticks mean, and device settings. */
export function SyncView({ local, sessions, unsent = 0, onLock, onRetry, onLogout, onWipe }: Props) {
  useLang();
  const offline = isOffline();
  const ficheOf = (p: LocalPage) => sessions.find((s) => s.id === p.meta.session_id)?.session.fiche_number;
  const wipe = () => {
    const pending = local.filter((p) => p.state !== 'UPLOADED').length;
    if (window.confirm(pending ? t('sync.wipe_confirm_unsent', { n: pending }) : t('sync.wipe_confirm'))) onWipe();
  };
  const sorted = [...local].sort((a, b) => (a.state === 'SYNC_FAILED' ? -1 : 0) - (b.state === 'SYNC_FAILED' ? -1 : 0) || b.seq - a.seq);

  return (
    <section className="view" aria-label={t('sync.title')}>
      <TopBar title={t('sync.title')} onLock={onLock} unsent={unsent} />
      <div className="scroll">
        <div className="stack-pad">
          <section className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16 }}>
            <span className={`avatar ${offline ? 'bad' : 'ok'}`}><Icon name={offline ? 'alert' : 'check'} /></span>
            <span className="line">
              <strong style={{ fontSize: 16 }}>{offline ? (isSimulated() ? t('sync.simulated') : t('sync.offline')) : t('sync.online')}</strong>
              <span className="muted" style={{ fontSize: 13 }}>{unsent ? t('sync.pending', { n: unsent }) : t('sync.all_sent')}</span>
            </span>
          </section>

          <section className="card">
            <div className="card-title">{t('sync.pages')}</div>
            {!sorted.length && <p className="muted" style={{ padding: '0 16px 14px', margin: 0 }}>{t('sync.none')}</p>}
            {sorted.map((p) => {
              const fiche = ficheOf(p);
              const failed = p.state === 'SYNC_FAILED';
              const status = failed
                ? t('queue.failed', { reason: errorText(p.error ?? 'http_error') })
                : p.state === 'UPLOADED'
                  ? t('sync.tick2')
                  : sync.sendingId() === p.id
                    ? t('queue.sending')
                    : offline || p.attempts > 0
                      ? t('queue.waiting')
                      : t('queue.stored');
              return (
                <div key={p.id} className={`sync-item${failed ? ' bad' : ''}`}>
                  {failed ? <span style={{ color: 'var(--bad-ink)' }}><Icon name="alert" /></span> : <Ticks n={p.state === 'UPLOADED' ? 2 : 1} label={status} />}
                  <span className="line">
                    <strong style={{ fontWeight: 600 }}>
                      {pageLabel(p.meta.page_type)}
                      {fiche && <span className="mono"> · {fiche}</span>}
                    </strong>
                    <span className="muted" style={{ fontSize: 13 }}>{status} · {fmtWhen(p.meta.captured_at)}</span>
                  </span>
                  {failed && <button className="btn small danger" onClick={() => onRetry(p.id)}>{t('common.retry')}</button>}
                </div>
              );
            })}
          </section>

          <section className="card">
            <div className="card-title">{t('sync.legend')}</div>
            <div className="legend">
              <span><Ticks n={1} />{t('sync.tick1')}</span>
              <span><Ticks n={2} />{t('sync.tick2')}</span>
              <span><Ticks n={3} />{t('sync.tick3')}</span>
            </div>
          </section>

          <section className="card">
            <div className="card-title">{t('sync.device')}</div>
            <label className="toggle-row">
              <span>{t('sync.simulate')}</span>
              <input type="checkbox" checked={isSimulated()} onChange={(e) => setSimulated(e.target.checked)} />
            </label>
            <div style={{ padding: '8px 16px 16px', display: 'grid', gap: 8 }}>
              <button className="btn" onClick={onLogout}>{t('sync.logout')}</button>
              <button className="btn danger" onClick={wipe}>{t('sync.wipe')}</button>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
