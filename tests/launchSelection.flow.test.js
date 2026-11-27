// tests/launchSelection.flow.test.js
// Как запуск пати соотносится с окном «кого запускать».
//
// Правило, ради которого написан этот файл: нажатие «▶ Запустить» под пати значит
// «запусти всю пати в том порядке, который задан в карточке». Никакое окно на этом
// пути показываться не может — ни настройкой, ни чем-либо ещё. Окно выбора —
// отдельное действие (`launchPartyPicked`), и вызывается оно из «▾» у кнопки
// запуска, из «Сегодня», из палитры команд, из оверлея и из внешнего API.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

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

let state, partyLaunch, renderPartiesGrid, mergeSettings, DEFAULT_SETTINGS;
const started = () =>
  invoke.mock.calls.filter(c => c[0] === 'launcher_start').map(c => String(c[1].charId).split('@')[0]);
const pickerDialog = () => document.querySelector('.tf-dialog');
const launchButton = () => document.querySelector('.launch-party-action-btn[data-party-name="Основа"]');

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
  ({ DEFAULT_SETTINGS } = await import('../js/core/constants.js'));
  state.settings.launcher = {
    ...(state.settings.launcher || {}),
    gameCenters: [GC1],
    preferredGcId: '',
    decorateWindows: false,
    skipRunning: true,
    preflight: 'off',
    delaySec: 0
  };
  state.parties = [{ id: 'p1', name: 'Основа', order: 1 }];
  state.characters = [ch('a', 'Аа', 2), ch('b', 'Бб', 3), ch('c', 'Вв', 1)];
  partyLaunch = await import('../js/modules/launcher/partyLaunch.js');
  ({ renderPartiesGrid } = await import('../js/modules/parties/renderer.js'));
});

describe('обычный запуск пати не спрашивает состав', () => {
  it('настройки «спрашивать, кого запускать» больше нет — ни в коде, ни на странице настроек', () => {
    // Раньше был флаг по умолчанию `false`, и это ничего не чинило: значение,
    // сохранённое в state.json, переживало смену умолчания, и у людей, которые
    // когда-то включили спрос, модалка оставалась на каждом запуске. Поэтому флага
    // нет вовсе, а слежавшееся значение вычёркивается при чтении настроек.
    expect(DEFAULT_SETTINGS.launcher).not.toHaveProperty('askBeforeLaunch');
    expect(mergeSettings({}).launcher).not.toHaveProperty('askBeforeLaunch');
    expect(mergeSettings({ launcher: { askBeforeLaunch: true } }).launcher).not.toHaveProperty('askBeforeLaunch');
    expect(readFileSync('index.html', 'utf8')).not.toContain('launcher.askBeforeLaunch');
  });

  it('«▶ Запустить» под пати сразу поднимает всю пати по её порядку — даже со старым флагом', async () => {
    state.settings.launcher.askBeforeLaunch = true; // как в state.json у тех, кто включил спрос давно
    renderPartiesGrid();
    launchButton().click();
    // Порядок — из карточки пати: Вв (1), Аа (2), Бб (3). «Аа» уже с открытым окном
    // и skipRunning → пропуск, остальные стартуют.
    await vi.waitFor(() => expect(started()).toEqual(['c', 'b']));
    expect(pickerDialog()).toBeNull();
  });

  it('окно выбора даёт «▾»: там, где человек сам его попросил', async () => {
    renderPartiesGrid();
    document.querySelector('.pt-btn-caret[data-party-name="Основа"]').click();
    await vi.waitFor(() => expect(document.querySelector('.dropdown-menu[data-open]')).not.toBeNull());
    const items = [...document.querySelectorAll('.dropdown-menu[data-open] button')];
    const pick = items.find(b => b.textContent.includes('Выбрать, кого запускать'));
    expect(pick).toBeTruthy();
    pick.click();
    await vi.waitFor(() => expect(pickerDialog()).not.toBeNull());
    expect([...document.querySelectorAll('.plp-row')].map(r => r.dataset.memberId)).toEqual(['c', 'a', 'b']);
  });
});

describe('выбор состава перед запуском пати (интеграция)', () => {
  it('окно показывает порядок пати, бейдж запущенного окна и запускает только отмеченных', async () => {
    const running = partyLaunch.launchPartyPicked('Основа');
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
    expect(await running).toBeTruthy();
  });

  it('отмена в окне выбора ничего не запускает и не оставляет блокировку', async () => {
    const pending = partyLaunch.launchPartyPicked('Основа');
    await vi.waitFor(() => expect(pickerDialog()).not.toBeNull());
    document.querySelector('[data-act="cancel"]').click();
    expect(await pending).toBeNull();
    expect(started()).toEqual([]);
    expect(partyLaunch.isLaunching()).toBe(false);
  });

  it('launchPartyByName не показывает окно ни при каких флагах, launchPartyPicked — всегда', async () => {
    state.settings.launcher.skipRunning = false;
    // Запуск «без вопросов»: из трея, из макроса, из внешней программы.
    await partyLaunch.launchPartyByName('Основа', { interactive: false });
    expect(pickerDialog()).toBeNull();
    expect(started()).toEqual(['c', 'a', 'b']);

    invoke.mockClear();
    // И обычное нажатие по той же функции: флаг больше ничего не решает.
    state.settings.launcher.askBeforeLaunch = true;
    await partyLaunch.launchPartyByName('Основа');
    expect(pickerDialog()).toBeNull();
    expect(started()).toEqual(['c', 'a', 'b']);

    invoke.mockClear();
    // Явный выбор — не «окно для больших пати»: в пати из одного участника список
    // тоже открывается, иначе «выбор есть всегда» значило бы не это.
    state.characters = [ch('a', 'Аа', 1)];
    const picked = partyLaunch.launchPartyPicked('Основа');
    await vi.waitFor(() => expect(pickerDialog()).not.toBeNull());
    expect([...document.querySelectorAll('.plp-row')].map(r => r.dataset.memberId)).toEqual(['a']);
    document.querySelector('[data-act="launch"]').click();
    await vi.waitFor(() => expect(started()).toEqual(['a']));
    expect(await picked).toBeTruthy();
  });
});
