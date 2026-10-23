// Запущенные окна игры в интерфейсе: общий кэш (js/modules/launcher/runningWindows.js),
// кнопка закрытия окна в карточке персонажа и список окон в разделе «Инструменты».
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const invoke = vi.fn(async () => []);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../js/core/storage.js', () => ({
  persist: vi.fn(async () => {}),
  saveNow: vi.fn(async () => {}),
  isTauri: () => true
}));
vi.mock('../js/core/ui.js', () => ({
  toast: vi.fn(),
  confirmModal: vi.fn(async () => true),
  showModal: vi.fn(),
  closeModal: vi.fn()
}));

let state, runningWindows, list, todayView;

const win = (pid, nick, cls = 'Воин') => ({
  pid,
  image: 'elementclient_64.exe',
  title: `${nick} — ${cls}`,
  elevated: false
});
const char = (id, nick) => ({ id, nick, class: 'Воин', dungeonPasses: {}, ancientCoins: 0 });

// Разметка вкладки «Персонажи» целиком: карточка рисуется вместе с панелью KPI и фильтрами.
const body = `
  <section class="page active" data-section="today"><div id="today-root"></div></section>
  <section class="page" data-section="tools"><div id="tools-root"></div></section>
  <section class="page" data-section="characters">
    <input id="search-input" class="input" />
    <select id="class-filter"><option value="">Все классы</option></select>
    <select id="party-filter"><option value="">Все пати</option></select>
    <select id="auth-filter"><option value="">Все статусы</option></select>
    <select id="tag-filter"><option value="">Все теги</option></select>
    <button id="filters-clear" hidden></button>
    <button id="show-active-characters"></button><button id="show-archived-characters"></button>
    <span id="active-character-count"></span><span id="archived-character-count"></span>
    <div id="bulk-bar" hidden></div><div id="character-grid"></div>
    <b id="kpi-total-chars"></b><b id="kpi-active-parties"></b><b id="kpi-no-party"></b>
    <b id="kpi-coins"></b><b id="kpi-online-count"></b><b id="kpi-offline-count"></b>
  </section>
  <div id="modal-root"></div><div id="toast-root"></div>`;

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = body;
  invoke.mockReset();
  invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [] : {}));
  ({ state } = await import('../js/core/state.js'));
  state.parties = [];
  state.marathons = [];
  state.characters = [char('a', 'Аа'), char('b', 'Бб')];
  runningWindows = await import('../js/modules/launcher/runningWindows.js');
  list = await import('../js/modules/characters/list.js');
  todayView = await import('../js/modules/dashboard/todayView.js');
});

afterEach(() => {
  invoke.mockClear();
});

