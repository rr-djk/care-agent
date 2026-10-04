import { setLang, t, useLang } from '../i18n';

/** FR | EN switch; the choice is remembered on this device. */
export function LangToggle({ onLight = false }: { onLight?: boolean }) {
  const lang = useLang();
  return (
    <div className={`lang${onLight ? ' on-light' : ''}`} role="group" aria-label={t('lang.label')}>
      <button type="button" aria-pressed={lang === 'fr'} onClick={() => setLang('fr')} lang="fr" aria-label={t('lang.fr')}>FR</button>
      <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')} lang="en" aria-label={t('lang.en')}>EN</button>
    </div>
  );
}
