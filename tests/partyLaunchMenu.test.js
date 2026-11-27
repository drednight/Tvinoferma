// tests/partyLaunchMenu.test.js
// Стрелка у кнопки «▶ Запустить» в карточке пати: всех, выборочно, за отставшими.
//
// Зачем это нужно. Окно выбора состава было привязано к настройке «спрашивать перед
// запуском», и это работало в обратную сторону: у того, кто настройку один раз включил,
// окно всплывало на каждом запуске — а выключенное значение по умолчанию ничего не
// меняло, потому что выбор уже лежал в state.json. Поэтому спрос с обычной кнопки снят
// совсем, а стрелка — единственный вход ко всем остальным сценариям: выборочно, за
// отставшими, с экраном проверок.
//
// Отсюда главная проверка файла: «▶ Запустить» не открывает НИ ОДНОГО окна — ни при
// каких значениях настроек, — а «▾» открывает ровно то, что в нём выбрали.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../js/core/constants.js';

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

let state, partyLaunch, renderPartiesGrid, log;
const started = () =>
  invoke.mock.calls.filter(c => c[0] === 'launcher_start').map(c => String(c[1].charId).split('@')[0]);
const picker = () => document.querySelector('.plp-list');
const menu = () => document.querySelector('.dropdown-menu[data-open]');

beforeEach(async () => {
  window.localStorage.clear();
  document.body.innerHTML = '<div id="party-summary"></div><div id="party-list"></div><div id="modal-root"></div>';
  invoke.mockReset();
  invoke.mockImplementation(async cmd => {
    if (cmd === 'launcher_running_details') return [];
    if (cmd === 'launcher_self_elevated') return false;
    return {};
  });
  vi.resetModules();
  ({ state } = await import('../js/core/state.js'));
  log = await import('../js/modules/launcher/launchLog.js');
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
  state.characters = [ch('a', 'Аа', 1), ch('b', 'Бб', 2), ch('c', 'Вв', 3)];
  partyLaunch = await import('../js/modules/launcher/partyLaunch.js');
  ({ renderPartiesGrid } = await import('../js/modules/parties/renderer.js'));
});

// Меню открывается асинхронно: карточка тянет partyLaunch.js динамическим импортом,
// поэтому «нажал и сразу увидел» в тесте нет — ждём, как и в интерфейсе.
async function openMenu() {
  document.querySelector('.pt-btn-caret').click();
  await vi.waitFor(() => expect(menu()).not.toBeNull());
  return menu();
}
async function pick(id) {
  await openMenu();
  menu().querySelector(`[data-id="${id}"]`).click();
}

