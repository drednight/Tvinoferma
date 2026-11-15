import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handlers: new Map(), invoke: vi.fn(), persist: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => mocks.invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, handler) => {
    mocks.handlers.set(name, handler);
    return () => mocks.handlers.delete(name);
  }),
  emitTo: vi.fn(async () => {})
}));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));
let state, runtime;
beforeEach(async () => {
  vi.resetModules();
  vi.doMock('@tauri-apps/api/event', () => ({
    listen: async (name, handler) => {
      mocks.handlers.set(name, handler);
      return () => mocks.handlers.delete(name);
    },
    emitTo: async () => {}
  }));
  mocks.handlers.clear();
  mocks.invoke.mockReset();
  mocks.persist.mockClear();
  window.__TAURI_INTERNALS__ = {};
  ({ state } = await import('../js/core/state.js'));
  state.parties = [{ id: 'p', name: 'Пати' }];
  state.characters = [{ id: 'a', nick: 'Alpha', partyIds: ['p'] }];
  state.settings.gameMacros = { partyId: 'p' };
  mocks.invoke.mockImplementation(async command =>
    command === 'game_macro_overlay'
      ? 'opened'
      : command === 'launcher_running_details'
        ? [{ pid: 10, startedAt: 1000, hwnd: 100, elevated: false, title: 'Alpha — Воин' }]
        : null
  );
  runtime = await import('../js/modules/gameMacros/runtime.js');
});
it('restores saved physical overlay position on opening', async () => {
  state.settings.gameMacros.overlayPosition = { x: -1200, y: 90 };
  await runtime.openOverlay();
  expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay', {
    topmost: true,
    position: { x: -1200, y: 90 },
    existingOnly: false
  });
});
it('debounces move events and persists the last position', async () => {
  await runtime.initGameMacros();
  mocks.handlers.get('game-overlay-position')({ payload: { x: 80, y: 90 } });
  mocks.handlers.get('game-overlay-position')({ payload: { x: 120, y: 150 } });
  await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledTimes(1));
  expect(runtime.config().overlayPosition).toEqual({ x: 120, y: 150 });
});
it('applies overlay appearance without opening a hidden overlay', async () => {
  await runtime.applyOverlayPreferences();
  expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay', expect.objectContaining({ existingOnly: true }));
});
it('sets the same party for buff and other commands when a party is launched', async () => {
  await runtime.selectMacroParty('p');
  expect(runtime.config().partyId).toBe('p');
  expect(runtime.config().buffPartyId).toBe('p');
  expect(mocks.persist).toHaveBeenCalled();
});
it('captures a moved marker without requiring a game click or a UI scale input', async () => {
  const promise = runtime.pickPoint('a', 'Свиток воскрешения');
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      'game_macro_guide',
      expect.objectContaining({ mode: 'point', target: { pid: 10, startedAt: 1000 } })
    )
  );
  expect(mocks.invoke.mock.calls.some(([, args]) => args?.action === 'click')).toBe(false);
  const requestId = mocks.invoke.mock.calls.find(([, args]) => args?.mode === 'point')[1].requestId;
  mocks.handlers.get('game-macro-picked')({ payload: { requestId: 'old', cancelled: true } });
  mocks.handlers.get('game-macro-picked')({
    payload: { requestId, geometry: { x: 20, y: 30, width: 2560, height: 1400, dpi: 144 } }
  });
  const point = await promise;
  expect(point).toMatchObject({ name: 'Свиток воскрешения', x: 20, y: 30, width: 2560, height: 1400, dpi: 144 });
  expect(runtime.config().points).toHaveLength(1);
  expect(runtime.snapshot().busy).toBe(false);
});
it('does not retain a point if marker selection is cancelled', async () => {
  const promise = runtime.pickPoint('a', 'Отмена');
  const rejection = expect(promise).rejects.toThrow('отменено');
  await vi.waitFor(() => expect(mocks.handlers.has('game-macro-picked')).toBe(true));
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([, args]) => args?.mode === 'point')).toBe(true));
  const requestId = mocks.invoke.mock.calls.find(([, args]) => args?.mode === 'point')[1].requestId;
  mocks.handlers.get('game-macro-picked')({ payload: { requestId, cancelled: true } });
  await rejection;
  expect(runtime.config().points).toEqual([]);
  expect(runtime.snapshot().busy).toBe(false);
});
it('calibrates an existing point as an uncommitted draft without changing its ID or command references', async () => {
  const original = { id: 'kept', name: 'Старая', uiScale: '100%', x: 5, y: 7, width: 2560, height: 1400, dpi: 144 };
  state.settings.gameMacros.points = [original];
  const pending = runtime.pickPoint('a', 'Черновик', 'kept', 'p', true, original);
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([, a]) => a?.mode === 'point')).toBe(true));
  const args = mocks.invoke.mock.calls.find(([, a]) => a?.mode === 'point')[1];
  expect(args.initialPoint).toEqual(original);
  mocks.handlers.get('game-macro-picked')({
    payload: { requestId: args.requestId, geometry: { x: 100, y: 200, width: 2560, height: 1400, dpi: 144 } }
  });
  expect(await pending).toMatchObject({ id: 'kept', name: 'Черновик', x: 100, y: 200 });
  expect(runtime.config().points[0]).toEqual(original);
});

