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
  expect(runtime.snapshot().windows).toEqual([{ name: 'Alpha', pid: 10, known: true }]);
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
