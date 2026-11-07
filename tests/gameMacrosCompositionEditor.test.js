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
  host.querySelector('[data-add-type="point"]').click();
  host.querySelector('[data-block-collapse]').click();
  expect(() => editor.read()).toThrow();
  expect(host.querySelector('[data-step="1"]').classList.contains('is-invalid')).toBe(true);
  expect(host.querySelector('[data-compose-error]').textContent).toContain('шаг 2');
  editor.dispose();
});
