import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import { state } from '../js/core/state.js';
import { DEFAULT_SETTINGS } from '../js/core/constants.js';
import { webLink, linkProfile, linkProfileOptions, openWebLink, bindWebLinks } from '../js/core/linkBrowser.js';
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  window.__TAURI_INTERNALS__ = {};
  state.characters = [
    { id: 'alice', nick: 'Алиса' },
    { id: 'bob', nick: '<Боб>' }
  ];
  state.settings.browser = { linkCharacterId: '' };
  document.body.innerHTML = '';
});
it('defaults to no character, never implicitly uses the first account', async () => {
  expect(DEFAULT_SETTINGS.browser.linkCharacterId).toBe('');
  await openWebLink('https://pwonline.ru/news.php?article=1');
  expect(mocks.invoke).toHaveBeenCalledWith('open_link_browser', {
    url: 'https://pwonline.ru/news.php?article=1',
    charId: null,
    charNick: null
  });
});
it('uses only the explicitly selected active character and safely falls back if removed', () => {
  state.settings.browser.linkCharacterId = 'bob';
  expect(linkProfile()).toEqual({ charId: 'bob', charNick: '<Боб>' });
  expect(linkProfileOptions()).toContain('&lt;Боб&gt;');
  state.characters = state.characters.filter(c => c.id !== 'bob');
  expect(linkProfile()).toEqual({ charId: null, charNick: null });
  expect(linkProfileOptions()).toContain('Персонаж недоступен');
});
it('rejects unsafe URLs before IPC', async () => {
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
    'https://user:pass@example.com',
    '../relative'
  ]) {
    expect(webLink(url)).toBeNull();
    await expect(openWebLink(url)).rejects.toThrow();
  }
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('captures dynamically inserted external anchors, without duplicate binding or main-window navigation', async () => {
  bindWebLinks();
  bindWebLinks();
  document.body.innerHTML = '<a href="https://example.com/path" target="_blank"><span>Link</span></a>';
  document.querySelector('span').click();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
});
it('leaves application routes and downloads to their dedicated handlers', () => {
  bindWebLinks();
  document.body.innerHTML = '<a href="#help">Help</a><a download href="https://example.com/file">Download</a>';
  // Prevent jsdom navigation only; the capture handler itself must not cancel these.
  document.querySelectorAll('a').forEach(a =>
    a.addEventListener('click', e => {
      expect(e.defaultPrevented).toBe(false);
      e.preventDefault();
    })
  );
  document.querySelectorAll('a').forEach(a => a.click());
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('also routes middle clicks without navigating the main window', async () => {
  bindWebLinks();
  document.body.innerHTML = '<a href="https://example.com/middle">Link</a>';
  const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
  document.querySelector('a').dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
});
it('preserves the explicit setting through normalization and defaults invalid values', async () => {
  const { mergeSettings } = await import('../js/core/state/settings.js');
  expect(mergeSettings({ browser: { linkCharacterId: 'bob' } }).browser.linkCharacterId).toBe('bob');
  expect(mergeSettings({ browser: { linkCharacterId: 123 } }).browser.linkCharacterId).toBe('');
});
