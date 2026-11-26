import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

describe('оверлей: встроенный выбор состава пати', () => {
  const mocks = {
    invoke: vi.fn(async () => {}),
    emitTo: vi.fn(async () => {}),
    handlers: new Map()
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
    vi.doMock('@tauri-apps/api/event', () => ({
      listen: async (name, handler) => {
        mocks.handlers.set(name, handler);
        return () => {};
      },
      emitTo: mocks.emitTo
    }));
    vi.doMock('@tauri-apps/api/window', () => ({
      getCurrentWindow: () => ({ startDragging: vi.fn(), close: vi.fn() })
    }));
    document.documentElement.innerHTML = new DOMParser().parseFromString(
      readFileSync('game-overlay.html', 'utf8'),
      'text/html'
    ).documentElement.innerHTML;
    await import('../js/modules/gameMacros/overlay.js');
    await vi.waitFor(() => expect(document.querySelector('#party-launch').onclick).toBeTypeOf('function'));
  });

  it('показывает встроенный список с бейджем «уже запущено» и отправляет только отмеченные memberIds', async () => {
    mocks.handlers.get('game-macro-snapshot')({
      payload: {
        askBeforeLaunch: true,
        parties: [
          {
            id: 'p1',
            name: 'Основа',
            members: [
              { id: 'c', nick: 'Вв', cls: 'Жрец' },
              { id: 'a', nick: 'Аа', cls: 'Воин' },
              { id: 'b', nick: 'Бб', cls: 'Маг' }
            ]
          }
        ],
        partyId: 'p1',
        windows: [{ name: 'Аа', pid: 10, known: true }]
      }
    });

    document.querySelector('[data-view="party"]').click();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'party-refresh', partyId: 'p1' })
    );
    mocks.handlers.get('game-macro-snapshot')({
      payload: {
        askBeforeLaunch: true,
        busy: false,
        parties: [
          {
            id: 'p1',
            name: 'Основа',
            members: [
              { id: 'c', nick: 'Вв', cls: 'Жрец' },
              { id: 'a', nick: 'Аа', cls: 'Воин' },
              { id: 'b', nick: 'Бб', cls: 'Маг' }
            ]
          }
        ],
        partyId: 'p1',
        windows: [{ name: 'Аа', pid: 10, known: true }]
      }
    });
    mocks.invoke.mockClear();
    mocks.emitTo.mockClear();

    expect(document.querySelector('#party-launch').disabled).toBe(false);
    document.querySelector('#party-launch').click();
    const picker = document.querySelector('#party-launch-picker');
    expect(picker.hidden).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'game_macro_navigate',
      expect.objectContaining({ action: 'party-launch' })
    );

    const rows = [...document.querySelectorAll('#party-picker-list .plp-ov-row')];
    expect(rows).toHaveLength(3);
    expect(rows[1].querySelector('.plp-ov-badge').textContent).toBe('уже запущено');
    expect(document.querySelector('#party-picker-count').textContent).toBe('Запустить: 3 из 3');

    // Снимаем Бб
    const boxB = rows[2].querySelector('input[type="checkbox"]');
    boxB.checked = false;
    document.querySelector('#party-picker-list').dispatchEvent(new Event('change'));
    expect(document.querySelector('#party-picker-confirm').textContent).toBe('▶ Запустить (2)');

    document.querySelector('#party-picker-confirm').click();
    await vi.waitFor(() =>
      expect(mocks.emitTo).toHaveBeenCalledWith('main', 'game-overlay-party', {
        action: 'party-launch',
        partyId: 'p1',
        memberIds: ['c', 'a']
      })
    );
    expect(picker.hidden).toBe(true);
  });

  it('при снятии всех кнопка запуска блокируется, а при askBeforeLaunch: false список не открывается', async () => {
    mocks.handlers.get('game-macro-snapshot')({
      payload: {
        askBeforeLaunch: true,
        parties: [
          {
            id: 'p1',
            name: 'Основа',
            members: [
              { id: 'a', nick: 'Аа', cls: 'Воин' },
              { id: 'b', nick: 'Бб', cls: 'Маг' }
            ]
          }
        ],
        partyId: 'p1',
        windows: []
      }
    });
    document.querySelector('#party-launch').click();
    document.querySelector('#party-picker-none').click();
    expect(document.querySelector('#party-picker-confirm').disabled).toBe(true);
    document.querySelector('#party-picker-cancel').click();
    expect(document.querySelector('#party-launch-picker').hidden).toBe(true);

    mocks.handlers.get('game-macro-snapshot')({
      payload: {
        askBeforeLaunch: false,
        parties: [
          {
            id: 'p1',
            name: 'Основа',
            members: [
              { id: 'a', nick: 'Аа', cls: 'Воин' },
              { id: 'b', nick: 'Бб', cls: 'Маг' }
            ]
          }
        ],
        partyId: 'p1',
        windows: []
      }
    });
    mocks.invoke.mockClear();
    expect(document.querySelector('#party-launch').disabled).toBe(false);
    document.querySelector('#party-launch').click();
    expect(document.querySelector('#party-launch-picker').hidden).toBe(true);
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('game_macro_navigate', { action: 'party-launch', partyId: 'p1' })
    );
  });

  it('«Кого запускать…» в оверлее работает всегда: список при выключенном спросе', async () => {
    mocks.handlers.get('game-macro-snapshot')({
      payload: {
        askBeforeLaunch: false,
        busy: false,
        parties: [
          {
            id: 'p1',
            name: 'Основа',
            members: [
              { id: 'a', nick: 'Аа', cls: 'Воин' },
              { id: 'b', nick: 'Бб', cls: 'Маг' }
            ]
          }
        ],
        partyId: 'p1',
        windows: []
      }
    });
    const pick = document.querySelector('#party-launch-pick');
    expect(pick).toBeTruthy();
    expect(pick.textContent).toContain('Кого запускать');
    expect(pick.disabled).toBe(false);

    pick.click();
    const picker = document.querySelector('#party-launch-picker');
    expect(picker.hidden).toBe(false);
    expect([...document.querySelectorAll('#party-picker-list .plp-ov-row')]).toHaveLength(2);
    document.querySelector('#party-picker-confirm').click();
    await vi.waitFor(() =>
      expect(mocks.emitTo).toHaveBeenCalledWith('main', 'game-overlay-party', {
        action: 'party-launch',
        partyId: 'p1',
        memberIds: ['a', 'b']
      })
    );
  });
});

