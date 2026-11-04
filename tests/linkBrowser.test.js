import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: mocks.open }));
import { state } from '../js/core/state.js';
import { DEFAULT_SETTINGS } from '../js/core/constants.js';
import { webLink, linkProfile, linkProfileOptions, openWebLink, bindWebLinks } from '../js/core/linkBrowser.js';
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.open.mockReset().mockResolvedValue(undefined);
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

it('opens the OS default browser only when explicitly selected, without character credentials or IPC', async () => {
  state.settings.browser = { linkOpenMode: 'system', linkCharacterId: 'bob' };
  await openWebLink('https://pwonline.ru/news.php?article=1');
  expect(mocks.open).toHaveBeenCalledWith('https://pwonline.ru/news.php?article=1');
  expect(mocks.invoke).not.toHaveBeenCalled();
  await expect(openWebLink('javascript:alert(1)')).rejects.toThrow();
  expect(mocks.open).toHaveBeenCalledTimes(1);
});
it('does not silently open a WebView when the system browser fails', async () => {
  state.settings.browser.linkOpenMode = 'system';
  mocks.open.mockRejectedValueOnce(new Error('OS failure'));
  await expect(openWebLink('https://example.com/')).rejects.toThrow('OS failure');
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('persists system mode, defaults old or invalid settings to WebView, and allows switching back', async () => {
  const { mergeSettings } = await import('../js/core/state/settings.js');
  expect(DEFAULT_SETTINGS.browser.linkOpenMode).toBe('webview');
  expect(mergeSettings({ browser: { linkOpenMode: 'system' } }).browser.linkOpenMode).toBe('system');
  expect(mergeSettings({ browser: { linkOpenMode: 'other' } }).browser.linkOpenMode).toBe('webview');
  expect(mergeSettings({}).browser.linkOpenMode).toBe('webview');
  state.settings.browser = { linkOpenMode: 'webview', linkCharacterId: 'alice' };
  await openWebLink('https://example.com/');
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith('open_link_browser', {
    url: 'https://example.com/',
    charId: 'alice',
    charNick: 'Алиса'
  });
});
