import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => {}),
  check: vi.fn(async () => {}),
  invoke: vi.fn(),
  listener: null,
  unlisten: vi.fn()
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name, callback) => {
    mocks.listener = callback;
    return mocks.unlisten;
  })
}));
vi.mock('../js/core/linkBrowser.js', () => ({ openCharacterWebLink: mocks.open }));
vi.mock('../js/modules/sync/syncManager.js', () => ({ refreshAuthFor: mocks.check }));
import { gameCenterSiteUrl, openGameCenterSitePilot } from '../js/modules/characters/gameCenterSite.js';
import { normalizeCharacter } from '../js/core/state/character.js';
import { state } from '../js/core/state.js';
import { createEmptyCharacter } from '../js/modules/characters/stateManager.js';
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  vi.clearAllMocks();
  mocks.invoke.mockReset();
  mocks.listener = null;
  state.settings.launcher = {
    gameCenters: [{ id: 'gc-1', name: 'Основной', path: 'C:\\GameCenter\\GameCenter.exe' }],
    preferredGcId: 'gc-1'
  };
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

const boundChar = () => ({
  id: 'a',
  nick: 'A',
  isLoggedIn: false,
  launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick: 'A' } } }
});
it('starts a scoped wait using the saved vault key, never a URL or token, then checks auth', async () => {
  mocks.invoke.mockImplementation(async name => {
    if (name === 'gc_site_login_wait') return 'opened';
    return true;
  });
  const char = boundChar();
  openGameCenterSitePilot(char);
  document.querySelector('[data-gc-site-start]').click();
  await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledWith(char));
  const [name, args] = mocks.invoke.mock.calls[0];
  expect(name).toBe('gc_site_login_wait');
  expect(args).toMatchObject({ charId: 'a', charNick: 'A', accountKey: 'a@gc-1' });
  expect(Object.keys(args).sort()).toEqual(['accountKey', 'charId', 'charNick', 'requestId']);
  expect(mocks.open).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('ID ссылки совпал');
});
it('shows wrong-account result without opening or silently replacing a binding', async () => {
  mocks.invoke.mockRejectedValue('wrong_account');
  const char = boundChar();
  openGameCenterSitePilot(char);
  document.querySelector('[data-gc-site-start]').click();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-gc-site-status]').textContent).toContain('неправильный аккаунт')
  );
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.check).not.toHaveBeenCalled();
  expect(char.launch.gcAccounts['gc-1'].nick).toBe('A');
});
it('close cancels an active native wait and removes ready listener', async () => {
  let finish;
  mocks.invoke.mockImplementation((name, args) =>
    name === 'gc_site_login_wait'
      ? new Promise(resolve => {
          finish = resolve;
          mocks.listener({ payload: args.requestId });
        })
      : Promise.resolve(true)
  );
  const overlay = openGameCenterSitePilot(boundChar());
  document.querySelector('[data-gc-site-start]').click();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
  expect(document.querySelector('[data-gc-site-status]').textContent).toContain('30 с');
  overlay.close();
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([name]) => name === 'gc_site_login_cancel')).toBe(true));
  finish('opened');
  await Promise.resolve();
  expect(mocks.check).not.toHaveBeenCalled();
  expect(mocks.unlisten).toHaveBeenCalled();
});
it('disables automatic waiting when no saved GameCenter login exists', () => {
  openGameCenterSitePilot({ id: 'a', nick: 'A' });
  expect(document.querySelector('[data-gc-site-start]').disabled).toBe(true);
});
it('does not surface raw native errors containing an authorization URL', async () => {
  mocks.invoke.mockRejectedValue('https://auth-ac.vkplay.ru/?token=SECRET');
  openGameCenterSitePilot(boundChar());
  document.querySelector('[data-gc-site-start]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-gc-site-status]').textContent).toContain('Не удалось'));
  expect(document.body.textContent).not.toContain('SECRET');
});
