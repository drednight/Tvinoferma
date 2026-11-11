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
      [10, 2560, 1400],
      [11, 2560, 1400]
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

describe('AHK follow, buff and mixed-resolution resurrection', () => {
  const base = { id: 'portrait', name: 'Portrait', uiScale: '100%', x: 20, y: 20, width: 800, height: 600, dpi: 96 };
  it('previews both points, then sends Shift+1, right-click and left-click in order', async () => {
    state.settings.gameMacros.points = [base, { ...base, id: 'menu', name: 'Follow', x: 40, y: 40 }];
    state.settings.gameMacros.commands = [
      {
        id: 'follow',
        name: 'follow',
        action: 'follow',
        target: 'all',
        pointId: 'portrait',
        menuPointId: 'menu',
        resourceAllowed: true
      }
    ];
    await runtime.previewCommand('follow');
    expect(invoke.mock.calls.some(([, args]) => ['click', 'right-click', 'key'].includes(args?.action))).toBe(false);
    invoke.mockClear();
    await runtime.run('follow');
    expect(invoke.mock.calls.map(([, args]) => args?.action).filter(Boolean)).toEqual([
      'preview',
      'preview',
      'focus',
      'key',
      'right-click',
      'click',
      'focus'
    ]);
    expect(invoke.mock.calls.find(([, args]) => args?.action === 'key')[1].key).toBe('SHIFT+1');
  });
  it('buff uses the management party, ignoring a legacy separate buff party', async () => {
    state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['buff'] });
    state.settings.gameMacros.buffPartyId = 'buff';
    state.settings.gameMacros.commands = [
      { id: 'buff', name: 'buff', action: 'sequence', target: 'all', scope: 'buff', sequence: 'F8' }
    ];
    invoke.mockImplementation(async command =>
      command === 'launcher_running_details' ? [client, { ...client, pid: 11, hwnd: 101, title: 'Beta — Воин' }] : null
    );
    await runtime.run('buff');
    expect(invoke.mock.calls.filter(([, args]) => args?.action === 'key').map(([, args]) => args.target.pid)).toEqual([
      10
    ]);
  });
  it('selects an exact point variant per window, without scaling and without requiring a management party', async () => {
    state.settings.gameMacros.partyId = '';
    state.characters.push({ id: 'b', nick: 'Beta', partyIds: [] });
    state.settings.gameMacros.points = [
      base,
      { ...base, id: 'wide', name: 'Wide', width: 3440, height: 1440, x: 100, y: 100 }
    ];
    state.settings.gameMacros.commands = [
      {
        id: 'res',
        name: 'res',
        action: 'click',
        target: 'all',
        scope: 'managed',
        pointId: 'portrait',
        pointIds: ['wide'],
        resourceAllowed: true
      }
    ];
    invoke.mockImplementation(async (command, args) => {
      if (command === 'launcher_running_details')
        return [client, { ...client, pid: 11, hwnd: 101, title: 'Beta — Воин' }];
      if (args?.action === 'client-info')
        return args.target.pid === 10 ? { width: 800, height: 600, dpi: 96 } : { width: 3440, height: 1440, dpi: 96 };
      return null;
    });
    await runtime.previewCommand('res');
    await runtime.run('res');
    expect(
      invoke.mock.calls
        .filter(([, args]) => args?.action === 'click')
        .map(([, args]) => [args.target.pid, args.point.width])
    ).toEqual([
      [10, 800],
      [11, 3440]
    ]);
  });
});

it('refuses an imported contradictory global scope instead of widening an others/subset target', async () => {
  state.settings.gameMacros.commands = [
    { id: 'bad', name: 'bad', action: 'sequence', target: 'others', scope: 'managed', sequence: 'F8' }
  ];
  await runtime.run('bad');
  expect(invoke.mock.calls.some(([, args]) => args?.action === 'key')).toBe(false);
});

describe('fast and background keyboard delivery', () => {
  it('sends background keys without any focus, foreground probe, or global input', async () => {
    state.settings.gameMacros.commands[0] = {
      id: 'test',
      name: 'Фон',
      action: 'sequence',
      target: 'all',
      delivery: 'background',
      sequence: 'F3\nwait 100\nF4'
    };
    await runtime.run('test');
    const actions = invoke.mock.calls.filter(([c]) => c === 'game_macro_action').map(([, a]) => [a.action, a.key]);
    expect(actions).toEqual([
      ['key-background', 'F3'],
      ['key-background', 'F4']
    ]);
    expect(runtime.snapshot().logs.join(' ')).toContain('НЕ подтверждена');
  });
  it('posts experimental background modifiers without global input', async () => {
    state.settings.gameMacros.commands[0] = {
      id: 'test',
      action: 'sequence',
      target: 'all',
      delivery: 'background',
      sequence: 'SHIFT+1\nF7'
    };
    await runtime.run('test');
    expect(invoke.mock.calls.filter(([c]) => c === 'game_macro_action').map(([, a]) => [a.action, a.key])).toEqual([
      ['key-background', 'SHIFT+1'],
      ['key-background', 'F7']
    ]);
  });
  it('never falls back to focus or SendInput after a background failure', async () => {
    state.settings.gameMacros.commands[0] = {
      id: 'test',
      action: 'sequence',
      target: 'all',
      delivery: 'background',
      sequence: 'F3\nF4'
    };
    invoke.mockImplementation(async (c, a) => {
      if (c === 'launcher_running_details') return [client];
      if (a?.action === 'key-background') throw new Error('Cannot queue background key');
      return null;
    });
    await runtime.run('test');
    expect(invoke.mock.calls.filter(([c]) => c === 'game_macro_action').map(([, a]) => a.action)).toEqual([
      'key-background'
    ]);
    expect(runtime.snapshot().logs.join(' ')).toContain('Автоповтора и переключения окон нет');
  });
  it('retains stop between background recipients/keys', async () => {
    state.settings.gameMacros.commands[0] = {
      id: 'test',
      action: 'sequence',
      target: 'all',
      delivery: 'background',
      sequence: 'F3\nF4'
    };
    invoke.mockImplementation(async (c, a) => {
      if (c === 'launcher_running_details') return [client];
      if (a?.action === 'key-background') runtime.stop();
      return null;
    });
    await runtime.run('test');
    expect(invoke.mock.calls.filter(([, a]) => a?.action === 'key-background')).toHaveLength(1);
  });
  it('removes redundant 50/80 ms JS sleeps for a one-key foreground command', async () => {
    state.settings.gameMacros.commands[0].sequence = 'F8';
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    try {
      await runtime.run('test');
      expect(timeout.mock.calls.some(([, delay]) => delay === 80 || delay === 50)).toBe(false);
      expect(runtime.snapshot().logs.join(' ')).toContain('Время выполнения');
    } finally {
      timeout.mockRestore();
    }
  });
});
it('background F6→F1 preserves both passes without activating/restoring the leader', async () => {
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
  state.settings.gameMacros.leaders = { p: 'a' };
  state.settings.gameMacros.commands = [{ id: 'test', action: 'f6f1', target: 'all', delivery: 'background' }];
  invoke.mockImplementation(async c =>
    c === 'launcher_running_details'
      ? [client, { ...client, pid: 20, startedAt: 2000, hwnd: 200, title: 'Beta — Жрец' }]
      : null
  );
  await runtime.run('test');
  expect(
    invoke.mock.calls.filter(([c]) => c === 'game_macro_action').map(([, a]) => [a.target.pid, a.action, a.key])
  ).toEqual([
    [20, 'key-background', 'F6'],
    [10, 'key-background', 'F1'],
    [20, 'key-background', 'F1']
  ]);
});

