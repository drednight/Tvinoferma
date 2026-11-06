import { beforeEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), drag: vi.fn(), close: vi.fn(), handlers: new Map() }));
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
  vi.doMock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
  vi.doMock('@tauri-apps/api/event', () => ({
    listen: async (name, handler) => {
      mocks.handlers.set(name, handler);
      return () => {};
    },
    emitTo: async () => {}
  }));
  vi.doMock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ startDragging: mocks.drag, close: mocks.close })
  }));
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    readFileSync('game-overlay.html', 'utf8'),
    'text/html'
  ).documentElement.innerHTML;
  await import('../js/modules/gameMacros/overlay.js');
  await vi.waitFor(() => expect(document.querySelector('#fold').onclick).toBeTypeOf('function'));
});
it('collapses the native window to its header and restores its content', async () => {
  const fold = document.querySelector('#fold');
  fold.click();
  await vi.waitFor(() => expect(document.body.classList.contains('folded')).toBe(true));
  expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay_fold', { collapsed: true });
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('header [data-action="stop"]')).not.toBeNull();
  fold.click();
  await vi.waitFor(() => expect(document.body.classList.contains('folded')).toBe(false));
  expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay_fold', { collapsed: false });
  expect(fold.getAttribute('aria-expanded')).toBe('true');
});
it('keeps content visible when native collapse fails', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('Denied'));
  document.querySelector('#fold').click();
  await vi.waitFor(() => expect(document.querySelector('#status').textContent).toContain('Не удалось изменить размер'));
  expect(document.body.classList.contains('folded')).toBe(false);
  expect(document.querySelector('#fold').disabled).toBe(false);
});
it('does not start window dragging when a header button is pressed', () => {
  const button = document.querySelector('#fold');
  const event = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(event, 'button', { value: 0 });
  button.dispatchEvent(event);
  expect(mocks.drag).not.toHaveBeenCalled();
  document.querySelector('header span').dispatchEvent(event);
  expect(mocks.drag).toHaveBeenCalledTimes(1);
});
it('keeps settings and journal inside the overlay with a return button', async () => {
  document.querySelector('header [data-action="stop"]').click();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'stop' }));
  mocks.invoke.mockClear();
  document.querySelector('[data-view="appearance"]').click();
  expect(document.querySelector('#appearance-screen').hidden).toBe(false);
  expect(document.querySelector('#shortcuts-screen').hidden).toBe(true);
  document.querySelector('#back').click();
  expect(document.querySelector('#shortcuts-screen').hidden).toBe(false);
  document.querySelector('[data-view="journal"]').click();
  expect(document.querySelector('#journal-screen').hidden).toBe(false);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(document.querySelectorAll('[data-action="stop"]')).toHaveLength(1);
  expect(document.querySelector('[data-action="settings"]')).toBeNull();
});
it('hides the service panel without hiding assigned shortcuts', () => {
  document.querySelector('#info-toggle').click();
  expect(document.querySelector('#overlay-controls').hidden).toBe(true);
  expect(document.querySelector('#shortcuts-screen').hidden).toBe(false);
  document.querySelector('#info-toggle').click();
  expect(document.querySelector('#overlay-controls').hidden).toBe(false);
});
it('saves overlay appearance without opening the main app', async () => {
  document.querySelector('[data-view="appearance"]').click();
  document.querySelector('#opacity').value = '55';
  document.querySelector('#topmost').checked = false;
  document.querySelector('#save-appearance').click();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay_preferences', { opacity: 0.55, topmost: false })
  );
});

it('can hide and restore the journal return control without leaving the journal', () => {
  document.querySelector('[data-view="journal"]').click();
  expect(document.querySelector('#back').hidden).toBe(false);
  document.querySelector('#back-hide').click();
  expect(document.querySelector('#back').hidden).toBe(true);
  expect(document.querySelector('#journal-screen').hidden).toBe(false);
  document.querySelector('#back-hide').click();
  expect(document.querySelector('#back').hidden).toBe(false);
  expect(document.querySelector('#opacity').min).toBe('10');
});

it('puts the latest log entry first and keeps long command names in a separate element from their key', () => {
  mocks.handlers.get('game-macro-snapshot')({
    payload: {
      commands: [{ name: 'Очень длинное имя '.repeat(10), hotkey: 'CTRL+ALT+F8' }],
      logs: ['первое действие', 'последнее действие'],
      opacity: 0.1
    }
  });
  expect(document.querySelector('#logs').textContent.split('\n')[0]).toBe('последнее действие');
  expect(document.querySelector('#commands li span').textContent).toContain('Очень длинное');
  expect(document.querySelector('#commands li kbd').textContent).toBe('CTRL+ALT+F8');
});