describe('стрелка вариантов запуска в карточке пати', () => {
  it('есть всегда: и у большой пати, и у пати из одного участника', () => {
    renderPartiesGrid();
    expect(document.querySelector('.pt-btn-caret')).toBeTruthy();
    expect(document.querySelector('.pt-btn-caret').getAttribute('aria-haspopup')).toBe('menu');

    state.characters = [ch('a', 'Аа', 1)];
    renderPartiesGrid();
    // Выбор «есть всегда» значит и это: в пати из одного персонажа стрелка на месте,
    // просто в окне одна строка. Прячем её только когда выбирать не из чего вовсе.
    expect(document.querySelector('.pt-btn-caret')).toBeTruthy();

    state.archivedCharacters = [{ id: 'a', nick: 'Аа' }];
    renderPartiesGrid();
    expect(document.querySelector('.pt-btn-caret')).toBeNull();
  });

  it('меню живёт во всплывающем слое, а не внутри карточки', async () => {
    renderPartiesGrid();
    const card = document.querySelector('.pt-card');
    const opened = await openMenu();
    // У `.pt-card` overflow:hidden (скруглённые углы, раскрытие состава): меню
    // внутри неё обрезалось по границе карточки и накрывало список участников —
    // со стороны это выглядело как сломанная структура пати.
    expect(opened.closest('.pt-card')).toBeNull();
    expect(opened.parentElement).toBe(document.body);
    expect(card.querySelector('.dropdown-menu')).toBeNull();
  });

  it('стрелка — половина кнопки запуска, а не отдельная кнопка в ряду', () => {
    renderPartiesGrid();
    const split = document.querySelector('.pt-split');
    expect(split).toBeTruthy();
    expect([...split.children].map(el => el.className)).toEqual([
      expect.stringContaining('pt-btn-launch'),
      expect.stringContaining('pt-btn-caret')
    ]);
    expect(document.querySelector('.pt-btn-caret svg')).toBeTruthy();
  });

  it('«выбрать, кого запускать» показывает окно — это отдельное действие, а не настройка', async () => {
    // Спроса как настройки больше нет: окно открывается только оттуда, где его просят.
    expect(DEFAULT_SETTINGS.launcher).not.toHaveProperty('askBeforeLaunch');
    renderPartiesGrid();
    await pick('pick');
    await vi.waitFor(() => expect(picker()).not.toBeNull());

    const box = document.querySelector('.plp-check[value="c"]');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-act="launch"]').click();

    // Отмечены Аа и Бб — только они и стартуют, «Вв» не запускается «по привычке».
    await vi.waitFor(() => expect(started()).toEqual(['a', 'b']));
  });

  it('отмена в окне выбора не запускает ничего', async () => {
    renderPartiesGrid();
    await pick('pick');
    await vi.waitFor(() => expect(picker()).not.toBeNull());
    document.querySelector('[data-act="cancel"]').click();
    await vi.waitFor(() => expect(picker()).toBeNull());
    expect(started()).toEqual([]);
    expect(partyLaunch.isLaunching()).toBe(false);
  });

  it('«запустить всех» поднимает состав целиком и не задаёт вопросов', async () => {
    renderPartiesGrid();
    await pick('all');
    await vi.waitFor(() => expect(started()).toEqual(['a', 'b', 'c']));
    expect(picker()).toBeNull();
  });

  it('обычная кнопка не слушает ничего: окна выбора нет, стартует вся пати', async () => {
    // Значение, оставшееся в state.json от прежнего флага, не имеет права возвращать модалку.
    state.settings.launcher.askBeforeLaunch = true;
    renderPartiesGrid();
    document.querySelector('.launch-party-action-btn').click();
    await vi.waitFor(() => expect(started().length).toBe(3));
    expect(picker()).toBeNull();
  });

  it('«▶ Запустить» не открывает ни одного окна — даже когда у кого-то нет входа', async () => {
    // Именно за это кнопку и просят: персонаж без запомненного входа не должен
    // ставить между кликом и запуском экран с галочками состава. Он пропускается,
    // остальные стартуют, а причина остаётся в журнале задачи.
    state.characters.push({
      id: 'd',
      nick: 'Дд',
      class: 'Воин',
      partyIds: ['p1'],
      mainPartyId: 'p1',
      launch: { gcIds: ['gc-1'] } // вход не запомнен
    });
    renderPartiesGrid();
    document.querySelector('.launch-party-action-btn').click();
    await vi.waitFor(() => expect(started()).toEqual(['a', 'b', 'c']));
    expect(picker()).toBeNull();
    expect(document.querySelector('.tf-dialog')).toBeNull();
  });

  it('в меню есть «проверить перед запуском»: экран открывается по запросу и запускает всех', async () => {
    // Отказ от окна по умолчанию не отменяет сами проверки: они остаются, а экран
    // с ними — отдельный пункт, который человек вызывает сам, когда хочет.
    renderPartiesGrid();
    const opened = await openMenu();
    expect(opened.querySelector('[data-id="preflight"]')).toBeTruthy();
    opened.querySelector('[data-id="preflight"]').click();
    await vi.waitFor(() => expect(document.querySelector('.tf-dialog')).not.toBeNull());
    document.querySelector('[data-act="launch"]').click();
    await vi.waitFor(() => expect(started()).toEqual(['a', 'b', 'c']));
    expect(state.settings.launcher.preflight).toBe('off'); // настройку пункт не меняет
  });
});

describe('повтор за отставшими', () => {
  it('пункт выключен, если в прошлый раз все окна поднялись', async () => {
    log.recordLaunchRun({
      id: 'run-ok',
      at: new Date().toISOString(),
      title: 'Запуск игры: Основа',
      ms: 1000,
      items: [
        { id: 'a', nick: 'Аа', status: 'ok' },
        { id: 'b', nick: 'Бб', status: 'ok' }
      ]
    });
    expect(partyLaunch.partyLaunchMisses('Основа')).toEqual([]);
    renderPartiesGrid();
    await openMenu();
    const button = menu().querySelector('[data-id="misses"]');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('повторять не за чем');
  });

  it('запускает ровно тех, кто не поднялся, и называет их число', async () => {
    log.recordLaunchRun({
      id: 'run-bad',
      at: new Date().toISOString(),
      title: 'Запуск игры: Основа',
      ms: 1000,
      items: [
        { id: 'a', nick: 'Аа', status: 'ok' },
        { id: 'b', nick: 'Бб', status: 'failed', error: 'клиент не появился' },
        { id: 'c', nick: 'Вв', status: 'failed', error: 'клиент не появился' }
      ]
    });
    expect(partyLaunch.partyLaunchMisses('Основа')).toEqual(['b', 'c']);

    renderPartiesGrid();
    expect(document.querySelector('.pt-btn-caret').getAttribute('title')).toContain('отставших');
    await openMenu();
    expect(menu().querySelector('[data-id="misses"]').textContent).toContain('Повторить за отставших (2)');
    menu().querySelector('[data-id="misses"]').click();

    await vi.waitFor(() => expect(started()).toEqual(['b', 'c']));
    // Окно выбора не всплывает: состав уже определён итогом прошлого запуска.
    expect(picker()).toBeNull();
  });

  it('у неизвестной пати — пустой список, а не падение', () => {
    expect(partyLaunch.partyLaunchMisses('Нет такой')).toEqual([]);
  });
});
