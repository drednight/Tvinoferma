import { it, expect, vi } from 'vitest';
import { mountCompositionEditor } from '../js/modules/gameMacros/compositionEditor.js';
import { state } from '../js/core/state.js';
vi.mock('../js/modules/gameMacros/recorder.js', () => ({ mountRecorder: () => () => {} }));
it('keeps action controls together and can reorder, edit and delete steps', () => {
  state.parties = [];
  state.characters = [];
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const editor = mountCompositionEditor(
    host,
    { partyId: '', commands: [], points: [], profiles: [] },
    {
      blocks: [
        {
          name: 'План',
          scope: 'all',
          target: 'all',
          delivery: 'foreground',
          steps: [
            { type: 'keys', value: 'F1' },
            { type: 'wait', ms: 100 }
          ]
        }
      ]
    },
    { cursor: vi.fn(), newPoint: vi.fn() }
  );
  expect(host.querySelectorAll('.gm-step-actions')).toHaveLength(2);
  expect(host.querySelector('[data-step-up]').disabled).toBe(true);
  expect(host.querySelector('[data-step="1"] [data-step-down]').disabled).toBe(true);
  host.querySelector('[data-step-down]').click();
  expect(editor.read()[0].steps.map(s => s.type)).toEqual(['wait', 'keys']);
  host.querySelector('[data-step="1"] [data-step-up]').click();
  expect(editor.read()[0].steps.map(s => s.type)).toEqual(['keys', 'wait']);
  const input = host.querySelector('[data-step="0"] [data-field="value"]');
  input.value = 'F2';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  expect(editor.read()[0].steps[0].value).toBe('F2');
  host.querySelector('[data-step="1"] [data-step-delete]').click();
  expect(editor.read()[0].steps).toHaveLength(1);
  expect(editor.read()[0].steps[0].value).toBe('F2');
  editor.dispose();
});

it('offers an action library, duplicates steps, undoes deletion and collapses blocks without losing edits', () => {
  state.parties = [];
  state.characters = [];
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const editor = mountCompositionEditor(host, { partyId: '', commands: [], points: [], profiles: [] }, null, {
    cursor: vi.fn(),
    newPoint: vi.fn()
  });
  expect(host.querySelector('.gm-action-library')).not.toBeNull();
  host.querySelector('[data-add-type="keys"]').click();
  const initialKey = host.querySelector('[data-field="value"]');
  initialKey.value = 'F8';
  initialKey.dispatchEvent(new Event('input', { bubbles: true }));
  host.querySelector('[data-add-type="wait"]').click();
  expect(editor.read()[0].steps.map(s => s.type)).toEqual(['keys', 'wait']);
  expect(host.querySelector('[data-step="0"] .gm-step-editor').hidden).toBe(true);
  host.querySelector('[data-step="1"] [data-step-copy]').click();
  expect(editor.read()[0].steps).toHaveLength(3);
  host.querySelector('[data-step="2"] [data-step-delete]').click();
  expect(editor.read()[0].steps).toHaveLength(2);
  host.querySelector('[data-undo]').click();
  expect(editor.read()[0].steps).toHaveLength(3);
  host.querySelector('[data-block-collapse]').click();
  expect(host.querySelector('[data-block-collapse]').getAttribute('aria-expanded')).toBe('false');
  expect(editor.read()[0].steps).toHaveLength(3);
  host.querySelector('[data-block-collapse]').click();
  host.querySelector('[data-step="0"] [data-step-select]').click();
  const value = host.querySelector('[data-step="0"] [data-field="value"]');
  value.value = 'F3';
  value.dispatchEvent(new Event('input', { bubbles: true }));
  expect(host.querySelector('[data-step="0"] [data-step-summary]').textContent).toBe('F3');
  expect(editor.read()[0].steps[0].value).toBe('F3');
  editor.dispose();
});
it('opens and highlights an invalid step on save instead of silently accepting it', () => {
  state.parties = [];
  state.characters = [];
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const editor = mountCompositionEditor(host, { partyId: '', commands: [], points: [], profiles: [] }, null, {
    cursor: vi.fn(),
    newPoint: vi.fn()
  });
  host.querySelector('[data-add-type="launch"]').click();
  host.querySelector('[data-block-collapse]').click();
  expect(() => editor.read()).toThrow();
  expect(host.querySelector('[data-step="0"]').classList.contains('is-invalid')).toBe(true);
  expect(host.querySelector('[data-compose-error]').textContent).toContain('шаг 1');
  editor.dispose();
});

