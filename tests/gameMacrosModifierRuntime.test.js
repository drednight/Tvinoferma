import { beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
let state, runtime, openModifierExperiments;
beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  localStorage.clear();
  document.body.innerHTML = '<form><div id="modal-root"></div></form>';
  window.__TAURI_INTERNALS__ = {};
  ({ state } = await import('../js/core/state.js'));
  state.characters = [{ id: 'a', nick: 'Alpha', partyIds: [] }];
  state.settings.gameMacros = {};
  runtime = await import('../js/modules/gameMacros/runtime.js');
  ({ openModifierExperiments } = await import('../js/modules/gameMacros/modifierExperiments.js'));
  invoke.mockImplementation(async c =>
    c === 'launcher_running_details'
      ? [{ pid: 10, startedAt: 1000, hwnd: 100, title: 'Alpha — Воин', elevated: false }]
      : { ok: true }
  );
});
it('real UI/runtime counts down then dispatches one explicit hybrid test with both consents', async () => {
  const ov = openModifierExperiments({ state, run: runtime.runModifierExperiment, stop: runtime.stop });
  const submit = vi.fn(e => e.preventDefault());
  document.querySelector('form').addEventListener('submit', submit);
  const q = name => ov.body.querySelector(`[data-${name}]`);
  q('char').value = 'a';
  q('method').value = 'hybrid';
  q('method').dispatchEvent(new Event('change'));
  q('consent').checked = true;
  q('risk').checked = true;
  q('run').click();
  try {
    await vi.waitFor(() => expect(q('status').textContent).toContain('До опыта'));
    await vi.waitFor(
      () =>
        expect(invoke).toHaveBeenCalledWith('game_macro_modifier_trial', {
          target: { pid: 10, startedAt: 1000, hwnd: 100 },
          key: 'SHIFT+1',
          method: 'hybrid',
          consent: true,
          riskConsent: true
        }),
      { timeout: 7000 }
    );
    expect(invoke.mock.calls.filter(([c]) => c === 'game_macro_modifier_trial')).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
  } finally {
    ov.close();
  }
});
it('stop during countdown never dispatches the experiment', async () => {
  const run = runtime.runModifierExperiment(
    { charId: 'a', key: 'SHIFT+1', method: 'activate', consent: true, riskConsent: true },
    () => runtime.stop()
  );
  await expect(run).rejects.toThrow();
  expect(invoke.mock.calls.some(([c]) => c === 'game_macro_modifier_trial')).toBe(false);
});