describe('composition input and cancellation', () => {
  const plan = steps => ({
    id: 'plan',
    action: 'composite',
    resourceAllowed: true,
    blocks: [{ partyId: 'p', target: 'all', delivery: 'background', steps }]
  });
  it('requires screen preview and never focuses or sends global input in a background click', async () => {
    state.settings.gameMacros.commands = [
      plan([{ type: 'screen', x: 10, y: 20, button: 'right', count: 2, modifiers: ['CTRL'] }])
    ];
    await runtime.run('plan');
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'game_macro_pointer')).toBe(false);
    await runtime.previewComposition('plan');
    await runtime.run('plan');
    expect(
      invoke.mock.calls.some(
        ([cmd, args]) =>
          cmd === 'game_macro_pointer' && args.input.background && args.input.count === 2 && !args.input.checkOnly
      )
    ).toBe(true);
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'game_macro_action')).toBe(false);
  });
  it('cancels a paused composition, clears its paused state, and never starts the next key', async () => {
    state.settings.gameMacros.commands = [plan([{ type: 'pause' }, { type: 'keys', value: 'F8' }])];
    const running = runtime.run('plan');
    await vi.waitFor(() => expect(runtime.snapshot().paused).toBe(true));
    runtime.stop();
    await running;
    expect(runtime.snapshot()).toMatchObject({ busy: false, paused: false });
    expect(
      invoke.mock.calls.some(
        ([cmd, args]) => cmd === 'game_macro_action' && ['key', 'background-key'].includes(args.action)
      )
    ).toBe(false);
  });
  it('does not reject a future-size point before its preceding resize and still checks it before click', async () => {
    state.settings.gameMacros.points = [
      { id: 'point', name: 'p', x: 10, y: 20, width: 800, height: 600, dpi: 96, uiScale: '100' }
    ];
    state.settings.gameMacros.commands = [
      plan([
        { type: 'resize', width: 800, height: 600 },
        { type: 'point', pointId: 'point', button: 'left', modifiers: ['CTRL'] }
      ])
    ];
    await runtime.previewComposition('plan');
    await runtime.run('plan');
    const calls = invoke.mock.calls;
    const resize = calls.findIndex(([cmd, args]) => cmd === 'game_macro_action' && args.action === 'client-layout');
    const click = calls.findIndex(([cmd, args]) => cmd === 'game_macro_pointer' && !args.input.checkOnly);
    expect(resize).toBeGreaterThan(-1);
    expect(click).toBeGreaterThan(resize);
    expect(calls[click][1].input.modifiers).toEqual(['CTRL']);
  });
});
describe('PW input regression guards', () => {
  it('waits for the launching chord to be released before sending input', async () => {
    state.settings.gameMacros.commands[0].hotkey = 'CTRL+F7';
    let checks = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'game_macro_input_idle') return ++checks > 2;
      if (command === 'launcher_running_details') return [client];
      if (args?.action === 'foreground') return true;
      return null;
    });
    await runtime.run('test', true);
    expect(checks).toBe(3);
    const calls = invoke.mock.calls;
    const firstFocus = calls.findIndex(([, a]) => a?.action === 'focus');
    expect(calls.slice(0, firstFocus).filter(([c]) => c === 'game_macro_input_idle')).toHaveLength(3);
  });
  it('refuses a held trigger after a bounded wait, without switching windows', async () => {
    vi.useFakeTimers();
    try {
      invoke.mockImplementation(async c => (c === 'game_macro_input_idle' ? false : null));
      const pending = runtime.run('test', true);
      await vi.runAllTimersAsync();
      await pending;
      expect(invoke.mock.calls.some(([c]) => c === 'game_macro_action')).toBe(false);
      expect(runtime.snapshot().notice).toContain('Отпустите клавиши');
    } finally {
      vi.useRealTimers();
    }
  });
  it('unregisters command chords during injection, keeps emergency stop, then restores them', async () => {
    state.settings.gameMacros.enabled = true;
    Object.assign(state.settings.gameMacros.commands[0], {
      hotkey: 'CTRL+F9',
      sequence: 'CTRL+F9',
      switchMs: 15,
      holdMs: 45
    });
    await runtime.configure();
    await runtime.run('test');
    const calls = invoke.mock.calls;
    const key = calls.findIndex(([, a]) => a?.action === 'key');
    const before = calls
      .slice(0, key)
      .filter(([c]) => c === 'game_macro_bindings')
      .at(-1)[1];
    expect(before.bindings).toEqual([{ id: 'stop', chord: 'CTRL+ALT+PAUSE' }]);
    expect(calls[key][1]).toMatchObject({
      target: { pid: 10, startedAt: 1000, hwnd: 100 },
      timing: { switchMs: 15, holdMs: 45 },
      key: 'CTRL+F9'
    });
    expect(
      calls
        .slice(key + 1)
        .filter(([c]) => c === 'game_macro_bindings')
        .at(-1)[1].bindings
    ).toContainEqual({ id: 'test', chord: 'CTRL+F9' });
  });
  it('reuses the validated snapshot for the final PL return, including an others-only command', async () => {
    state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
    state.settings.gameMacros.commands[0].target = 'others';
    invoke.mockImplementation(async c =>
      c === 'launcher_running_details'
        ? [client, { ...client, pid: 20, startedAt: 2000, hwnd: 200, title: 'Beta — Воин' }]
        : null
    );
    await runtime.run('test');
    expect(invoke.mock.calls.filter(([c]) => c === 'launcher_running_details')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([, a]) => a?.action === 'focus').map(([, a]) => a.target.pid)).toEqual([20, 10]);
  });
  it('can stay on the last recipient rather than returning to PL', async () => {
    state.settings.gameMacros.commands[0].returnTo = 'last';
    await runtime.run('test');
    expect(invoke.mock.calls.filter(([, a]) => a?.action === 'focus')).toHaveLength(1);
  });
  it('stops at the first rejected key instead of continuing to switch recipients', async () => {
    state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
    invoke.mockImplementation(async (c, a) => {
      if (c === 'launcher_running_details')
        return [client, { ...client, pid: 20, startedAt: 2000, hwnd: 200, title: 'Beta — Воин' }];
      if (a?.action === 'key') throw new Error('Key input incomplete or focus changed');
      return null;
    });
    await runtime.run('test');
    expect(invoke.mock.calls.filter(([, a]) => a?.action === 'focus')).toHaveLength(1);
    expect(runtime.snapshot().notice).toContain('Windows не приняла ввод');
  });
});
it('accepts a hotkey launched from PL even when the command only targets the other members', async () => {
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
  state.settings.gameMacros.commands[0].target = 'others';
  invoke.mockImplementation(async (c, a) => {
    if (c === 'launcher_running_details')
      return [client, { ...client, pid: 20, startedAt: 2000, hwnd: 200, title: 'Beta — Воин' }];
    if (a?.action === 'foreground' && a.target.pid !== 10) throw new Error('Game is not foreground');
    return null;
  });
  await runtime.run('test', true);
  expect(invoke.mock.calls.some(([, a]) => a?.action === 'key' && a.target.pid === 20)).toBe(true);
});
it('prepares the window snapshot while waiting for the launching chord to be released', async () => {
  let checks = 0;
  invoke.mockImplementation(async (c, a) => {
    if (c === 'game_macro_input_idle') return ++checks > 1;
    if (c === 'launcher_running_details') return [client];
    if (a?.action === 'foreground') return true;
    return null;
  });
  await runtime.run('test', true);
  const calls = invoke.mock.calls;
  expect(calls.findIndex(([c]) => c === 'launcher_running_details')).toBeLessThan(
    calls.findIndex(([c], i) => c === 'game_macro_input_idle' && i > 0)
  );
  expect(calls.filter(([c]) => c === 'launcher_running_details')).toHaveLength(1);
  expect(runtime.snapshot().logs.join(' ')).toContain('Первый запрос ввода');
  expect(runtime.snapshot().logs.join(' ')).toContain('Отправлено: F7');
});
it('marks successful completion explicitly without claiming game execution and marks cancellation separately', async () => {
  await runtime.run('test');
  expect(runtime.snapshot()).toMatchObject({ busy: false, executionState: 'finished' });
  expect(runtime.snapshot().notice).toContain('Завершена: test');
  expect(runtime.snapshot().logEntries.at(-1).terminal).toBe(true);
  runtime.stop();
  expect(runtime.snapshot().executionState).toBe('stopped');
});
it('dispatches only the chosen background method, without foreground activation or a fallback', async () => {
  for (const backgroundMethod of ['post', 'send-timeout', 'notify']) {
    invoke.mockClear();
    Object.assign(state.settings.gameMacros.commands[0], {
      delivery: 'background',
      backgroundMethod,
      sequence: 'CTRL+F9'
    });
    await runtime.run('test');
    const actions = invoke.mock.calls.filter(([c]) => c === 'game_macro_action').map(([, args]) => args);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: 'key-background', key: 'CTRL+F9', timing: { backgroundMethod } });
  }
});
it('stops a failed background method rather than trying another transport', async () => {
  Object.assign(state.settings.gameMacros.commands[0], {
    delivery: 'background',
    backgroundMethod: 'send-timeout',
    sequence: 'F8\nF9'
  });
  invoke.mockImplementation(async (c, args) => {
    if (c === 'launcher_running_details') return [client];
    if (args?.action === 'key-background') throw new Error('Cannot deliver background key');
    return null;
  });
  await runtime.run('test');
  expect(invoke.mock.calls.filter(([, a]) => a?.action === 'key-background')).toHaveLength(1);
  expect(runtime.snapshot().executionState).toBe('failed');
});
it('does not send the first key if stop was requested while native activation was in flight', async () => {
  let activate;
  state.settings.gameMacros.commands[0].sequence = 'F8';
  invoke.mockImplementation(async (c, args) => {
    if (c === 'launcher_running_details') return [client];
    if (args?.action === 'focus') return new Promise(resolve => (activate = resolve));
    return null;
  });
  const pending = runtime.run('test');
  await vi.waitFor(() => expect(activate).toBeTypeOf('function'));
  runtime.stop();
  activate(null);
  await pending;
  expect(invoke.mock.calls.some(([, a]) => a?.action === 'key')).toBe(false);
  expect(runtime.snapshot().executionState).toBe('stopped');
});
it('refreshes the overlay window list without activating game windows or sending input', async () => {
  await runtime.overlayPartyAction({ action: 'party-refresh' });
  expect(runtime.snapshot().windows).toEqual([
    { name: 'Alpha', pid: 10, startedAt: 1000, hwnd: 100, known: true, ownershipSource: 'title' }
  ]);
  expect(invoke.mock.calls.some(([c]) => c === 'game_macro_action')).toBe(false);
  expect(runtime.snapshot().busy).toBe(false);
});
it('rejects a deleted or fabricated party before launching anything', async () => {
  state.parties = [];
  await runtime.overlayPartyAction({ action: 'party-launch', partyId: 'missing' });
  expect(runtime.snapshot().windowNotice).toContain('Выберите существующую пати');
  expect(invoke.mock.calls.some(([c]) => c === 'launcher_launch')).toBe(false);
  expect(runtime.snapshot().busy).toBe(false);
});
it.each([
  [5, 'Отказ в доступе Windows (код 5)'],
  [1460, 'Таймаут Windows (код 1460)'],
  [0, 'не сообщила код ошибки']
])('explains native background failure %s without retrying foreground input', async (code, message) => {
  Object.assign(state.settings.gameMacros.commands[0], { delivery: 'background', sequence: 'B' });
  invoke.mockImplementation(async (c, args) => {
    if (c === 'launcher_running_details') return [client];
    if (args?.action === 'key-background') throw new Error(`Background delivery failed: ${code}`);
    return null;
  });
  await runtime.run('test');
  expect(runtime.snapshot().notice).toContain(message);
  expect(invoke.mock.calls.filter(([, a]) => a?.action === 'key-background')).toHaveLength(1);
  expect(invoke.mock.calls.some(([, a]) => a?.action === 'focus' || a?.action === 'key')).toBe(false);
});
it('performs only a read-only explicit probe and records identity and WM_NULL results', async () => {
  invoke.mockImplementation(async c =>
    c === 'launcher_running_details'
      ? [client]
      : c === 'game_macro_background_probe'
        ? {
            schema: 1,
            pid: 10,
            identityChecked: true,
            health: [{ timeoutMs: 25, ok: true, error: 0 }],
            inputSent: false
          }
        : null
  );
  const text = await runtime.diagnoseBackground('a', 'B');
  expect(text).toContain('WM_NULL');
  expect(text).toContain('Клавиши не отправлялись');
  expect(invoke.mock.calls.map(([c]) => c)).toEqual(['launcher_running_details', 'game_macro_background_probe']);
  expect(runtime.snapshot().busy).toBe(false);
});
it('does not probe unknown or vanished game clients', async () => {
  await expect(runtime.diagnoseBackground('missing', 'B')).rejects.toThrow('Не найдено');
  expect(invoke.mock.calls.some(([c]) => c === 'game_macro_background_probe')).toBe(false);
});
it('logs partial native delivery and failed release before stopping further recipients or keys', async () => {
  Object.assign(state.settings.gameMacros.commands[0], { delivery: 'background', sequence: 'B\nF8' });
  invoke.mockImplementation(async (c, args) =>
    c === 'launcher_running_details'
      ? [client]
      : args?.action === 'key-background'
        ? {
            schema: 1,
            ok: false,
            error: 5,
            inputSent: true,
            messages: [
              { phase: 'down', vk: 66, ok: true, error: 0 },
              { phase: 'up', vk: 66, ok: false, error: 5 }
            ]
          }
        : null
  );
  await runtime.run('test');
  expect(runtime.snapshot().logs.join('\n')).toContain('Отпускание: VK=0x42');
  expect(runtime.snapshot().notice).toContain('код 5');
  expect(invoke.mock.calls.filter(([, a]) => a?.action === 'key-background')).toHaveLength(1);
});

