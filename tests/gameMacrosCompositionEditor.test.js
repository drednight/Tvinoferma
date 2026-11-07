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
