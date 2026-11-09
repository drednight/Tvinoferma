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
it('combined repeat is opt-in and rejects unknown methods', () => {
  expect(normalizeGameMacros({}).mirrorKeyboardMethod).toBe('post');
  expect(normalizeGameMacros({ mirrorKeyboardMethod: 'combined' }).mirrorKeyboardMethod).toBe('combined');
  expect(normalizeGameMacros({ mirrorKeyboardMethod: 'activity' }).mirrorKeyboardMethod).toBe('post');
});

it('supports activity-only repeat and opt-in hold-only independently', () => {
  expect(normalizeGameMacros({ mirrorKeyboardMethod: 'activity-notify', mirrorHoldOnly: true })).toMatchObject({
    mirrorKeyboardMethod: 'activity-notify',
    mirrorHoldOnly: true
  });
  expect(normalizeGameMacros({}).mirrorHoldOnly).toBe(false);
});