it('clears both journal representations without resetting the last execution status', async () => {
  state.settings.gameMacros.commands[0].sequence = 'F8';
  await runtime.run('test');
  const before = runtime.snapshot();
  expect(before.logs.length).toBeGreaterThan(0);
  await runtime.clearLogs();
  const after = runtime.snapshot();
  expect(after.logs).toEqual([]);
  expect(after.logEntries).toEqual([]);
  expect(after.executionState).toBe(before.executionState);
  expect(after.notice).toBe(before.notice);
  await runtime.run('test');
  expect(runtime.snapshot().logs.length).toBeGreaterThan(0);
});
it('clearing a live journal does not cancel the in-flight command or prevent later entries', async () => {
  let release;
  state.settings.gameMacros.commands[0].sequence = 'B';
  invoke.mockImplementation(async (c, a) =>
    c === 'launcher_running_details'
      ? [client]
      : a?.action === 'key'
        ? new Promise(resolve => {
            release = resolve;
          })
        : null
  );
  const pending = runtime.run('test');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await runtime.clearLogs();
  expect(runtime.snapshot().busy).toBe(true);
  expect(runtime.snapshot().logs).toEqual([]);
  release(null);
  await pending;
  expect(runtime.snapshot().executionState).toBe('finished');
  expect(runtime.snapshot().logs.length).toBeGreaterThan(0);
});

