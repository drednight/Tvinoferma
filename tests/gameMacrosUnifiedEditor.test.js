import { beforeEach, it, expect, vi } from 'vitest';
import { openCommandEditor } from '../js/modules/gameMacros/editor.js';
import { normalizeGameMacros } from '../js/modules/gameMacros/model.js';
import { state } from '../js/core/state.js';
let config, save;
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  state.parties = [{ id: 'p', name: 'Пати' }];
  state.characters = [
    { id: 'a', nick: 'Лидер', partyIds: ['p'] },
    { id: 'b', nick: 'Жрец', partyIds: ['p'] }
  ];
  config = normalizeGameMacros({ partyId: 'p', leaders: { p: 'a' }, commands: [] });
  save = vi.fn(async () => {});
});
const submit = () => document.querySelector('.modal-footer .primary').click();
it('opens existing finite macros as ordinary editable blocks and leaves source data untouched until Save', () => {
  const source = normalizeGameMacros({
    commands: [
      {
        id: 'follow',
        name: 'Следование',
        action: 'follow',
        target: 'others',
        followSequence: 'F2',
        pointId: 'portrait',
        menuPointId: 'menu',
        resourceAllowed: true
      }
    ]
  }).commands[0];
  const before = structuredClone(source);
  openCommandEditor(config, save, source);
  expect(document.querySelector('.gm-action-picker').hidden).toBe(true);
  expect(document.querySelectorAll('[data-step]')).toHaveLength(5);
  expect(document.querySelector('[data-step="0"] [data-field="value"]').value).toBe('F2');
  expect(document.querySelector('[data-field="perWindow"]').checked).toBe(true);
  expect(source).toEqual(before);
  expect(save).not.toHaveBeenCalled();
});
it('saves the activity transport from the unified editor as an isolated keyboard sequence', async () => {
  const source = normalizeGameMacros({
    commands: [
      {
        id: 'activity',
        name: 'Фон',
        action: 'sequence',
        target: 'all',
        delivery: 'background',
        backgroundMethod: 'activity',
        sequence: 'SHIFT+1\nwait 200\nF2'
      }
    ]
  }).commands[0];
  config.commands = [source];
  openCommandEditor(config, save, source);
  expect(document.querySelector('[data-field="backgroundMethod"]').value).toBe('activity');
  submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].commands[0]).toMatchObject({
    id: 'activity',
    action: 'sequence',
    sequence: source.sequence,
    delivery: 'background',
    backgroundMethod: 'activity'
  });
});
it('rejects mouse or mode steps in an activity plan at Save, without changing stored commands', async () => {
  const source = normalizeGameMacros({
    commands: [
      {
        id: 'activity',
        name: 'Фон',
        action: 'sequence',
        target: 'all',
        delivery: 'background',
        backgroundMethod: 'activity',
        sequence: 'F2'
      }
    ]
  }).commands[0];
  config.commands = [source];
  openCommandEditor(config, save, source);
  // A global mode change is incompatible with a per-window keyboard block.
  const perWindow = document.querySelector('[data-field="perWindow"]');
  perWindow.checked = false;
  perWindow.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('[data-add-type="repeat"]').click();
  submit();
  await vi.waitFor(() => expect(document.querySelector('[data-gm-form-error]').hidden).toBe(false));
  expect(save).not.toHaveBeenCalled();
  expect(config.commands[0].action).toBe('sequence');
});
it('keeps the service pause/resume command editable without treating it as a finite waiting macro', async () => {
  const source = normalizeGameMacros({ commands: [{ id: 'pause', name: 'Пауза', action: 'pause' }] }).commands[0];
  config.commands = [source];
  openCommandEditor(config, save, source);
  submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].commands[0]).toMatchObject({ id: 'pause', action: 'pause' });
});
