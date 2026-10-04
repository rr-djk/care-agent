// Inline stroke icons (no icon font, no network). Decorative by default: the button or link around them carries the label.
const PATHS = {
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  records: 'M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 8h8M8 12h8M8 16h5',
  sync: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4',
  stats: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  back: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5h.01',
  send: 'M4 12l16-8-6 16-2-7z',
  check: 'M5 12l5 5 9-10',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  minus: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12h8',
  eyeoff: 'M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-2.6 3.2M6.6 6.7C4.3 8.2 3 12 3 12s4 6 9 6c1.6 0 3-.4 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
  erase: 'M21 5H9l-6 7 6 7h12zM17 9l-6 6M11 9l6 6',
  alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v6M12 16.5v.5',
  page: 'M7 3h7l5 5v13H7zM14 3v5h5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Sync ticks of a page or a fiche: 1 = on the phone, 2 = received by the server, 3 = saved in the record (blue). */
export function Ticks({ n, label }: { n: 0 | 1 | 2 | 3; label?: string }) {
  if (!n) return null;
  const color = n === 3 ? 'var(--tick)' : 'var(--muted)';
  return (
    <svg className="ticks" width={n === 1 ? 14 : 19} height={12} viewBox={n === 1 ? '0 0 13 12' : '0 0 18 12'} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" role="img" aria-label={label}>
      {n === 1 ? <path d="M1.5 6.5L4.5 9.5 10.5 2.5" /> : (
        <>
          <path d="M1 6l3.5 3.5L11 3" />
          <path d="M7 9.5L13.5 3" />
        </>
      )}
    </svg>
  );
}