describe('overlay command launching', () => {
  it('runs by saved id with hotkeys disabled, using the existing mouse-release and execution guards', async () => {
    const { listen } = await import('@tauri-apps/api/event');
    await runtime.initGameMacros();
    const handler = listen.mock.calls.findLast(([name]) => name === 'game-overlay-run')[1];
    state.settings.gameMacros.enabled = false;
    state.settings.gameMacros.commands[0].sequence = 'F7';
    invoke.mockClear();
    handler({ payload: 'test' });
    await vi.waitFor(() => expect(runtime.snapshot().executionState).toBe('finished'));
    expect(invoke).toHaveBeenCalledWith('game_macro_input_idle', { chord: null });
    expect(
      invoke.mock.calls.some(
        ([name, args]) => name === 'game_macro_action' && args.action === 'key' && args.key === 'F7'
      )
    ).toBe(true);
    invoke.mockClear();
    handler({ payload: { id: 'test' } });
    handler({ payload: 'removed-command' });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
  });
});

it('arms a single activity test after five seconds and forces plain B without running a normal command', async () => {
  vi.useFakeTimers();
  try {
    invoke.mockImplementation(async c =>
      c === 'launcher_running_details'
        ? [client]
        : c === 'game_macro_background_probe'
          ? { schema: 1, activityTest: true, refused: true }
          : null
    );
    const pending = runtime.diagnoseBackground('a', 'CTRL+F9', true);
    expect(runtime.snapshot().busy).toBe(true);
    await vi.advanceTimersByTimeAsync(4900);
    expect(invoke).not.toHaveBeenCalledWith('game_macro_background_probe', expect.anything());
    await vi.advanceTimersByTimeAsync(100);
    const report = await pending;
    expect(invoke).toHaveBeenCalledWith('game_macro_background_probe', {
      target: { pid: 10, startedAt: 1000, hwnd: 100 },
      key: 'B',
      activityTest: true
    });
    expect(report).toContain('Тест отклонён');
    expect(runtime.snapshot().busy).toBe(false);
    expect(invoke.mock.calls.some(([c]) => c === 'game_macro_action')).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it('cancels an armed activity test without sending any notifications or keys', async () => {
  vi.useFakeTimers();
  try {
    const result = runtime.diagnoseBackground('a', 'B', true).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeInstanceOf(Error);
    expect(invoke.mock.calls.some(([c]) => c === 'game_macro_background_probe')).toBe(false);
    expect(runtime.snapshot().busy).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it('runs activity delivery immediately for two recipients and carries the original foreground guard', async () => {
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
  Object.assign(state.settings.gameMacros.commands[0], {
    sequence: 'B',
    delivery: 'background',
    backgroundMethod: 'activity'
  });
  const second = { ...client, pid: 20, hwnd: 200, title: 'Beta — Воин' };
  invoke.mockImplementation(async (name, args) =>
    name === 'launcher_running_details'
      ? [client, second]
      : args?.action === 'key-background'
        ? {
            schema: 1,
            activityTest: true,
            vk: 0x42,
            inputSent: true,
            ok: true,
            originalForeground: '0x100',
            foregroundChanged: false
          }
        : null
  );
  await runtime.run('test');
  const calls = invoke.mock.calls.filter(([, args]) => args?.action === 'key-background');
  expect(calls).toHaveLength(2);
  expect(calls[0][1].timing).toMatchObject({ backgroundMethod: 'activity' });
  expect(calls[1][1].timing).toMatchObject({ activityForeground: '0x100' });
  expect(invoke.mock.calls.some(([, args]) => args?.action === 'focus' || args?.action === 'key')).toBe(false);
  expect(runtime.snapshot().executionState).toBe('finished');
});
it.each([
  { ok: false, error: 1460 },
  { ok: false, foregroundChanged: true },
  { ok: false, refused: true }
])('stops after activity failure without trying another recipient or foreground fallback: %j', async result => {
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
  Object.assign(state.settings.gameMacros.commands[0], {
    sequence: 'B',
    delivery: 'background',
    backgroundMethod: 'activity'
  });
  invoke.mockImplementation(async (name, args) =>
    name === 'launcher_running_details'
      ? [client, { ...client, pid: 20, hwnd: 200, title: 'Beta — Воин' }]
      : args?.action === 'key-background'
        ? { schema: 1, activityTest: true, ...result }
        : null
  );
  await runtime.run('test');
  expect(invoke.mock.calls.filter(([, args]) => args?.action === 'key-background')).toHaveLength(1);
  expect(invoke.mock.calls.some(([, args]) => args?.action === 'focus' || args?.action === 'key')).toBe(false);
  expect(runtime.snapshot().executionState).toBe('failed');
});
it('rejects unsupported activity actions before any native input or mirroring changes', async () => {
  Object.assign(state.settings.gameMacros.commands[0], {
    action: 'f6f1',
    sequence: 'B\nF8',
    delivery: 'background',
    backgroundMethod: 'activity'
  });
  await runtime.run('test');
  expect(invoke).not.toHaveBeenCalled();
  expect(runtime.snapshot().notice).toContain('только отдельная последовательность');
});
it('sends Shift+1 then F2 in order to each recipient with activity delivery', async () => {
  Object.assign(state.settings.gameMacros.commands[0], {
    sequence: 'SHIFT+1\nF2',
    delivery: 'background',
    backgroundMethod: 'activity'
  });
  invoke.mockImplementation(async (name, args) =>
    name === 'launcher_running_details'
      ? [client]
      : args?.action === 'key-background'
        ? {
            schema: 1,
            activityTest: true,
            vk: args.key === 'F2' ? 0x71 : 0x31,
            modifiers: args.key === 'F2' ? [] : [16],
            ok: true,
            originalForeground: '0x100'
          }
        : null
  );
  await runtime.run('test');
  expect(invoke.mock.calls.filter(([, args]) => args?.action === 'key-background').map(([, args]) => args.key)).toEqual(
    ['SHIFT+1', 'F2']
  );
  expect(runtime.snapshot().executionState).toBe('finished');
});
it.each(['missing-party', 'missing-member'])(
  'falls back to all validated game processes before input when %s cannot resolve',
  async reason => {
    if (reason === 'missing-party') state.settings.gameMacros.partyId = 'gone';
    else state.characters.push({ id: 'b', nick: 'Absent', partyIds: ['p'] });
    Object.assign(state.settings.gameMacros.commands[0], {
      sequence: 'SHIFT+1\nF2',
      delivery: 'background',
      backgroundMethod: 'activity'
    });
    const unknown = { pid: 30, startedAt: 2000, hwnd: 300, elevated: false, title: 'Element Client' };
    invoke.mockImplementation(async (name, args) =>
      name === 'launcher_running_details'
        ? [client, unknown]
        : args?.action === 'key-background'
          ? { schema: 1, activityTest: true, ok: true, originalForeground: '0x100' }
          : null
    );
    await runtime.run('test');
    const calls = invoke.mock.calls
      .filter(([, args]) => args?.action === 'key-background')
      .map(([, args]) => [args.target.pid, args.key]);
    expect(calls).toEqual([
      [10, 'SHIFT+1'],
      [10, 'F2'],
      [30, 'SHIFT+1'],
      [30, 'F2']
    ]);
    expect(runtime.snapshot().logs.join('\n')).toContain('Резерв: ВСЕ проверенные игровые окна (2)');
    expect(runtime.snapshot().executionState).toBe('finished');
  }
);
it('does not fall back if any game process lacks a verified window identity', async () => {
  state.settings.gameMacros.partyId = 'gone';
  Object.assign(state.settings.gameMacros.commands[0], {
    sequence: 'B',
    delivery: 'background',
    backgroundMethod: 'activity'
  });
  invoke.mockImplementation(async name =>
    name === 'launcher_running_details' ? [client, { ...client, pid: 20, hwnd: null, title: 'Unknown' }] : null
  );
  await runtime.run('test');
  expect(runtime.snapshot().executionState).toBe('failed');
  expect(invoke.mock.calls.some(([, args]) => args?.action === 'key-background')).toBe(false);
});
it('omits hidden window size/profile commands only from the overlay view, retaining saved commands', () => {
  state.settings.gameMacros.commands.push(
    { id: 'size', action: 'resize', name: 'Size' },
    { id: 'layout', action: 'layout', name: 'Layout' }
  );
  expect(runtime.snapshot().commands.map(row => row.id)).toEqual(['test']);
  expect(runtime.config().commands.map(row => row.id)).toEqual(['test', 'size', 'layout']);
});

it('resolves a manual override for command recipients even if the old title matches another character', async () => {
  const { rememberExistingWindow, forgetManualWindow } = await import('../js/modules/launcher/launchedWindows.js');
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
  rememberExistingWindow(client.pid, 'b', client.startedAt);
  const rows = await runtime.listMacroWindows();
  expect(rows[0]).toMatchObject({ charId: 'b', known: true, ownershipSource: 'manual' });
  forgetManualWindow(client.pid, client.startedAt);
  expect((await runtime.listMacroWindows())[0]).toMatchObject({ charId: 'a', ownershipSource: 'title' });
});

describe('configurable follow', () => {
  const point = { id: 'portrait', name: 'portrait', uiScale: '100%', x: 10, y: 20, width: 800, height: 600, dpi: 96 };
  const setupFollow = extra => {
    state.settings.gameMacros.points = [point, { ...point, id: 'menu', name: 'menu', x: 40 }];
    state.settings.gameMacros.commands = [
      {
        id: 'follow',
        action: 'follow',
        name: 'Follow',
        target: 'all',
        pointId: 'portrait',
        menuPointId: 'menu',
        resourceAllowed: true,
        ...extra
      }
    ];
  };
  it('keeps the old SHIFT+1/right/left workflow for saved commands', async () => {
    setupFollow();
    await runtime.previewCommand('follow');
    await runtime.run('follow');
    const input = invoke.mock.calls
      .filter(([c, a]) => c === 'game_macro_action' && ['key', 'click', 'right-click'].includes(a.action))
      .map(([, a]) => [a.action, a.key, a.point?.id]);
    expect(input).toEqual([
      ['key', 'SHIFT+1', undefined],
      ['right-click', null, 'portrait'],
      ['click', null, 'menu']
    ]);
  });
  it('sends configured keys and both configured mouse buttons at the saved coordinates', async () => {
    setupFollow({ followSequence: 'CTRL+NUMPAD3\nwait 50\nF2', followButton: 'left', followMenuButton: 'right' });
    await runtime.previewCommand('follow');
    await runtime.run('follow');
    const actions = invoke.mock.calls
      .filter(([c, a]) => c === 'game_macro_action' && ['key', 'click', 'right-click'].includes(a.action))
      .map(([, a]) => a);
    expect(actions.map(a => a.key || a.action)).toEqual(['CTRL+NUMPAD3', 'F2', 'click', 'right-click']);
    expect(actions.slice(-2).map(a => [a.point.x, a.point.y])).toEqual([
      [10, 20],
      [40, 20]
    ]);
  });
  it('allows no keyboard prelude and refuses malformed keys before any focus or input', async () => {
    setupFollow({ followSequence: '' });
    await runtime.previewCommand('follow');
    await runtime.run('follow');
    expect(invoke.mock.calls.some(([, a]) => a?.action === 'key')).toBe(false);
    invoke.mockClear();
    state.settings.gameMacros.commands[0].followSequence = 'exec private';
    await runtime.run('follow');
    expect(invoke.mock.calls.some(([, a]) => ['focus', 'click', 'right-click', 'key'].includes(a?.action))).toBe(false);
  });
});

describe('hotkey reconnect and partial registration', () => {
  it('shows the exact failed chords while retaining other registered bindings', async () => {
    state.settings.gameMacros.enabled = true;
    Object.assign(state.settings.gameMacros.commands[0], { hotkey: 'CTRL+F7' });
    invoke.mockImplementation(async (c, a) => (c === 'game_macro_bindings' && a.bindings.length ? ['test'] : null));
    await runtime.configure();
    expect(runtime.snapshot()).toMatchObject({ registered: true, hotkeyFailures: ['CTRL+F7'] });
    expect(runtime.snapshot().logs.join('\n')).toContain('CTRL+F7');
    invoke.mockImplementation(async c => (c === 'game_macro_input_idle' ? true : []));
    await runtime.reconnectInput();
    expect(runtime.snapshot()).toMatchObject({ registered: true, hotkeyFailures: [] });
    expect(runtime.snapshot().logs.join('\n')).toContain('Обработка ввода игрой не подтверждена');
  });
  it('does not turn on optional hotkeys or repeat when reconnecting', async () => {
    invoke.mockImplementation(async c => (c === 'game_macro_input_idle' ? true : []));
    await runtime.reconnectInput();
    expect(state.settings.gameMacros.enabled).not.toBe(true);
    expect(runtime.snapshot()).toMatchObject({ registered: false, mirrorKeys: false, mirrorMouse: false });
    expect(invoke.mock.calls.filter(([c]) => c === 'game_macro_bindings').every(([, a]) => !a.bindings.length)).toBe(
      true
    );
    expect(invoke.mock.calls.some(([c]) => c === 'game_macro_mirror')).toBe(false);
  });
  it('does not send game input if emergency-stop registration failed', async () => {
    invoke.mockImplementation(async c =>
      c === 'launcher_running_details' ? [client] : c === 'game_macro_bindings' ? ['stop'] : null
    );
    await runtime.run('test');
    expect(invoke.mock.calls.some(([c]) => c === 'game_macro_action')).toBe(false);
    expect(runtime.snapshot().notice).toContain('аварийная остановка');
  });
});

describe('unified primitive execution', () => {
  const clients = () => [client, { ...client, pid: 20, startedAt: 2000, hwnd: 200, title: 'Beta — Воин' }];
  const setup = async (raw, two = true) => {
    if (two) state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
    invoke.mockImplementation(async c => (c === 'launcher_running_details' ? (two ? clients() : [client]) : null));
    const { unifiedCommand } = await import('../js/modules/gameMacros/unified.js');
    state.settings.gameMacros.commands = [
      unifiedCommand({ id: 'unified', name: 'Общие шаги', returnTo: 'last', ...raw }, runtime.config())
    ];
  };
  it('runs F6 for followers before F1 for anyone and handles a party with only its leader', async () => {
    await setup({ action: 'f6f1', target: 'all' });
    await runtime.run('unified');
    const keys = () => invoke.mock.calls.filter(([, a]) => a?.action === 'key').map(([, a]) => [a.target.pid, a.key]);
    expect(keys()).toEqual([
      [20, 'F6'],
      [10, 'F1'],
      [20, 'F1']
    ]);
    state.characters.pop();
    invoke.mockImplementation(async c => (c === 'launcher_running_details' ? [client] : null));
    invoke.mockClear();
    await runtime.run('unified');
    expect(keys()).toEqual([[10, 'F1']]);
  });
  it('previews all click recipients first, then preserves the per-window follow key/click order', async () => {
    const point = { id: 'portrait', name: 'portrait', uiScale: '100%', x: 10, y: 20, width: 800, height: 600, dpi: 96 };
    state.settings.gameMacros.points = [point, { ...point, id: 'menu', x: 40 }];
    await setup({ action: 'follow', target: 'all', pointId: 'portrait', menuPointId: 'menu', resourceAllowed: true });
    await runtime.previewComposition('unified');
    await runtime.run('unified');
    const events = invoke.mock.calls.flatMap(([c, a]) =>
      c === 'game_macro_action' && a.action === 'key'
        ? [[a.target.pid, a.key]]
        : c === 'game_macro_action' && a.action === 'click'
          ? [[a.target.pid, 'left']]
          : c === 'game_macro_pointer' && !a.input.checkOnly
            ? [[a.target.pid, a.input.button]]
            : []
    );
    expect(events).toEqual([
      [10, 'SHIFT+1'],
      [10, 'right'],
      [10, 'left'],
      [20, 'SHIFT+1'],
      [20, 'right'],
      [20, 'left']
    ]);
    expect(runtime.snapshot().executionState).toBe('finished');
  });
  it('rejects a changed process identity between steps rather than retargeting or broadening input', async () => {
    await setup({ action: 'sequence', target: 'all', sequence: 'F1\nF2' });
    let changed = false;
    invoke.mockImplementation(async (c, a) => {
      if (c === 'launcher_running_details') return changed ? [{ ...client, startedAt: 1001 }, clients()[1]] : clients();
      if (c === 'game_macro_action' && a.action === 'key') changed = true;
      return null;
    });
    await runtime.run('unified');
    expect(invoke.mock.calls.filter(([, a]) => a?.action === 'key').map(([, a]) => a.key)).toEqual(['F1']);
    expect(runtime.snapshot().executionState).toBe('failed');
  });
});

it('resumes a composition waiting step through the always-available pause control, without a saved pause macro', async () => {
  state.settings.gameMacros.commands = [
    {
      id: 'wait',
      name: 'Ожидание',
      action: 'composite',
      returnTo: 'last',
      blocks: [{ target: 'all', partyId: 'p', steps: [{ type: 'pause' }, { type: 'keys', value: 'F2' }] }]
    }
  ];
  const running = runtime.run('wait');
  await vi.waitFor(() => expect(runtime.snapshot().paused).toBe(true));
  runtime.togglePause();
  await running;
  expect(runtime.snapshot()).toMatchObject({ paused: false, executionState: 'finished' });
  expect(invoke.mock.calls.some(([, a]) => a?.key === 'F2')).toBe(true);
});

it('retains explicit all-managed-window F6/F1 routing, validates the PL, and refuses unknown windows before input', async () => {
  const { unifiedCommand } = await import('../js/modules/gameMacros/unified.js');
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['q'] });
  const beta = { ...client, pid: 20, startedAt: 2000, hwnd: 200, title: 'Beta — Воин' };
  state.settings.gameMacros.commands = [
    unifiedCommand(
      { id: 'global', name: 'Общий проход', action: 'f6f1', scope: 'managed', target: 'all', returnTo: 'last' },
      runtime.config()
    )
  ];
  invoke.mockImplementation(async c => (c === 'launcher_running_details' ? [client, beta] : null));
  await runtime.run('global');
  expect(invoke.mock.calls.filter(([, a]) => a?.action === 'key').map(([, a]) => [a.target.pid, a.key])).toEqual([
    [20, 'F6'],
    [10, 'F1'],
    [20, 'F1']
  ]);
  invoke.mockClear();
  invoke.mockImplementation(async c =>
    c === 'launcher_running_details' ? [client, { ...beta, title: 'Perfect World' }] : null
  );
  await runtime.run('global');
  expect(invoke.mock.calls.some(([, a]) => a?.action === 'key')).toBe(false);
  expect(runtime.snapshot().executionState).toBe('failed');
});

it('fails closed for strict laboratory recipients instead of widening to every running game', async () => {
  state.settings.gameMacros.commands = [
    {
      id: 'strict',
      name: 'Лаборатория',
      action: 'sequence',
      sequence: 'B',
      delivery: 'background',
      backgroundMethod: 'activity-window',
      target: 'subset',
      charIds: ['missing'],
      strictTargets: true
    }
  ];
  await runtime.run('strict');
  expect(invoke.mock.calls.some(([, args]) => args?.action === 'key-background' || args?.action === 'key')).toBe(false);
  expect(runtime.snapshot().executionState).toBe('failed');
});
it('executes an ephemeral trial once for exactly one twin without saving or changing focus', async () => {
  state.parties = [{ id: 'p', name: 'Party' }];
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
  const twin = { ...client, pid: 20, hwnd: 200, title: 'Beta — Воин' };
  invoke.mockImplementation(async (name, args) =>
    name === 'launcher_running_details'
      ? [client, twin]
      : args?.action === 'key-background'
        ? { schema: 1, ok: true, inputSent: true }
        : null
  );
  const before = JSON.stringify(state.settings.gameMacros);
  const result = await runtime.runBackgroundTrial({ partyId: 'p', charId: 'b', key: 'B', method: 'post' });
  const actions = invoke.mock.calls.filter(([, args]) => args?.action === 'key-background');
  expect(actions).toHaveLength(1);
  expect(actions[0][1]).toMatchObject({ target: { pid: 20 }, key: 'B' });
  expect(invoke.mock.calls.some(([, args]) => args?.action === 'focus' || args?.action === 'key')).toBe(false);
  expect(result.state).toBe('finished');
  expect(JSON.stringify(state.settings.gameMacros)).toBe(before);
});
it('refuses a trial for the leader before any IPC', async () => {
  await expect(runtime.runBackgroundTrial({ partyId: 'p', charId: 'a', key: 'B', method: 'post' })).rejects.toThrow(
    /твина/
  );
  expect(invoke).not.toHaveBeenCalled();
});
it('does not broaden an ephemeral trial to other windows when its recipient is missing', async () => {
  state.parties = [{ id: 'p' }];
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
  const result = await runtime.runBackgroundTrial({ partyId: 'p', charId: 'b', key: 'B', method: 'activity-window' });
  expect(result.state).toBe('failed');
  expect(
    invoke.mock.calls.some(
      ([, args]) => args?.action === 'key-background' || args?.action === 'key' || args?.action === 'focus'
    )
  ).toBe(false);
});
it('records only one final command completion after restoring bindings', async () => {
  state.settings.gameMacros.commands[0].sequence = 'B';
  await runtime.run('test');
  expect(runtime.snapshot().logs.filter(line => line.includes('Завершена: test.'))).toHaveLength(1);
  expect(runtime.snapshot().logEntries.at(-1).terminal).toBe(true);
});
it('passes an independent active-window mouse modifier without requiring a twins-only leader', async () => {
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
  state.settings.gameMacros.mirrorActiveModifier = 'SHIFT';
  invoke.mockImplementation(async (name, args) =>
    name === 'launcher_running_details'
      ? [client, { ...client, pid: 20, title: 'Beta — Воин' }]
      : name === 'game_macro_mirror'
        ? args.operation === 'start'
        : null
  );
  await runtime.toggleKeyboardMirror('mouse');
  const start = invoke.mock.calls.find(([name, args]) => name === 'game_macro_mirror' && args.operation === 'start');
  expect(start[1]).toMatchObject({ activeModifier: 'SHIFT', mouse: true, keyboard: false, twinsModifier: null });
  expect(runtime.snapshot().mirrorMouse).toBe(true);
  await runtime.toggleKeyboardMirror('mouse');
});
it('summarizes physical-release polling without hundreds of false error events', async () => {
  let checks = 0;
  state.settings.gameMacros.commands[0].sequence = 'B';
  invoke.mockImplementation(async name =>
    name === 'launcher_running_details' ? [client] : name === 'game_macro_input_idle' ? ++checks > 4 : null
  );
  await runtime.run('test');
  const trace = runtime.getExecutionHistory().at(-1);
  expect(trace.events.filter(event => event.stage === 'physical-input-wait')).toHaveLength(1);
  expect(trace.events.find(event => event.stage === 'physical-input-released').details.attempt).toBe(4);
  expect(trace.events.some(event => event.stage === 'native:game_macro_input_idle')).toBe(false);
  expect(runtime.snapshot().executionState).toBe('finished');
});

it('executes multi-group activity-notify assist chains on exact recipients without focus restoration', async () => {
  const beta = { pid: 20, startedAt: 2000, hwnd: 200, elevated: false, title: 'Beta — Воин' };
  state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
  state.settings.gameMacros.commands = [
    {
      id: 'assist',
      name: 'Ассист',
      action: 'composite',
      returnTo: 'leader',
      blocks: [
        {
          target: 'subset',
          charIds: ['b'],
          scope: 'party',
          delivery: 'background',
          backgroundMethod: 'activity-notify',
          steps: [
            { type: 'keys', value: 'SHIFT+1' },
            { type: 'wait', ms: 50 },
            { type: 'keys', value: 'F2' }
          ]
        },
        {
          target: 'subset',
          charIds: ['a'],
          scope: 'party',
          delivery: 'background',
          backgroundMethod: 'activity-notify',
          steps: [{ type: 'keys', value: 'F3' }]
        }
      ]
    }
  ];
  invoke.mockImplementation(async name => (name === 'launcher_running_details' ? [client, beta] : null));
  await runtime.run('assist');
  expect(runtime.snapshot().executionState, runtime.snapshot().logs.join('\n')).toBe('finished');
  const actions = invoke.mock.calls.filter(([name]) => name === 'game_macro_action').map(([, args]) => args);
  const keys = actions.filter(args => args.action === 'key-background');
  expect(keys.map(args => [args.target.pid, args.key, args.timing.backgroundMethod])).toEqual([
    [20, 'SHIFT+1', 'activity-notify'],
    [20, 'F2', 'activity-notify'],
    [10, 'F3', 'activity-notify']
  ]);
  expect(actions.some(args => args.action === 'focus' || args.action === 'key')).toBe(false);
});

it('does not broaden an explicitly marked managed subset on failed target resolution', async () => {
  const c = runtime.config();
  await expect(
    runtime.windowTargets(
      { action: 'sequence', scope: 'managed', target: 'subset', allowManagedSubset: true, charIds: ['missing'] },
      c
    )
  ).rejects.toThrow();
  expect(invoke.mock.calls.some(([name]) => name === 'game_macro_action')).toBe(false);
});

it('waits for native stop acknowledgement before a new foreground/input operation', async () => {
  let acknowledge;
  const pending = new Promise(resolve => {
    acknowledge = resolve;
  });
  invoke.mockImplementation(async command => {
    if (command === 'game_macro_input_stop') return pending;
    return command === 'launcher_running_details' ? [client] : null;
  });
  runtime.stop();
  const next = runtime.run('test');
  try {
    await vi.waitFor(
      () => expect(invoke.mock.calls.some(([command]) => command === 'game_macro_input_stop')).toBe(true),
      { timeout: 10000 }
    );
    expect(invoke.mock.calls.some(([command]) => command === 'game_macro_action')).toBe(false);
  } finally {
    acknowledge(null);
    await next;
  }
  expect(invoke.mock.calls.some(([, args]) => args?.action === 'key')).toBe(true);
});
it('refuses new input when native stop was not acknowledged without leaking the exception', async () => {
  invoke.mockImplementation(async command => {
    if (command === 'game_macro_input_stop') throw new Error('private token');
    return command === 'launcher_running_details' ? [client] : null;
  });
  runtime.stop();
  await runtime.run('test');
  expect(invoke.mock.calls.some(([command]) => command === 'game_macro_action')).toBe(false);
  expect(runtime.snapshot().logs.join('\n')).not.toContain('private token');
  expect(runtime.snapshot().logs.join('\n')).toContain('перезапустите приложение');
});
it('keeps foreground execution out of the persistent background journal', async () => {
  const journal = await import('../js/modules/gameMacros/backgroundJournal.js');
  const before = journal.backgroundJournalEntries().length;
  state.settings.gameMacros.commands[0].sequence = 'F8';
  await runtime.run('test');
  expect(journal.backgroundJournalEntries()).toHaveLength(before);
  state.settings.gameMacros.commands[0].delivery = 'background';
  await runtime.run('test');
  expect(journal.backgroundJournalEntries().length).toBeGreaterThan(before);
  expect(journal.backgroundJournalEntries().some(row => row.stage === 'native-background-start')).toBe(true);
});
it('cancels the armed comparison before any native key operation', async () => {
  vi.useFakeTimers();
  try {
    const pending = runtime.runInputComparison({ charId: 'a', key: 'B', method: 'active-post' }).catch(e => e);
    await vi.advanceTimersByTimeAsync(1000);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeInstanceOf(Error);
    expect(invoke.mock.calls.some(([command]) => command === 'game_macro_compare_once')).toBe(false);
    expect(runtime.snapshot().busy).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it('comparison sends one snapshotted target without any focus/restore or automatic repetition', async () => {
  vi.useFakeTimers();
  try {
    invoke.mockImplementation(async command =>
      command === 'launcher_running_details'
        ? [client]
        : command === 'game_macro_compare_once'
          ? { ok: true, gameEffect: 'unknown' }
          : null
    );
    const pending = runtime.runInputComparison({ charId: 'a', key: 'B', method: 'active-post' });
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.gameEffect).toBe('unknown');
    expect(invoke.mock.calls.filter(([command]) => command === 'game_macro_compare_once')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('game_macro_compare_once', {
      target: { pid: 10, startedAt: 1000, hwnd: 100 },
      key: 'B',
      method: 'active-post'
    });
    expect(invoke.mock.calls.some(([command]) => command === 'game_macro_action')).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

describe('bounded concurrent multi-client comparison', () => {
  const selection = { charIds: ['a', 'b'], steps: [{ key: 'B' }, { wait: 500 }, { key: 'CTRL+B' }] };
  const second = { ...client, pid: 20, startedAt: 2000, hwnd: 200, title: 'Beta — Воин' };
  const prepare = () => {
    state.characters.push({ id: 'b', nick: 'Beta', partyIds: ['p'] });
    invoke.mockImplementation(async command =>
      command === 'launcher_running_details'
        ? [client, second]
        : command === 'game_macro_compare_many'
          ? {
              ok: true,
              recipients: [
                { pid: 10, ok: true, steps: [] },
                { pid: 20, ok: true, steps: [] }
              ]
            }
          : null
    );
  };
  it('uses one native batch with fixed target identities and no focus command', async () => {
    await import('../js/modules/gameMacros/multiInputTrial.js');
    vi.useFakeTimers();
    try {
      prepare();
      const pending = runtime.runMultiInputTrial(selection);
      await vi.advanceTimersByTimeAsync(6000);
      expect((await pending).ok).toBe(true);
      expect(invoke.mock.calls.filter(([c]) => c === 'game_macro_compare_many')).toHaveLength(1);
      expect(invoke).toHaveBeenCalledWith('game_macro_compare_many', {
        targets: [
          { pid: 10, startedAt: 1000, hwnd: 100 },
          { pid: 20, startedAt: 2000, hwnd: 200 }
        ],
        steps: selection.steps,
        timing: { timeoutMs: 25, modifierGapMs: 0 }
      });
      expect(invoke.mock.calls.some(([c]) => c === 'game_macro_action')).toBe(false);
      expect(runtime.snapshot().busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('Stop prevents the batch from being sent during countdown', async () => {
    await import('../js/modules/gameMacros/multiInputTrial.js');
    vi.useFakeTimers();
    try {
      prepare();
      const pending = runtime.runMultiInputTrial(selection).catch(e => e);
      await vi.advanceTimersByTimeAsync(1000);
      runtime.stop();
      await vi.advanceTimersByTimeAsync(6000);
      expect(await pending).toBeInstanceOf(Error);
      expect(invoke.mock.calls.some(([c]) => c === 'game_macro_compare_many')).toBe(false);
      expect(runtime.snapshot().busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('refuses overlapping commands while a native batch is still running', async () => {
    await import('../js/modules/gameMacros/multiInputTrial.js');
    vi.useFakeTimers();
    try {
      prepare();
      let release;
      invoke.mockImplementation(async command =>
        command === 'launcher_running_details'
          ? [client, second]
          : command === 'game_macro_compare_many'
            ? await new Promise(r => (release = r))
            : null
      );
      const pending = runtime.runMultiInputTrial(selection);
      await vi.advanceTimersByTimeAsync(6000);
      await expect(runtime.runMultiInputTrial(selection)).rejects.toThrow();
      expect(runtime.snapshot().busy).toBe(true);
      release({ ok: true, recipients: [] });
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
  it('refuses missing windows before arming any input', async () => {
    state.characters.push({ id: 'b', nick: 'Beta' });
    await expect(runtime.runMultiInputTrial(selection)).rejects.toThrow();
    expect(invoke.mock.calls.some(([c]) => c === 'game_macro_compare_many')).toBe(false);
  });
});

it('passes explicit timing parameters through the validated one-client batch', async () => {
  await import('../js/modules/gameMacros/multiInputTrial.js');
  vi.useFakeTimers();
  try {
    invoke.mockImplementation(async c =>
      c === 'launcher_running_details'
        ? [client]
        : c === 'game_macro_compare_many'
          ? { ok: true, recipients: [] }
          : null
    );
    const pending = runtime.runMultiInputTrial({
      charIds: ['a'],
      steps: [{ key: 'SHIFT+1' }],
      timing: { timeoutMs: 100, modifierGapMs: 50 }
    });
    await vi.advanceTimersByTimeAsync(6000);
    await pending;
    expect(invoke).toHaveBeenCalledWith('game_macro_compare_many', {
      targets: [{ pid: 10, startedAt: 1000, hwnd: 100 }],
      steps: [{ key: 'SHIFT+1' }],
      timing: { timeoutMs: 100, modifierGapMs: 50 }
    });
  } finally {
    vi.useRealTimers();
  }
});
