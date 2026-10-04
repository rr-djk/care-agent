import type { ReactNode } from 'react';
import { t } from '../i18n';
import { isOffline } from '../offline/network';
import { Icon } from './Icon';
import { LangToggle } from './LangToggle';

/** Network status pill: online, offline, or sending N pages. */
export function NetPill({ unsent }: { unsent: number }) {
  const off = isOffline();
  return (
    <span className={`net${off ? ' off' : unsent ? ' sync' : ''}`} role="status">
      <i />
      {off ? t('net.offline') : unsent ? t('net.syncing', { n: unsent }) : t('net.online')}
    </span>
  );
}

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  onLock?: () => void;
  unsent?: number; // shows the network pill when set
  right?: ReactNode;
  children?: ReactNode; // a search field under the title row
}

/** The green bar of every screen: back or title, network state, FR/EN, lock. */
export function TopBar({ title, subtitle, onBack, onLock, unsent, right, children }: Props) {
  return (
    <header className={`topbar${onBack ? ' back' : ''}`}>
      <div className="row">
        {onBack && (
          <button className="icon-btn" onClick={onBack} aria-label={t('common.back')}>
            <Icon name="back" size={24} />
          </button>
        )}
        <div className="title">
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </div>
        {right}
        {unsent !== undefined && <NetPill unsent={unsent} />}
        {!onBack && <LangToggle />}
        {onLock && (
          <button className="icon-btn" onClick={onLock} aria-label={t('shell.lock')}>
            <Icon name="lock" />
          </button>
        )}
      </div>
      {children}
    </header>
  );
}