describe('кэш запущенных окон', () => {
  it('окно сопоставляется с персонажем по нику из заголовка', async () => {
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    expect(runningWindows.windowOfCharacter('a')?.pid).toBe(100);
    expect(runningWindows.windowOfCharacter('b')).toBeNull();
    expect(runningWindows.windowOfCharacter(null)).toBeNull();
  });

  it('параллельные обновления не делают два запроса к Rust', async () => {
    const both = await Promise.all([runningWindows.refreshRunningWindows(), runningWindows.refreshRunningWindows()]);
    expect(both[0]).toBe(both[1]);
    expect(invoke.mock.calls.filter(c => c[0] === 'launcher_running_details')).toHaveLength(1);
  });

  it('сбой чтения не оставляет приложение без списка и не сыпет ошибками', async () => {
    await runningWindows.refreshRunningWindows();
    invoke.mockImplementation(async () => {
      throw new Error('нет доступа');
    });
    await expect(runningWindows.refreshRunningWindows()).resolves.toBeDefined();
    // Прежний список сохранён: карточки не «мигают» кнопками
    expect(runningWindows.windowOfCharacter('a')).toBeNull();
  });

  it('подписчика можно отписать', async () => {
    const fn = vi.fn();
    const off = runningWindows.onRunningWindows(fn);
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    await runningWindows.refreshRunningWindows();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('кнопка закрытия окна в карточке персонажа', () => {
  it('появляется только у того персонажа, чьё окно запущено', async () => {
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    list.renderCharacters();
    const cards = [...document.querySelectorAll('.character-card')];
    const first = cards.find(c => c.dataset.charId === 'a');
    const second = cards.find(c => c.dataset.charId === 'b');
    expect(first.querySelector('.close-game-window-action')).not.toBeNull();
    expect(second.querySelector('.close-game-window-action')).toBeNull();
  });

  it('без запущенных окон кнопок на карточках нет', async () => {
    await runningWindows.refreshRunningWindows();
    list.renderCharacters();
    expect(document.querySelectorAll('.close-game-window-action')).toHaveLength(0);
  });

  it('подсказка кнопки называёт персонажа и время работы окна', async () => {
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    list.renderCharacters();
    const btn = document.querySelector('.close-game-window-action');
    expect(btn.title).toContain('Аа');
    expect(btn.getAttribute('aria-label')).toBe('Закрыть окно игры');
  });

  it('клик закрывает окно этого персонажа и не открывает профиль', async () => {
    invoke.mockImplementation(async cmd => {
      if (cmd === 'launcher_running_details') return [win(100, 'Аа')];
      if (cmd === 'launcher_close_clients_pids') return { found: 1, closed: 1, failed: 0 };
      return {};
    });
    await runningWindows.refreshRunningWindows();
    list.renderCharacters();
    document.querySelector('.close-game-window-action').click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('launcher_close_clients_pids', { pids: [100] }));
    expect(document.querySelector('.modal-container')).toBeNull();
  });

  it('отказ от подтверждения ничего не закрывает', async () => {
    const ui = await import('../js/core/ui.js');
    ui.confirmModal.mockResolvedValueOnce(false);
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    list.renderCharacters();
    document.querySelector('.close-game-window-action').click();
    await new Promise(r => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalledWith('launcher_close_clients_pids', expect.anything());
  });

  it('окно уже закрыли вручную — сообщаем об этом, а не об ошибке', async () => {
    const ui = await import('../js/core/ui.js');
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    list.renderCharacters();
    // К моменту нажатия окна уже нет
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [] : {}));
    document.querySelector('.close-game-window-action').click();
    await vi.waitFor(() => expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('уже закрыто'), 'info'));
    expect(invoke).not.toHaveBeenCalledWith('launcher_close_clients_pids', expect.anything());
  });
});

describe('список окон игры в разделе «Инструменты»', () => {
  // Блок «Окна игры» с вкладки «Сегодня» ушёл: управление окнами живёт в «Инструментах».
  // Проверяем то же поведение в новом месте — кэш окон общий, разметка своя.
  const renderToolsSection = async () => {
    const tools = await import('../js/modules/tools/index.js');
    tools.bindTools();
    tools.renderTools();
  };

  it('на «Сегодня» блока окон больше нет', async () => {
    await runningWindows.refreshRunningWindows();
    todayView.renderToday(document.getElementById('today-root'), {});
    expect(document.querySelector('[data-running-windows]')).toBeNull();
    expect(document.querySelector('.rwn-block')).toBeNull();
  });

  it('без запущенных окон говорит об этом', async () => {
    await runningWindows.refreshRunningWindows();
    await renderToolsSection();
    const box = document.querySelector('[data-tools-windows]');
    expect(box).not.toBeNull();
    expect(box.textContent).toContain('Запущенных окон игры нет');
  });

  it('список окон и кнопка закрытия появляются после опроса', async () => {
    // Окно, запущенное не из Твинофермы: заголовок игровой, ника нет — показываем как PID
    const foreign = { pid: 200, image: 'elementclient_64.exe', title: 'Perfect World', elevated: false };
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа'), foreign] : {}));
    await runningWindows.refreshRunningWindows();
    await renderToolsSection();
    const rows = [...document.querySelectorAll('.rwn-row')];
    expect(rows).toHaveLength(2);
    // Сначала узнанные окна, затем безымянные
    expect(rows[0].textContent).toContain('Аа — Воин');
    expect(rows[1].textContent).toContain('PID 200');
  });

  it('кнопка закрытия окна передаёт его PID', async () => {
    const ui = await import('../js/core/ui.js');
    invoke.mockImplementation(async cmd => {
      if (cmd === 'launcher_running_details') return [win(100, 'Аа')];
      if (cmd === 'launcher_close_clients_pids') return { found: 1, closed: 1 };
      return {};
    });
    await runningWindows.refreshRunningWindows();
    await renderToolsSection();
    await vi.waitFor(() => expect(document.querySelector('[data-tools-act="close-one-window"]')).not.toBeNull());
    document.querySelector('[data-tools-act="close-one-window"]').click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('launcher_close_clients_pids', { pids: [100] }));
    expect(ui.confirmModal).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  });

  it('после ухода с вкладки подписка снимается: список не рисуется в фоне', async () => {
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    await renderToolsSection();
    await vi.waitFor(() => expect(document.querySelectorAll('.rwn-row')).toHaveLength(1));
    const page = document.querySelector('.page[data-section="tools"]');
    page.dispatchEvent(new CustomEvent('tf-leave'));
    const before = document.querySelectorAll('.rwn-row').length;
    invoke.mockImplementation(async cmd =>
      cmd === 'launcher_running_details' ? [win(100, 'Аа'), win(200, 'Бб')] : {}
    );
    await runningWindows.refreshRunningWindows();
    expect(document.querySelectorAll('.rwn-row')).toHaveLength(before);
  });
});

