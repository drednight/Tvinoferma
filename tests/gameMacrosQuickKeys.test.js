import { it, expect } from 'vitest';
import { addQuickModifier, applyQuickModifier } from '../js/modules/gameMacros/quickKeys.js';
import { normalizeGameMacros } from '../js/modules/gameMacros/model.js';
it('adds quick modifiers to empty and complete chords without duplication', () => {
  expect(addQuickModifier('', 'SHIFT')).toBe('SHIFT+');
  expect(addQuickModifier('SHIFT+', 'SHIFT')).toBe('SHIFT+');
  expect(addQuickModifier('1', 'SHIFT')).toBe('SHIFT+1');
  expect(addQuickModifier('SHIFT+1', 'CTRL')).toBe('CTRL+SHIFT+1');
});
it('updates the field via input event without sending game input', () => {
  const input = document.createElement('input');
  input.value = '1';
  let edits = 0;
  input.oninput = () => edits++;
  applyQuickModifier(input, 'SHIFT');
  expect(input.value).toBe('SHIFT+1');
  expect(edits).toBe(1);
});
it('uses one repeat transport and keeps global input disabled unless explicitly opted in', () => {
  expect(normalizeGameMacros({})).toMatchObject({
    mirrorKeyboardMethod: 'cache-hybrid',
    mirrorKeyboardGlobalInput: false,
    mirrorMouseGlobalInput: false
  });
  expect(normalizeGameMacros({ mirrorKeyboardMethod: 'post' })).toMatchObject({
    mirrorKeyboardMethod: 'cache-hybrid',
    mirrorKeyboardGlobalInput: false
  });
  expect(normalizeGameMacros({ mirrorKeyboardMethod: 'cache-hybrid' }).mirrorKeyboardGlobalInput).toBe(true);
  expect(
    normalizeGameMacros({ mirrorKeyboardMethod: 'cache-hybrid', mirrorKeyboardGlobalInput: false })
      .mirrorKeyboardGlobalInput
  ).toBe(false);
  expect(normalizeGameMacros({ mirrorMouseGlobalInput: true }).mirrorMouseGlobalInput).toBe(true);
});

it('keeps the global-input candidate opt-in and rejects unknown keyboard methods', () => {
  expect(normalizeGameMacros({ mirrorKeyboardMethod: 'cache-hybrid' }).mirrorKeyboardMethod).toBe('cache-hybrid');
  expect(normalizeGameMacros({ mirrorKeyboardMethod: 'cache' }).mirrorKeyboardMethod).toBe('cache-hybrid');
});
