import { beforeEach, describe, it, expect, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
let runtime, state;
const client = { pid: 10, startedAt: 1000, hwnd: 100, elevated: false, title: 'Alpha — Жрец' };
beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  window.__TAURI_INTERNALS__ = {};
  ({ state } = await import('../js/core/state.js'));
  state.characters = [{ id: 'a', nick: 'Alpha', partyIds: ['p'] }];
  state.settings.gameMacros = {
    partyId: 'p',
    leaders: { p: 'a' },
    commands: [{ id: 'test', name: 'test', action: 'sequence', target: 'all', sequence: 'wait 200\nF7' }]
  };
  invoke.mockImplementation(async command => (command === 'launcher_running_details' ? [client] : null));
  runtime = await import('../js/modules/gameMacros/runtime.js');
});
describe('single bounded executor', () => {
  it('cancels remaining input and refuses a simultaneous second executor', async () => {
    const first = runtime.run('test');
    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.some(([command, args]) => command === 'game_macro_action' && args.action === 'focus')
      ).toBe(true)
    );
    await runtime.run('test');
    runtime.stop();
    await first;
    expect(invoke.mock.calls.some(([command, args]) => command === 'game_macro_action' && args.action === 'key')).toBe(
      false
    );
    expect(runtime.snapshot().busy).toBe(false);
    expect(runtime.snapshot().logs.join('\n')).toContain('Предыдущая команда');
    expect(runtime.snapshot().logs.join('\n')).toContain('Остановлено пользователем');
  });
  it('never acts on cached recipients after a failed fresh enumeration', async () => {
    invoke.mockRejectedValue(new Error('private path/token must not enter logs'));
    await runtime.run('test');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().logs.join('\n')).not.toContain('private path');
    expect(runtime.snapshot().busy).toBe(false);
  });
  it('does not hijack focus from another app on a hotkey', async () => {
    invoke.mockImplementation(async (command, args) => {
      if (command === 'launcher_running_details') return [client];
      if (args?.action === 'foreground') throw new Error('other app');
      return null;
    });
    await runtime.run('test', true);
    expect(
      invoke.mock.calls.some(([command, args]) => command === 'game_macro_action' && args.action === 'focus')
    ).toBe(false);
    expect(runtime.snapshot().logs.join('\n')).toContain('Горячая команда пропущена');
  });
  it('unregisters old hotkeys before refusing conflicting new configuration', async () => {
    state.settings.gameMacros.enabled = true;
    state.settings.gameMacros.commands[0].hotkey = 'CTRL+ALT+PAUSE';
    await runtime.configure();
    expect(invoke).toHaveBeenCalledWith('game_macro_bindings', { bindings: [] });
    expect(invoke.mock.calls.filter(([command]) => command === 'game_macro_bindings')).toHaveLength(1);
    expect(runtime.snapshot().registered).toBe(false);
  });
  it('does not put account data in the overlay payload', () => {
    state.characters[0].password = 'secret';
    state.settings.gameMacros.commands[0].sequence = 'F8';
    const text = JSON.stringify(runtime.snapshot());
    expect(text).not.toContain('secret');
    expect(text).not.toContain('sequence');
    expect(text).not.toContain('Alpha');
  });
});

describe('coordinate input is opt-in and previewed per session', () => {
  const point = { id: 'point', name: 'test', uiScale: '100%', x: 10, y: 20, width: 800, height: 600, dpi: 96 };
  const setup = () => {
    state.settings.gameMacros.points = [point];
    state.settings.gameMacros.commands = [
      { id: 'click', name: 'click', action: 'click', target: 'all', pointId: 'point', resourceAllowed: true }
    ];
  };
  it('refuses clicks before preview in the current app session', async () => {
    setup();
    await runtime.run('click');
    expect(invoke.mock.calls.some(([, args]) => args?.action === 'click')).toBe(false);
  });
  it('previews without focus or input, then checks geometry again before clicking', async () => {
    setup();
    await runtime.previewCommand('click');
    expect(invoke.mock.calls.some(([, args]) => ['focus', 'click', 'key'].includes(args?.action))).toBe(false);
    await runtime.run('click');
    const actions = invoke.mock.calls.map(([, args]) => args?.action).filter(Boolean);
    expect(actions).toEqual(['preview', 'preview', 'focus', 'click', 'focus']);
  });
  it('refuses input if any recipient fails the non-clicking geometry preflight', async () => {
    setup();
    await runtime.previewCommand('click');
    invoke.mockImplementation(async (command, args) => {
      if (command === 'launcher_running_details') return [client];
      if (args?.action === 'preview') throw new Error('size changed');
      return null;
    });
    await runtime.run('click');
    expect(invoke.mock.calls.some(([, args]) => args?.action === 'click')).toBe(false);
  });
  it('still refuses clicks without explicit spending permission after a preview', async () => {
    setup();
    state.settings.gameMacros.commands[0].resourceAllowed = false;
    await runtime.previewCommand('click');
    await runtime.run('click');
    expect(invoke.mock.calls.some(([, args]) => args?.action === 'click')).toBe(false);
  });
});

describe('ported multi-pass AHK actions', () => {
  const twoWindows = () => {
    state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
    invoke.mockImplementation(async command =>
      command === 'launcher_running_details' ? [client, { ...client, pid: 11, hwnd: 101, title: 'Beta — Воин' }] : null
    );
  };
  it('does F6 on others FIRST, then F1 on all including PL', async () => {
    twoWindows();
    state.settings.gameMacros.commands = [{ id: 'combo', name: 'combo', action: 'f6f1', target: 'all' }];
    await runtime.run('combo');
    expect(
      invoke.mock.calls.filter(([, args]) => args?.action === 'key').map(([, args]) => [args.target.pid, args.key])
    ).toEqual([
      [11, 'F6'],
      [10, 'F1'],
      [11, 'F1']
    ]);
  });
  it('resizes the assigned PL, optimizes others and restores PL', async () => {
    twoWindows();
    state.settings.gameMacros.commands = [{ id: 'opt', name: 'opt', action: 'optimize', target: 'all' }];
    await runtime.run('opt');
    const resize = invoke.mock.calls
      .filter(([, args]) => args?.action === 'client-layout')
      .map(([, args]) => [args.target.pid, args.rect.width, args.rect.height]);
    expect(resize).toEqual([
      [10, 3440, 1440],
      [11, 1920, 1200]
    ]);
    expect(
      invoke.mock.calls.filter(([, args]) => args?.action === 'key').map(([, args]) => [args.target.pid, args.key])
    ).toEqual([[11, 'CTRL+F9']]);
  });
  it('does not send F6 at all if no PL is assigned', async () => {
    twoWindows();
    state.settings.gameMacros.leaders = {};
    state.settings.gameMacros.commands = [{ id: 'combo', name: 'combo', action: 'f6f1', target: 'all' }];
    await runtime.run('combo');
    expect(invoke.mock.calls.some(([, args]) => args?.action === 'key')).toBe(false);
  });
  it('can pause without a game window and refuses actions until resumed', async () => {
    state.settings.gameMacros.commands.push({ id: 'pause', name: 'pause', action: 'pause', target: 'all' });
    await runtime.run('pause');
    await runtime.run('test');
    expect(invoke).not.toHaveBeenCalled();
    expect(runtime.snapshot().paused).toBe(true);
    await runtime.run('pause');
    expect(runtime.snapshot().paused).toBe(false);
  });
});
