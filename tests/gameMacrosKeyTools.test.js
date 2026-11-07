import { it, expect } from 'vitest';
import { insertKeyToken, actionHelp } from '../js/modules/gameMacros/editor.js';
it('toggles modifiers and replaces a trigger key instead of appending a second key', () => {
  const input = document.createElement('input');
  input.name = 'hotkey';
  input.value = 'CTRL+F8';
  insertKeyToken(input, 'SHIFT');
  expect(input.value).toBe('CTRL+SHIFT+F8');
  insertKeyToken(input, 'F7');
  expect(input.value).toBe('CTRL+SHIFT+F7');
  insertKeyToken(input, 'CTRL');
  expect(input.value).toBe('SHIFT+F7');
});
it('inserts a pause as a separate sequence step', () => {
  const input = document.createElement('textarea');
  input.name = 'sequence';
  input.value = 'F7';
  input.setSelectionRange(2, 2);
  insertKeyToken(input, 'wait 100');
  expect(input.value).toBe('F7\nwait 100');
});
it('explains every offered action', () => {
  expect(Object.keys(actionHelp)).toHaveLength(15);
  expect(actionHelp.click).toContain('предпросмотр');
});

it('reports the actual blocker in Russian and does not include arbitrary native error details', async () => {
  const { macroErrorText } = await import('../js/modules/gameMacros/runtime.js');
  expect(macroErrorText('preview required')).toContain('Предпросмотр без клика');
  expect(macroErrorText('Release modifier keys and retry')).toContain('отпустите Ctrl');
  expect(macroErrorText(new Error('private path/token'))).not.toContain('private path');
});

it('edits only the current sequence step and creates a key step after a pause', () => {
  const input = document.createElement('textarea');
  input.name = 'sequence';
  input.value = 'F8\nF1';
  input.setSelectionRange(1, 1);
  insertKeyToken(input, 'SHIFT');
  insertKeyToken(input, 'F7');
  expect(input.value).toBe('SHIFT+F7\nF1');
  insertKeyToken(input, 'wait 100');
  expect(input.value).toBe('SHIFT+F7\nwait 100\nF1');
  insertKeyToken(input, 'F8');
  expect(input.value).toBe('SHIFT+F7\nwait 100\nF8\nF1');
});
