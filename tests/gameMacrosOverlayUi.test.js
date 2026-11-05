import { beforeEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), drag: vi.fn(), close: vi.fn() }));
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
  vi.doMock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
  vi.doMock('@tauri-apps/api/event', () => ({ listen: async () => () => {}, emitTo: async () => {} }));
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
it('uses the native navigation bridge for header stop and content settings', async () => {
  document.querySelector('header [data-action="stop"]').click();
  document.querySelector('[data-action="overlay-settings"]').click();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'stop' }));
  expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'overlay-settings' });
});