describe('кнопка «Обновить» в блоке «Окна игры»', () => {
  const renderToolsSection = async () => {
    const tools = await import('../js/modules/tools/index.js');
    tools.bindTools();
    tools.renderTools();
  };
  const refreshBtn = () => document.querySelector('[data-tools-act="refresh-windows"]');
  const rowCount = () => document.querySelectorAll('.rwn-row').length;

  it('подхватывает окно, открытое уже после отрисовки раздела', async () => {
    await runningWindows.refreshRunningWindows();
    await renderToolsSection();
    expect(rowCount()).toBe(0);
    // Окно открыли, не заходя в «Инструменты» заново
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    refreshBtn().click();
    await vi.waitFor(() => expect(rowCount()).toBe(1));
    expect(document.querySelector('.rwn-row').textContent).toContain('Аа — Воин');
  });

  it('убирает из списка окно, закрытое снаружи приложения', async () => {
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    await renderToolsSection();
    expect(rowCount()).toBe(1);
    // Игру закрыли руками, мимо приложения
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [] : {}));
    refreshBtn().click();
    await vi.waitFor(() => expect(rowCount()).toBe(0));
    expect(document.querySelector('[data-tools-windows]').textContent).toContain('Запущенных окон игры нет');
  });

  it('на время опроса кнопка выключена и говорит, что идёт проверка', async () => {
    await runningWindows.refreshRunningWindows();
    await renderToolsSection();
    // Отложенный ответ: опрос нельзя завершить изнутри, пока не убедились, что кнопка ждёт
    let release = () => {};
    const pending = new Promise(res => {
      release = () => res([win(100, 'Аа')]);
    });
    invoke.mockImplementation(cmd => (cmd === 'launcher_running_details' ? pending : Promise.resolve({})));
    const btn = refreshBtn();
    btn.click();
    await vi.waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.textContent).toContain('Проверяем');
    release();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(btn.textContent).toContain('Обновить');
    expect(rowCount()).toBe(1);
  });

  it('сбой опроса показывается сообщением, а не молчаливым старым списком', async () => {
    const ui = await import('../js/core/ui.js');
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    await renderToolsSection();
    ui.toast.mockClear();
    invoke.mockImplementation(async () => {
      throw new Error('нет доступа');
    });
    refreshBtn().click();
    await vi.waitFor(() => expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('Не удалось'), 'error'));
    // Прежний список на месте: сбой не должен читаться как «окна закрылись»
    expect(rowCount()).toBe(1);
  });

  it('обновление ничего не закрывает: это чтение, а не действие', async () => {
    invoke.mockImplementation(async cmd => (cmd === 'launcher_running_details' ? [win(100, 'Аа')] : {}));
    await runningWindows.refreshRunningWindows();
    await renderToolsSection();
    refreshBtn().click();
    await vi.waitFor(() => expect(rowCount()).toBe(1));
    expect(invoke).not.toHaveBeenCalledWith('launcher_close_clients_pids', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('launcher_close_clients_all', expect.anything());
  });
});