it('has only the action library, accepts custom chords and stores finite block loops', () => {
  state.parties = [];
  state.characters = [];
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const editor = mountCompositionEditor(host, { partyId: '', commands: [], points: [], profiles: [] }, null);
  for (const selector of [
    '[data-step-add]',
    '[data-command-choose]',
    '[data-command-picker]',
    '[data-new-point]',
    '[data-recorder]',
    '[data-record-area]',
    '[data-field="type"]'
  ])
    expect(host.querySelector(selector)).toBeNull();
  expect(host.querySelector('[data-key-chord]')).toBeNull();
  host.querySelector('[data-add-type="keys"]').click();
  const chord = host.querySelector('[data-step="0"] [data-field="value"]');
  chord.value = 'ctrl+shift+2';
  chord.dispatchEvent(new Event('input', { bubbles: true }));
  expect(editor.read()[0].steps[0]).toEqual({ type: 'keys', value: 'CTRL+SHIFT+2' });
  const repeat = host.querySelector('[data-field="repeat"]');
  repeat.value = '3';
  repeat.dispatchEvent(new Event('input', { bubbles: true }));
  expect(editor.read()[0].repeat).toBe(3);
  chord.value = 'wrong';
  chord.dispatchEvent(new Event('input', { bubbles: true }));
  expect(() => editor.read()).toThrow();
  editor.dispose();
});