it('honors native emergency stop while ordinary hotkeys are suspended and disabled', async () => {
  state.settings.gameMacros.commands = [{ id: 'slow', action: 'sequence', target: 'all', sequence: 'wait 500\nF7' }];
  await runtime.initGameMacros();
  const running = runtime.run('slow');
  await vi.waitFor(() => expect(runtime.snapshot().busy).toBe(true));
  mocks.handlers.get('game-macro-hotkey')({ payload: 'stop' });
  await running;
  expect(runtime.snapshot().executionState).toBe('stopped');
  expect(mocks.invoke.mock.calls.some(([, a]) => a?.action === 'key')).toBe(false);
});
it('logs native opening and correlates frontend acknowledgement, ignoring stale replies', async () => {
  vi.useFakeTimers();
  try {
    await runtime.openOverlay();
    const id = runtime.snapshot().overlayOpenRequest;
    expect(id).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith('game_macro_overlay', expect.objectContaining({ existingOnly: false }));
    const ack = mocks.handlers.get('game-overlay-opened');
    ack({ payload: { requestId: 'stale' } });
    expect(runtime.snapshot().overlayOpenRequest).toBe(id);
    ack({ payload: { requestId: id } });
    expect(runtime.snapshot().overlayOpenRequest).toBe('');
    await vi.advanceTimersByTimeAsync(5001);
    expect(runtime.snapshot().logs.join('\n')).toContain('подтвердил связь');
    expect(runtime.snapshot().logs.join('\n')).not.toContain('нет подтверждения интерфейса');
  } finally {
    vi.useRealTimers();
  }
});
it('reports missing frontend acknowledgement separately from native show success', async () => {
  vi.useFakeTimers();
  try {
    await runtime.openOverlay();
    await vi.advanceTimersByTimeAsync(5001);
    expect(runtime.snapshot().logs.join('\n')).toContain('нет подтверждения интерфейса');
  } finally {
    vi.useRealTimers();
  }
});
it('logs failed overlay creation without silently claiming it opened', async () => {
  mocks.invoke.mockImplementation(async name => {
    if (name === 'game_macro_overlay') throw new Error('Оверлей: создание окна не удалось');
    return null;
  });
  await expect(runtime.openOverlay()).rejects.toThrow('создание окна');
  expect(runtime.snapshot().logs.join('\n')).toContain('открытие не завершено');
});

