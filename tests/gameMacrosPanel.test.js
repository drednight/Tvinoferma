import { beforeEach, describe, it, expect, vi } from 'vitest';
import { state } from '../js/core/state.js';
import { mountGameMacros } from '../js/modules/gameMacros/panel.js';
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));
vi.mock('../js/modules/gameMacros/runtime.js', async () => {
  const { normalizeGameMacros } = await import('../js/modules/gameMacros/model.js');
  const { state } = await import('../js/core/state.js');
  return {
    config: () => normalizeGameMacros(state.settings.gameMacros),
    configure: vi.fn(async () => {}),
    initGameMacros: vi.fn(async () => {}),
    snapshot: () => ({ logs: ['Test log'], busy: false, registered: false }),
    openOverlay: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    saveProfile: vi.fn()
  };
});
describe('game macros Tools block', () => {
  beforeEach(() => {
    state.parties = [{ id: 'p', name: 'Existing party' }];
    state.settings.gameMacros = { commands: [{ id: 'next', name: '<unsafe>', action: 'next', hotkey: 'CTRL+ALT+F8' }] };
    document.body.innerHTML = '<div id="host"></div>';
    mountGameMacros(document.getElementById('host'));
  });
  it('shows an independent block, explicit party choice, transparency, overlay, stop and factual log', () => {
    expect(document.getElementById('game-macros-block')).not.toBeNull();
    expect(document.querySelector('[data-gm-party]').value).toBe('');
    expect(document.querySelector('[data-gm-enabled]').checked).toBe(false);
    expect(document.querySelector('[data-gm-opacity]')).not.toBeNull();
    expect(document.querySelector('[data-gm-overlay]')).not.toBeNull();
    expect(document.querySelector('[data-gm-stop]')).not.toBeNull();
    expect(document.querySelector('#game-macro-log').textContent).toBe('Test log');
    expect(document.querySelector('unsafe')).toBeNull();
    expect(document.body.textContent).toContain('<unsafe>');
    expect(document.body.textContent).toContain('CTRL+ALT+F8');
  });
  it('loads a saved command into the editor without confusing trigger with sequence', () => {
    document.querySelector('[data-gm-edit]').click();
    const form = document.querySelector('[data-gm-form]');
    expect(form.elements.namedItem('hotkey').value).toBe('CTRL+ALT+F8');
    expect(form.elements.namedItem('sequence').value).toBe('F8');
    expect(document.querySelector('[data-gm-editor]').open).toBe(true);
  });
});

describe('action-specific editor', () => {
  const choose = (name, value) => {
    const form = document.querySelector('[data-gm-form]');
    form.elements.namedItem(name).value = value;
    form.dispatchEvent(new Event('change', { bubbles: true }));
  };
  beforeEach(() => {
    state.parties = [];
    state.settings.gameMacros = {};
    document.body.innerHTML = '<div id="host"></div>';
    mountGameMacros(document.getElementById('host'));
  });
  it('uses choice cards and only reveals relevant fields', () => {
    expect(document.querySelectorAll('.gm-action-choices input[type="radio"]').length).toBe(11);
    expect(document.querySelector('[data-gm-click-field]').hidden).toBe(true);
    expect(document.querySelector('[data-gm-sequence-field]').hidden).toBe(true);
    expect(document.querySelector('[data-gm-subset]').hidden).toBe(true);
    choose('action', 'sequence');
    expect(document.querySelector('[data-gm-sequence-field]').hidden).toBe(false);
    choose('target', 'subset');
    expect(document.querySelector('[data-gm-subset]').hidden).toBe(false);
    choose('action', 'click');
    expect(document.querySelector('[data-gm-click-field]').hidden).toBe(false);
    expect(document.querySelector('[data-gm-sequence-field]').hidden).toBe(true);
    choose('action', 'leader');
    expect(document.querySelector('[data-gm-targets]').hidden).toBe(true);
    expect(document.querySelector('[data-gm-subset]').hidden).toBe(true);
  });
  it('cancels the draft and resets the action', () => {
    choose('action', 'click');
    document.querySelector('[data-gm-editor]').open = true;
    document.querySelector('[data-gm-cancel]').click();
    expect(document.querySelector('[data-gm-editor]').open).toBe(false);
    expect(document.querySelector('[data-gm-form]').elements.namedItem('action').value).toBe('next');
    expect(document.querySelector('[data-gm-click-field]').hidden).toBe(true);
  });
});