it('switches the same click between custom coordinates and a saved template without losing mouse choices', () => {
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const editor = mountCompositionEditor(
    host,
    { partyId: '', commands: [], points: [{ id: 'p', name: 'Кнопка' }], profiles: [] },
    null
  );
  host.querySelector('[data-add-type="screen"]').click();
  const change = (selector, value) => {
    const input = host.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  change('[data-field="x"]', '123');
  change('[data-field="y"]', '456');
  change('[data-field="button"]', 'right');
  change('[data-click-source]', 'point');
  change('[data-field="pointId"]', 'p');
  expect(editor.read()[0].steps[0]).toMatchObject({ type: 'point', pointId: 'p', button: 'right' });
  change('[data-click-source]', 'screen');
  expect(editor.read()[0].steps[0]).toMatchObject({ type: 'screen', x: 123, y: 456, button: 'right' });
  editor.dispose();
});
it('inserts templates and saved commands as editable snapshots, never exclusive references', () => {
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const command = { id: 'keys', name: 'Баф', action: 'sequence', sequence: 'F8', target: 'all' };
  const editor = mountCompositionEditor(host, { partyId: 'p', commands: [command], points: [], profiles: [] }, null);
  host.querySelector('[data-template="f6f1"]').click();
  expect(editor.read().map(b => b.steps[0])).toEqual([
    { type: 'keys', value: 'F6' },
    { type: 'keys', value: 'F1' }
  ]);
  host.querySelector('[data-unpack-command="keys"]').click();
  command.sequence = 'F9';
  expect(editor.read()[2].steps[0]).toEqual({ type: 'keys', value: 'F8' });
  editor.dispose();
});

it('replaces the empty placeholder before applying the eight-block import limit', () => {
  state.parties = [];
  state.characters = [];
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const saved = {
    id: 'full',
    name: 'Восемь блоков',
    action: 'composite',
    blocks: Array.from({ length: 8 }, (_, i) => ({
      name: `Блок ${i + 1}`,
      scope: 'party',
      target: 'all',
      steps: [{ type: 'keys', value: 'F2' }]
    }))
  };
  const editor = mountCompositionEditor(host, { partyId: '', commands: [saved], points: [], profiles: [] }, null);
  host.querySelector('[data-unpack-command="full"]').click();
  expect(editor.read()).toHaveLength(8);
  expect(host.querySelector('[data-compose-error]').textContent).toBe('');
  editor.dispose();
});

it('keeps edited managed recipients instead of silently resetting others to all', () => {
  state.parties = [{ id: 'p', name: 'Party' }];
  state.characters = [
    { id: 'a', nick: 'A', class: 'Воин', partyIds: ['p'] },
    { id: 'b', nick: 'B', class: 'Жрец', partyIds: ['p'] },
    { id: 'c', nick: 'C', class: 'Воин', partyIds: ['q'] }
  ];
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const editor = mountCompositionEditor(
    host,
    { partyId: 'p', commands: [], points: [], profiles: [] },
    { blocks: [{ scope: 'managed', target: 'all', steps: [{ type: 'keys', value: 'F2' }] }] }
  );
  let target = host.querySelector('[data-field="target"]');
  target.value = 'others';
  target.dispatchEvent(new Event('change', { bubbles: true }));
  expect(host.querySelector('[data-field="target"]').value).toBe('others');
  expect(editor.read()[0]).toMatchObject({ target: 'others', leaderSplit: true });
  target = host.querySelector('[data-field="target"]');
  target.value = 'subset';
  target.dispatchEvent(new Event('change', { bubbles: true }));
  const cls = host.querySelector('[data-recipient-class]');
  cls.value = 'Воин';
  cls.dispatchEvent(new Event('change', { bubbles: true }));
  expect(editor.read()[0].charIds).toEqual(['a', 'c']);
  expect(editor.read()[0].steps[0].value).toBe('F2');
  editor.dispose();
});
it('opens the full keyboard for a composition key step and persists the selected key', () => {
  state.parties = [];
  state.characters = [];
  document.body.innerHTML = '<div id="modal-root"></div><div id="editor"></div>';
  const host = document.getElementById('editor');
  const editor = mountCompositionEditor(
    host,
    { partyId: '', commands: [], points: [], profiles: [] },
    {
      blocks: [
        {
          name: 'План',
          scope: 'managed',
          target: 'all',
          delivery: 'foreground',
          steps: [{ type: 'keys', value: 'F1' }]
        }
      ]
    }
  );
  [...host.querySelectorAll('button')].find(b => b.textContent.includes('Полная клавиатура')).click();
  const picker = document.querySelector('.gm-keyboard-picker');
  picker.querySelector('[title="NUMPAD7"]').click();
  picker.querySelector('[data-apply]').click();
  expect(editor.read()[0].steps[0].value).toBe('NUMPAD7');
});

it.each([
  [
    'assist',
    'others',
    [
      { type: 'keys', value: 'SHIFT+1' },
      { type: 'wait', ms: 100 },
      { type: 'keys', value: 'F2' }
    ]
  ],
  ['buff', 'others', [{ type: 'keys', value: '9' }]],
  ['debuff', 'others', [{ type: 'keys', value: '1' }]],
  [
    'assist-buff',
    'others',
    [
      { type: 'keys', value: 'SHIFT+1' },
      { type: 'wait', ms: 100 },
      { type: 'keys', value: 'F2' },
      { type: 'wait', ms: 200 },
      { type: 'keys', value: '9' }
    ]
  ],
  [
    'buff-debuff',
    'others',
    [
      { type: 'keys', value: '9' },
      { type: 'wait', ms: 200 },
      { type: 'keys', value: '1' }
    ]
  ],
  ['party-f1', 'all', [{ type: 'keys', value: 'F1' }]]
])('adds the %s example as an editable party plan without executing it', (preset, target, steps) => {
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const editor = mountCompositionEditor(host, { partyId: 'p', commands: [], points: [], profiles: [] }, null);
  host.querySelector(`[data-preset="${preset}"]`).click();
  expect(editor.read()).toHaveLength(1);
  expect(editor.read()[0]).toMatchObject({ scope: 'party', partyId: '', target, delivery: 'foreground', steps });
  expect(host.querySelector('.gm-block-advanced [data-field="name"]')).toBeNull();
  expect(host.querySelector('.gm-block-advanced [data-field="target"]').value).toBe(target);
  editor.dispose();
});

it('offers the tested activity-notify method for a new group while retaining an existing legacy method', () => {
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const config = { partyId: 'p', commands: [], points: [], profiles: [] };
  let editor = mountCompositionEditor(host, config, null);
  const delivery = host.querySelector('[data-field="delivery"]');
  delivery.value = 'background';
  delivery.dispatchEvent(new Event('change', { bubbles: true }));
  let methods = host.querySelector('[data-field="backgroundMethod"]');
  expect([...methods.options].map(o => o.value)).toEqual(['activity-notify']);
  editor.dispose();
  editor = mountCompositionEditor(host, config, {
    blocks: [{ delivery: 'background', backgroundMethod: 'post', steps: [{ type: 'keys', value: 'F1' }] }]
  });
  methods = host.querySelector('[data-field="backgroundMethod"]');
  expect(methods.value).toBe('post');
  expect(methods.selectedOptions[0].textContent).toContain('сохранённый прежний способ');
  expect(editor.read()[0].backgroundMethod).toBe('post');
  editor.dispose();
});

it('places each group settings beside its ordered steps and examples outside the groups', () => {
  document.body.innerHTML = '<div id="editor"></div>';
  const host = document.getElementById('editor');
  const editor = mountCompositionEditor(host, { partyId: '', commands: [], points: [], profiles: [] }, null);
  expect(host.querySelector('.gm-examples-panel [data-preset="assist"]')).not.toBeNull();
  const group = host.querySelector('[data-block="0"]');
  expect(group.querySelector('.gm-action-library [data-field="scope"]')).not.toBeNull();
  expect(group.querySelector('.gm-action-library [data-field="repeat"]')).not.toBeNull();
  expect(group.querySelector('.gm-action-library [data-add-type="focus"]')).not.toBeNull();
  expect(group.querySelector('.gm-action-library [data-preset]')).toBeNull();
  expect(group.querySelector('.gm-compose-steps')).not.toBeNull();
  group.querySelector('[data-add-type="keys"]').click();
  host.querySelector('[data-add-type="wait"]').click();
  expect([...host.querySelectorAll('[data-step] .gm-step-number')].map(node => node.textContent)).toEqual(['1', '2']);
  editor.dispose();
});