it('saves recipient exclusions from an overlay snapshot and leaves unseen exclusions unchanged', async () => {
  state.settings.gameMacros.excludedCommandCharacters = ['offline'];
  await runtime.overlayRecipientAction({ action: 'refresh' });
  const snapshot = runtime.snapshot().recipients;
  expect(snapshot.rows).toEqual([expect.objectContaining({ charId: 'a', selected: true })]);
  await runtime.overlayRecipientAction({ action: 'save', revision: snapshot.revision, selected: [], leader: null });
  expect(runtime.config().excludedCommandCharacters).toEqual(['offline', 'a']);
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  expect(runtime.snapshot().recipients).toBeNull();
});
it('rejects stale or forged overlay selections without saving or widening', async () => {
  await runtime.overlayRecipientAction({ action: 'refresh' });
  const { revision } = runtime.snapshot().recipients;
  await runtime.overlayRecipientAction({ action: 'save', revision, selected: ['invented'] });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(runtime.snapshot().recipientNotice).toContain('отсутствует');
  mocks.invoke.mockImplementation(async command => (command === 'launcher_running_details' ? [] : null));
  await runtime.overlayRecipientAction({ action: 'save', revision, selected: ['a'] });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(runtime.snapshot().recipientNotice).toContain('изменился');
});
it('assigns a checked running character as leader only after an explicit choice', async () => {
  await runtime.overlayRecipientAction({ action: 'refresh' });
  const { revision, options } = runtime.snapshot().recipients;
  expect(options).toContainEqual(expect.objectContaining({ partyId: 'p', charId: 'a' }));
  expect(runtime.config().leaders.p).toBeUndefined();
  await runtime.overlayRecipientAction({
    action: 'save',
    revision,
    selected: ['a'],
    leader: { partyId: 'p', charId: 'a' }
  });
  expect(runtime.config().leaders.p).toBe('a');
  expect(runtime.config().partyId).toBe('p');
  expect(mocks.persist).toHaveBeenCalled();
});
it('rolls back the overlay selection when persistence fails', async () => {
  await runtime.overlayRecipientAction({ action: 'refresh' });
  const { revision } = runtime.snapshot().recipients;
  mocks.persist.mockRejectedValueOnce(new Error('диск недоступен'));
  await runtime.overlayRecipientAction({ action: 'save', revision, selected: [] });
  expect(runtime.config().excludedCommandCharacters).toEqual([]);
  expect(runtime.snapshot().recipientNotice).toContain('диск недоступен');
});

it('rejects an unchecked leader and detects settings changed in the main window', async () => {
  await runtime.overlayRecipientAction({ action: 'refresh' });
  const { revision } = runtime.snapshot().recipients;
  await runtime.overlayRecipientAction({
    action: 'save',
    revision,
    selected: [],
    leader: { partyId: 'p', charId: 'a' }
  });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(runtime.snapshot().recipientNotice).toContain('выбранным');
  state.settings.gameMacros.excludedCommandCharacters = ['a'];
  await runtime.overlayRecipientAction({ action: 'save', revision, selected: ['a'] });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(runtime.config().excludedCommandCharacters).toEqual(['a']);
  expect(runtime.snapshot().recipientNotice).toContain('изменился');
});

it('serializes rapid toggles and cancels the opening confirmation on close', async () => {
  vi.useFakeTimers();
  try {
    let release;
    const first = new Promise(resolve => {
      release = resolve;
    });
    let count = 0;
    mocks.invoke.mockImplementation(async name => {
      if (name === 'game_macro_overlay') return ++count === 1 ? first : 'closed';
      return null;
    });
    const opening = runtime.openOverlay();
    const closing = runtime.openOverlay();
    await vi.waitFor(() => expect(count).toBe(1));
    release('opened');
    await Promise.all([opening, closing]);
    expect(count).toBe(2);
    expect(runtime.snapshot().overlayOpenRequest).toBe('');
    await vi.advanceTimersByTimeAsync(5001);
    expect(runtime.snapshot().logs.join('\n')).toContain('окно скрыто');
    expect(runtime.snapshot().logs.join('\n')).not.toContain('нет подтверждения интерфейса');
  } finally {
    vi.useRealTimers();
  }
});

it('opens again after closing and starts a new confirmation request', async () => {
  const replies = ['opened', 'closed', 'opened'];
  mocks.invoke.mockImplementation(async name => (name === 'game_macro_overlay' ? replies.shift() : null));
  await runtime.openOverlay();
  const first = runtime.snapshot().overlayOpenRequest;
  await runtime.openOverlay();
  expect(runtime.snapshot().overlayOpenRequest).toBe('');
  await runtime.openOverlay();
  const reopened = runtime.snapshot().overlayOpenRequest;
  expect(reopened).toBeTruthy();
  expect(reopened).not.toBe(first);
  mocks.handlers.get('game-overlay-opened')({ payload: { requestId: first } });
  expect(runtime.snapshot().overlayOpenRequest).toBe(reopened);
  mocks.handlers.get('game-overlay-opened')({ payload: { requestId: reopened } });
});

it('does not claim an opening when native toggle returns an unknown result', async () => {
  mocks.invoke.mockImplementation(async () => null);
  await expect(runtime.openOverlay()).rejects.toThrow('Не удалось подтвердить состояние');
  expect(runtime.snapshot().overlayOpenRequest).toBe('');
});
