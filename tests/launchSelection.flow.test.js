import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.fn(async () => ({}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), isTauri: () => true }));
vi.mock('../js/core/ui.js', async orig => {
  const actual = await orig();
  return { ...actual, toast: vi.fn(), confirmModal: vi.fn(async () => true) };
});
vi.mock('../js/modules/sync/queue.js', async orig => ({ ...(await orig()), sleep: async () => {} }));

const GC1 = { id: 'gc-1', name: 'Папка 1', path: 'D:\\GC1\\GameCenter.exe' };
const ch = (id, nick, order) => ({
  id,
  nick,
  class: 'Воин',
  partyIds: ['p1'],
  mainPartyId: 'p1',
  partyOrder: { p1: order },
  launch: { gcIds: ['gc-1'], gcAccounts: { 'gc-1': { nick } } }
});

let state, partyLaunch, renderPartiesGrid, mergeSettings;
const started = () =>
  invoke.mock.calls.filter(c => c[0] === 'launcher_start').map(c => String(c[1].charId).split('@')[0]);
const pickerDialog = () => document.querySelector('.tf-dialog');

beforeEach(async () => {
  window.localStorage.clear();
  document.body.innerHTML = '<div id="party-summary"></div><div id="party-list"></div><div id="modal-root"></div>';
  invoke.mockReset();
  invoke.mockImplementation(async cmd => {
    if (cmd === 'launcher_running_details') return [{ pid: 77, title: 'Аа — Воин', elevated: false }];
    if (cmd === 'launcher_self_elevated') return false;
    return {};
  });
  vi.resetModules();
  ({ state, mergeSettings } = await import('../js/core/state.js'));
  state.settings.launcher = {
    ...(state.settings.launcher || {}),
    gameCenters: [GC1],
    preferredGcId: '',
    decorateWindows: false,
    skipRunning: true,
    askBeforeLaunch: true,
    preflight: 'issues',
    delaySec: 0
  };
  state.parties = [{ id: 'p1', name: 'Основа', order: 1 }];
  state.characters = [ch('a', 'Аа', 2), ch('b', 'Бб', 3), ch('c', 'Вв', 1)];
  partyLaunch = await import('../js/modules/launcher/partyLaunch.js');
  ({ renderPartiesGrid } = await import('../js/modules/parties/renderer.js'));
});

describe('настройка launcher.askBeforeLaunch', () => {
  it('включена по умолчанию и сохраняет false при выключении', () => {
    expect(mergeSettings({}).launcher.askBeforeLaunch).toBe(true);
    expect(mergeSettings({ launcher: { askBeforeLaunch: false } }).launcher.askBeforeLaunch).toBe(false);
  });
});

describe('выбор состава перед запуском пати (интеграция)', () => {
  it('вкладка «Пати» → открывает выбор в порядке пати, запускает только отмеченных', async () => {
    renderPartiesGrid();
    document.querySelector('.launch-party-action-btn[data-party-name="Основа"]').click();
    await vi.waitFor(() => expect(pickerDialog()).not.toBeNull());

    // Порядок строк: Вв (1), Аа (2, с бейджем), Бб (3)
    const rows = [...document.querySelectorAll('.plp-row')];
    expect(rows.map(r => r.dataset.memberId)).toEqual(['c', 'a', 'b']);
    expect(rows[1].querySelector('.plp-badge').textContent).toBe('окно уже запущено');

    // Снимаем Бб и запускаем (Аа пропустится из-за skipRunning, Вв запустится)
    const boxB = document.querySelector('.plp-check[value="b"]');
    boxB.checked = false;
    boxB.dispatchEvent(new Event('change', { bubbles: true }));
    // Выключим skipRunning, чтобы проверить именно порядок запуска отмеченных c -> a
    state.settings.launcher.skipRunning = false;
    document.querySelector('[data-act="launch"]').click();

    await vi.waitFor(() => expect(started()).toEqual(['c', 'a']));
    expect(partyLaunch.isLaunching()).toBe(false);
  });

  it('отмена в окне выбора ничего не запускает и не оставляет блокировку', async () => {
    const p = partyLaunch.launchPartyByName('Основа');
    await vi.waitFor(() => expect(pickerDialog()).not.toBeNull());
    document.querySelector('[data-act="cancel"]').click();
    expect(await p).toBeNull();
    expect(started()).toEqual([]);
    expect(partyLaunch.isLaunching()).toBe(false);
  });

  it('пропускает выбор если в пати 1 персонаж, при interactive: false или askBeforeLaunch: false', async () => {
    state.settings.launcher.skipRunning = false;
    await partyLaunch.launchPartyByName('Основа', { interactive: false });
    expect(pickerDialog()).toBeNull();
    expect(started()).toEqual(['c', 'a', 'b']);

    invoke.mockClear();
    state.settings.launcher.askBeforeLaunch = false;
    await partyLaunch.launchPartyByName('Основа');
    expect(pickerDialog()).toBeNull();
    expect(started()).toEqual(['c', 'a', 'b']);

    invoke.mockClear();
    state.settings.launcher.askBeforeLaunch = true;
    state.characters = [ch('a', 'Аа', 1)];
    await partyLaunch.launchPartyByName('Основа');
    expect(pickerDialog()).toBeNull();
    expect(started()).toEqual(['a']);
  });
});
