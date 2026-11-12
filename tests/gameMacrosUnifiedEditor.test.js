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

it('starts with a simple empty plan and keeps advanced command settings optional', () => {
  openCommandEditor(config, save);
  expect(document.querySelector('.gm-editor-intro')).not.toBeNull();
  expect(document.querySelector('.gm-empty-plan').textContent).toContain('С чего начнём');
  // The empty state suggests actions, not a preselected key or an automatic input run.
  expect(document.querySelectorAll('[data-step]')).toHaveLength(0);
  expect(document.querySelector('.gm-editor-advanced').open).toBe(false);
  expect(document.querySelector('.gm-block-advanced').open).toBe(false);
});

it('saves and reopens an existing managed key command changed from all to except PL', async () => {
  const source = normalizeGameMacros({
    commands: [
      {
        id: 'edited',
        name: 'Клавиши',
        action: 'sequence',
        scope: 'managed',
        target: 'all',
        sequence: 'F2',
        returnTo: 'last'
      }
    ]
  }).commands[0];
  openCommandEditor(config, save, source);
  const target = document.querySelector('[data-field="target"]');
  target.value = 'others';
  target.dispatchEvent(new Event('change', { bubbles: true }));
  submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalled());
  const saved = normalizeGameMacros(save.mock.calls[0][0]).commands[0];
  expect(saved).toMatchObject({
    id: 'edited',
    scope: 'managed',
    target: 'others',
    allowManagedLeaderSplit: true,
    strictTargets: true,
    sequence: 'F2'
  });
  openCommandEditor(config, save, saved);
  expect(document.querySelector('[data-field="target"]').value).toBe('others');
});
it('saves a separate party-leader hybrid mode from the visible unified command settings', async () => {
  const source = normalizeGameMacros({
    commands: [
      {
        id: 'hybrid',
        name: 'Команда',
        action: 'sequence',
        target: 'others',
        scope: 'party',
        sequence: 'CTRL+1\nALT+2',
        hotkey: 'F8'
      }
    ]
  }).commands[0];
  config.commands = [source];
  openCommandEditor(config, save, source);
  const mode = document.querySelector('[name="commandInputMode"]');
  expect(mode.closest('.gm-editor-basics')).not.toBeNull();
  mode.value = 'hybrid-party';
  document.querySelector('[name="hybridConsent"]').checked = true;
  submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const saved = normalizeGameMacros(save.mock.calls[0][0]).commands[0];
  expect(saved).toMatchObject({
    action: 'sequence',
    delivery: 'background',
    backgroundMethod: 'hybrid-party',
    hybridConsent: true,
    target: 'others',
    sequence: 'CTRL+1\nALT+2',
    hotkey: 'F8'
  });
  openCommandEditor(config, save, saved);
  expect(document.querySelector('[name="commandInputMode"]').value).toBe('hybrid-party');
});
