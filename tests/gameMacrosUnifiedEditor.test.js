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
  expect(document.querySelector('.gm-editor-advanced').tagName).toBe('SECTION');
  expect(document.querySelector('.gm-block-advanced').tagName).toBe('SECTION');
});

it('shows automatic configuration review and prominently requires consent when a mouse step is added', async () => {
  openCommandEditor(config, save);
  const form = document.querySelector('[data-gm-form]');
  expect(form.querySelector('.gm-editor-checks').open).toBe(true);
  const consent = form.querySelector('[name="compositeConsent"]');
  expect(consent.closest('label').hidden).toBe(true);
  form.elements.namedItem('name').value = 'Мышь';
  form.querySelector('[data-add-type="screen"]').click();
  expect(consent.closest('label').hidden).toBe(false);
  expect(consent.closest('label').textContent).toContain('возможный расход');
  expect(consent.checked).toBe(false);
  submit();
  await vi.waitFor(() => expect(document.querySelector('[data-gm-form-error]').hidden).toBe(false));
  expect(save).not.toHaveBeenCalled();
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
it('converts a saved party-hybrid sequence to active delivery when edited', async () => {
  const source = normalizeGameMacros({
    commands: [
      {
        id: 'hybrid',
        name: 'Команда',
        action: 'sequence',
        target: 'others',
        scope: 'party',
        delivery: 'background',
        backgroundMethod: 'hybrid-party',
        hybridConsent: true,
        sequence: 'CTRL+1\nALT+2',
        hotkey: 'F8'
      }
    ]
  }).commands[0];
  config.commands = [source];
  openCommandEditor(config, save, source);
  const mode = document.querySelector('[name="commandInputMode"]');
  expect([...mode.options].map(option => option.value)).toEqual(['standard']);
  expect(mode.value).toBe('standard');
  expect(document.querySelector('[name="hybridConsent"]')).toBeNull();
  submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const saved = normalizeGameMacros(save.mock.calls[0][0]).commands[0];
  expect(saved).toMatchObject({
    action: 'sequence',
    delivery: 'foreground',
    backgroundMethod: 'post',
    hybridConsent: false,
    target: 'others',
    sequence: 'CTRL+1\nALT+2',
    hotkey: 'F8'
  });
});

it('saves the assist example with the requested keys and party except the leader', async () => {
  openCommandEditor(config, save);
  document.querySelector('[data-preset="assist"]').click();
  expect(document.querySelector('[name="name"]').value).toBe('Ассист');
  expect(document.querySelector('[name="hotkey"]').value).toBe('');
  expect(save).not.toHaveBeenCalled();
  submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].commands[0]).toMatchObject({
    name: 'Ассист',
    action: 'sequence',
    sequence: 'SHIFT+1\nwait 100\nF2',
    scope: 'party',
    target: 'others',
    delivery: 'foreground',
    hotkey: ''
  });
});

it('does not overwrite a typed command name when applying an example', () => {
  openCommandEditor(config, save);
  const name = document.querySelector('[name="name"]');
  name.value = 'Своя команда';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('[data-preset="buff"]').click();
  expect(name.value).toBe('Своя команда');
  expect(save).not.toHaveBeenCalled();
});

it('offers only active mode for new plans and saves a normal editable composition', async () => {
  openCommandEditor(config, save);
  const form = document.querySelector('[data-gm-form]');
  const mode = form.elements.namedItem('commandInputMode');
  expect(mode.closest('.gm-editor-basics')).not.toBeNull();
  expect([...mode.options].map(option => option.value)).toEqual(['standard']);
  expect(mode.value).toBe('standard');
  expect(form.elements.namedItem('hybridConsent')).toBeNull();
  form.elements.namedItem('name').value = 'Ассист';
  form.querySelector('[data-add-type="keys"]').click();
  const key = form.querySelector('[data-step="0"] [data-field="value"]');
  key.value = 'SHIFT+1';
  key.dispatchEvent(new Event('input', { bubbles: true }));
  submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const saved = save.mock.calls[0][0].commands[0];
  expect(saved).toMatchObject({
    name: 'Ассист',
    action: 'composite',
    delivery: 'foreground',
    blocks: [{ delivery: 'foreground', steps: [{ type: 'keys', value: 'SHIFT+1' }] }]
  });
});

it('preserves existing background transport unless active mode is explicitly selected', async () => {
  const source = normalizeGameMacros({
    commands: [
      {
        id: 'old',
        name: 'Старый фон',
        action: 'sequence',
        delivery: 'background',
        backgroundMethod: 'activity-notify',
        target: 'all',
        sequence: 'F2'
      }
    ]
  }).commands[0];
  config.commands = [source];
  openCommandEditor(config, save, source);
  const mode = document.querySelector('[name="commandInputMode"]');
  expect(mode.value).toBe('legacy');
  mode.value = 'standard';
  mode.dispatchEvent(new Event('change', { bubbles: true }));
  submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].commands[0]).toMatchObject({ delivery: 'foreground', sequence: 'F2' });
});

it('shows the active delivery plan in review without executing it', async () => {
  openCommandEditor(config, save);
  const form = document.querySelector('[data-gm-form]');
  form.elements.namedItem('name').value = 'Тест';
  form.querySelector('[data-add-type="keys"]').click();
  const key = form.querySelector('[data-field="value"]');
  key.value = 'F2';
  key.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-editor-review]').textContent).toContain('с активацией окна')
  );
  expect(save).not.toHaveBeenCalled();
});

it('does not apply the legacy eight-step hybrid limit to active compositions', async () => {
  openCommandEditor(config, save);
  const form = document.querySelector('[data-gm-form]');
  form.elements.namedItem('name').value = 'Длинная';
  for (let i = 0; i < 9; i++) {
    form.querySelector('[data-add-type="keys"]').click();
    const key = form.querySelector(`[data-step="${i}"] [data-field="value"]`);
    key.value = 'F2';
    key.dispatchEvent(new Event('input', { bubbles: true }));
  }
  expect(form.querySelector('[data-add-type="keys"]').disabled).toBe(false);
  submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].commands[0].blocks[0].steps).toHaveLength(9);
});

it('keeps active editing controls available and no longer renders hybrid-only restrictions', () => {
  openCommandEditor(config, save);
  const form = document.querySelector('[data-gm-form]');
  const mode = form.elements.namedItem('commandInputMode');
  expect([...mode.options].map(option => option.value)).toEqual(['standard']);
  form.querySelector('[data-add-type="screen"]').click();
  expect(form.querySelector('[data-add-type="screen"]').hidden).toBe(false);
  expect(form.querySelector('.gm-more-library').hidden).toBe(false);
  expect(form.querySelector('[data-block-add]').hidden).toBe(false);
  expect(form.querySelector('[data-field="perWindow"]').closest('label').hidden).toBe(false);
  expect(form.querySelector('[data-field="scope"]').closest('label').hidden).toBe(false);
  expect(form.querySelector('[data-field="delivery"]').closest('label').hasAttribute('data-gm-legacy-delivery')).toBe(
    true
  );
  expect(form.querySelector('[data-field="repeat"]').closest('label').hidden).toBe(false);
  expect(form.querySelector('[data-step-type="screen"]')).not.toBeNull();
  expect(form.querySelector('[data-hybrid-plan-warning]')).toBeNull();
});
