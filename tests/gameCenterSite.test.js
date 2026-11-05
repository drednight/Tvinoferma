import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ open: vi.fn(async () => {}), check: vi.fn(async () => {}) }));
vi.mock('../js/core/linkBrowser.js', () => ({ openCharacterWebLink: mocks.open }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ refreshAuthFor: mocks.check }));
import { gameCenterSiteUrl, openGameCenterSitePilot } from '../js/modules/characters/gameCenterSite.js';
import { normalizeCharacter } from '../js/core/state/character.js';
import { createEmptyCharacter } from '../js/modules/characters/stateManager.js';
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  vi.clearAllMocks();
});
it('preserves the selected login method without treating it as an authenticated session', () => {
  expect(createEmptyCharacter().siteLogin).toEqual({ mode: 'standard' });
  const c = normalizeCharacter({ id: 'a', siteLogin: { mode: 'gamecenter' } });
  expect(c.siteLogin.mode).toBe('gamecenter');
  expect(c.isLoggedIn).not.toBe(true);
  expect(normalizeCharacter({ siteLogin: { mode: 'arbitrary' } }).siteLogin.mode).toBe('standard');
});
it('accepts only explicit HTTPS website/provider domains, never deceptive hosts or credentials', () => {
  expect(gameCenterSiteUrl('https://pwonline.ru/login?ticket=one-use')).toContain('ticket=one-use');
  for (const url of [
    'http://pwonline.ru/',
    'https://pwonline.ru.evil.test/',
    'https://evilpwonline.ru/',
    'https://user:pw@pwonline.ru/',
    'file:///x',
    'https://pwonline.ru:9999/'
  ])
    expect(gameCenterSiteUrl(url)).toBe('');
});
it('forwards a one-use URL only to the selected profile, clears the field and never marks login', async () => {
  const char = { id: 'a', nick: 'A', isLoggedIn: false };
  openGameCenterSitePilot(char);
  const input = document.querySelector('[data-gc-site-url]');
  input.value = 'https://pwonline.ru/login?ticket=SECRET';
  document.querySelector('[data-gc-site-open]').click();
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
  expect(mocks.open).toHaveBeenCalledWith('https://pwonline.ru/login?ticket=SECRET', char);
  expect(input.value).toBe('');
  expect(char.isLoggedIn).toBe(false);
  expect(document.querySelector('[data-gc-site-check]').disabled).toBe(true);
  expect(document.body.textContent).not.toContain('SECRET');
});
it('does not leak authorization links through navigation errors', async () => {
  mocks.open.mockRejectedValueOnce(new Error('https://pwonline.ru/?token=SECRET'));
  openGameCenterSitePilot({ id: 'a', nick: 'A' });
  document.querySelector('[data-gc-site-url]').value = 'https://pwonline.ru/?token=SECRET';
  document.querySelector('[data-gc-site-open]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-gc-site-status]').textContent).toContain('Не удалось'));
  expect(document.body.textContent).not.toContain('SECRET');
});