describe('runtime: фильтрация memberIds при party-launch из оверлея', () => {
  const invoke = vi.fn(async () => ({}));
  const launchPartyByName = vi.fn(async () => [{ ok: true }]);

  beforeEach(async () => {
    vi.resetModules();
    invoke.mockReset();
    launchPartyByName.mockClear();
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    vi.doMock('@tauri-apps/api/event', () => ({
      listen: vi.fn(async () => () => {}),
      emitTo: vi.fn(async () => {})
    }));
    vi.doMock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), isTauri: () => true }));
    vi.doMock('../js/modules/launcher/partyLaunch.js', () => ({
      launchPartyByName
    }));
  });

  it('отбрасывает неизвестные id, пишет в журнал и передаёт валидные в порядке пати', async () => {
    const { state } = await import('../js/core/state.js');
    const runtime = await import('../js/modules/gameMacros/runtime.js');
    state.parties = [{ id: 'p1', name: 'Основа' }];
    state.characters = [
      { id: 'a', nick: 'Аа', partyIds: ['p1'], partyOrder: { p1: 2 } },
      { id: 'b', nick: 'Бб', partyIds: ['p1'], partyOrder: { p1: 3 } },
      { id: 'c', nick: 'Вв', partyIds: ['p1'], partyOrder: { p1: 1 } }
    ];

    await runtime.overlayPartyAction({
      action: 'party-launch',
      partyId: 'p1',
      memberIds: ['a', 'unknown-id', 'c']
    });

    expect(launchPartyByName).toHaveBeenCalledTimes(1);
    expect(launchPartyByName.mock.calls[0][1].memberIds).toEqual(['c', 'a']);
    expect(runtime.snapshot().logs.join('\n')).toContain('unknown-id');
  });

  it('при пустом списке memberIds возвращает ошибку «Выберите хотя бы одного» и не запускает', async () => {
    const { state } = await import('../js/core/state.js');
    const runtime = await import('../js/modules/gameMacros/runtime.js');
    state.parties = [{ id: 'p1', name: 'Основа' }];
    state.characters = [{ id: 'a', nick: 'Аа', partyIds: ['p1'] }];

    await runtime.overlayPartyAction({
      action: 'party-launch',
      partyId: 'p1',
      memberIds: []
    });

    expect(launchPartyByName).not.toHaveBeenCalled();
    expect(runtime.snapshot().windowNotice).toContain('Выберите хотя бы одного');
    expect(runtime.snapshot().busy).toBe(false);
  });
});
