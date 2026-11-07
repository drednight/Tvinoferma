import { it, expect, vi } from 'vitest';
import { mountRecorder, eventChord } from '../js/modules/gameMacros/recorder.js';
const key = (host, code) => host.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
it('uses physical key codes and excludes OS shortcuts', () => {
  expect(eventChord({ code: 'Digit1', shiftKey: true })).toBe('SHIFT+1');
  expect(eventChord({ code: 'KeyA', key: 'ф', ctrlKey: true })).toBe('CTRL+A');
  expect(eventChord({ code: 'F4', altKey: true })).toBe('');
});
it('is local, orders asynchronous pointer samples before subsequent keys, and ignores events after Stop', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  let resolve;
  const cursor = vi.fn(() => new Promise(r => (resolve = r))),
    onRecorded = vi.fn();
  const dispose = mountRecorder(host, { cursor, onRecorded });
  const area = host.querySelector('[data-record-area]');
  host.querySelector('[data-record-start]').click();
  key(document, 'F5');
  area.dispatchEvent(new MouseEvent('pointerdown', { button: 2, ctrlKey: true, bubbles: true }));
  key(area, 'F8');
  await vi.waitFor(() => expect(cursor).toHaveBeenCalledTimes(1));
  host.querySelector('[data-record-stop]').click();
  key(area, 'F9');
  resolve({ x: 20, y: -10 });
  await vi.waitFor(() => expect(onRecorded).toHaveBeenCalledOnce());
  expect(onRecorded.mock.calls[0][0].filter(s => s.type !== 'wait')).toEqual([
    { type: 'screen', button: 'right', count: 1, x: 20, y: -10, modifiers: ['CTRL'] },
    { type: 'keys', value: 'F8' }
  ]);
  dispose();
  host.remove();
});
it('cancels queued samples on disposal and reports cursor failures without global capture', async () => {
  const host = document.createElement('div'),
    onRecorded = vi.fn();
  let resolve;
  const dispose = mountRecorder(host, { cursor: () => new Promise(r => (resolve = r)), onRecorded });
  host.querySelector('[data-record-start]').click();
  host.querySelector('[data-record-area]').dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  dispose();
  resolve({ x: 1, y: 2 });
  await Promise.resolve();
  expect(onRecorded).not.toHaveBeenCalled();
});
