import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { _qualityEn, _tables, errorText, getLang, qualityText, setLang, t } from './i18n';

afterEach(() => setLang('fr'));

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('bilingual tables', () => {
  it('every key has a non-empty text and the same placeholders in French and English', () => {
    const { fr, en } = _tables;
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    for (const key of Object.keys(fr) as (keyof typeof fr)[]) {
      expect(fr[key].trim(), key).not.toBe('');
      expect(en[key].trim(), key).not.toBe('');
      expect(placeholders(en[key]), key).toEqual(placeholders(fr[key]));
    }
  });

  it('every message of the quality gate has an English version', () => {
    const gate = readFileSync(new URL('../../../packages/quality/src/gate.ts', import.meta.url), 'utf8');
    const messages = [...gate.matchAll(/(?:warn|messages\.push)\((['"])(.+?)\1\)/g)].map((m) => m[2].replace(/\\'/g, "'"));
    expect(messages.length).toBeGreaterThanOrEqual(10);
    for (const m of messages) expect(_qualityEn[m], m).toBeTruthy();
  });

  it('switches language, fills placeholders, falls back for an unknown error code', () => {
    expect(getLang()).toBe('fr');
    expect(t('review.header', { done: 1, total: 3 })).toBe('À vérifier · 1 sur 3');
    setLang('en');
    expect(t('review.header', { done: 1, total: 3 })).toBe('To check · 1 of 3');
    expect(errorText('wrong_pin')).toBe('Wrong PIN.');
    expect(errorText('no_such_code')).toBe('Something went wrong.');
    expect(qualityText('Photo floue : rapprochez-vous et tenez le téléphone immobile')).toBe('Blurry photo: move closer and hold the phone still');
    setLang('fr');
    expect(qualityText('Photo floue : rapprochez-vous et tenez le téléphone immobile')).toMatch(/^Photo floue/);
  });

  it('plural marks follow the number before them: French 0 and 1 singular, English 1 singular', () => {
    expect([0, 1, 2].map((n) => t('home.pages', { n }))).toEqual(['0 page', '1 page', '2 pages']);
    expect(t('summary.detail', { empty: 1, checked: 3 })).toBe('1 case vide · 3 cases cochées');
    setLang('en');
    expect([0, 1, 2].map((n) => t('home.pages', { n }))).toEqual(['0 pages', '1 page', '2 pages']);
    expect(t('summary.detail', { empty: 1, checked: 3 })).toBe('1 empty box · 3 ticked boxes');
  });
});
