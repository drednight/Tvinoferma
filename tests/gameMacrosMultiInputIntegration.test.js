import { beforeEach, it, expect, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
let state, runtime, openMultiInputTrial;
beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  localStorage.clear();
  document.body.innerHTML = '<form id="surrounding"><div id="modal-root"></div></form>';
  window.__TAURI_INTERNALS__ = {};
  ({ state } = await import('../js/core/state.js'));
  state.characters = [
    { id: 'a', nick: 'Alpha', partyIds: [] },
    { id: 'b', nick: 'Beta', partyIds: [] }
  ];
  state.settings.gameMacros = {};
  runtime = await import('../js/modules/gameMacros/runtime.js');
  ({ openMultiInputTrial } = await import('../js/modules/gameMacros/multiInputTrial.js'));
});
it('real UI/runtime starts countdown for one recipient and dispatches the validated timing plan without submitting a parent form', async () => {
  invoke.mockImplementation(async c =>
    c === 'launcher_running_details'
      ? [{ pid: 10, startedAt: 1000, hwnd: 100, title: 'Alpha — Воин', elevated: false }]
      : c === 'game_macro_compare_many'
        ? { ok: true, recipients: [{ pid: 10, ok: true, steps: [] }] }
        : null
  );
  const submit = vi.fn(e => e.preventDefault());
  document.querySelector('form').addEventListener('submit', submit);
  const ov = openMultiInputTrial({ state, run: runtime.runMultiInputTrial, stop: runtime.stop });
  ov.body.querySelector('[data-char]').checked = true;
  ov.body.querySelector('[data-sequence]').value = 'SHIFT+1';
  ov.body.querySelector('[data-consent]').checked = true;
  try {
    ov.body.querySelector('[data-run]').click();
    await vi.waitFor(() => expect(ov.body.querySelector('[data-status]').textContent).toContain('До общего запуска'));
    expect(ov.body.querySelector('[data-char]').checked).toBe(true);
    await vi.waitFor(() => expect(invoke.mock.calls.some(([c]) => c === 'game_macro_compare_many')).toBe(true), {
      timeout: 7000
    });
    expect(invoke).toHaveBeenCalledWith('game_macro_compare_many', {
      targets: [{ pid: 10, startedAt: 1000, hwnd: 100 }],
      steps: [{ key: 'SHIFT+1' }],
      timing: { timeoutMs: 25, modifierGapMs: 0 }
    });
    expect(ov.body.querySelector('[data-char]').checked).toBe(true);
    expect(ov.body.querySelector('[data-consent]').checked).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  } finally {
    ov.close();
  }
});
it('unmapped windows give a visible reason before countdown without clearing selected recipients or consent', async () => {
  invoke.mockResolvedValue([{ pid: 10, startedAt: 1000, hwnd: 100, title: 'Perfect World', elevated: false }]);
  const ov = openMultiInputTrial({ state, run: runtime.runMultiInputTrial, stop: runtime.stop });
  ov.body.querySelector('[data-char]').checked = true;
  ov.body.querySelector('[data-sequence]').value = 'SHIFT+1';
  ov.body.querySelector('[data-consent]').checked = true;
  ov.body.querySelector('[data-run]').click();
  await vi.waitFor(() => expect(ov.body.querySelector('[data-error]').hidden).toBe(false));
  expect(ov.body.querySelector('[data-error]').textContent).toContain('Alpha');
  expect(ov.body.querySelector('[data-error]').textContent).toContain('Проверить окна');
  expect(ov.body.querySelector('[data-char]').checked).toBe(true);
  expect(ov.body.querySelector('[data-consent]').checked).toBe(true);
  expect(invoke.mock.calls.some(([c]) => c === 'game_macro_compare_many')).toBe(false);
  expect(runtime.snapshot().busy).toBe(false);
  const { backgroundJournalEntries } = await import('../js/modules/gameMacros/backgroundJournal.js');
  expect(backgroundJournalEntries().some(r => r.stage === 'multi-ui-error')).toBe(true);
  ov.close();
});
