// Ручная смена вида запущенного окна игры (кнопка «Вид…» в списке окон):
// название окна и значок класса задаёт сам пользователь.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  details: vi.fn(),
  applyStyle: vi.fn(),
  toast: vi.fn()
}));

vi.mock('../js/modules/launcher/launch.js', () => ({
  runningClientDetails: mocks.details,
  closeClientsByPid: vi.fn(),
  closeAllClients: vi.fn(),
  applyWindowStyle: mocks.applyStyle,
  WINDOW_ICON_SMALL: 16,
  WINDOW_ICON_BIG: 48,
  applyStyleText: (r) => ({ missing: 'Окно игры не найдено: возможно, оно уже закрыто', failed: 'нет доступа', fixed: 'Окно обновлено', ok: 'Изменений не потребовалось' }[r?.status] || '')
}));
vi.mock('../js/core/storage.js', () => ({ isTauri: () => true, persist: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', () => ({ toast: mocks.toast, confirmModal: vi.fn(async () => true) }));
vi.mock('../js/modules/launcher/partyLaunch.js', () => ({ showCloseReport: vi.fn() }));

let state, openWindowPicker;

const clients = () => [
  { pid: 100, image: 'elementclient_64.exe', startedAt: Date.now() - 60000, title: 'Аа — Воин', elevated: false },
  { pid: 300, image: 'elementclient_64.exe', startedAt: null, title: 'Perfect World', elevated: false }
];

const styleBtn = (pid) => document.querySelector(`[data-style="${pid}"]`);
const dialog = () => [...document.querySelectorAll('.tf-dialog')].at(-1);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="modal-root"></div>';
  mocks.details.mockResolvedValue(clients());
  mocks.applyStyle.mockResolvedValue({ pid: 100, status: 'fixed', title: 'Новое' });
  ({ state } = await import('../js/core/state.js'));
  state.parties = [];
  state.characters = [{ id: 'a', nick: 'Аа', class: 'Воин', partyIds: [], mainPartyId: null }];
  ({ openWindowPicker } = await import('../js/modules/launcher/windowPicker.js'));
  await openWindowPicker();
});

describe('кнопка «Вид…» в списке окон', () => {
  it('есть у каждого окна, включая запущенное не из Твинофермы', () => {
    expect(styleBtn(100)).not.toBeNull();
    expect(styleBtn(300)).not.toBeNull();
  });

  it('открывает диалог с подставленным названием и выбором класса', () => {
    styleBtn(100).click();
    const d = dialog();
    expect(d).toBeTruthy();
    expect(d.querySelector('#ws-title').value).toBe('Аа — Воин');
    expect(d.querySelector('#ws-class')).toBeTruthy();
    // Класс персонажа выбран заранее
    expect(d.querySelector('#ws-class').value).toBe('Воин');
    // В списке есть все классы игры
    expect([...d.querySelector('#ws-class').options].length).toBeGreaterThan(15);
  });

  it('для окна без ника предлагает PID', () => {
    styleBtn(300).click();
    expect(dialog().querySelector('#ws-title').value).toBe('PID 300');
    expect(dialog().querySelector('#ws-class').value).toBe('');
  });

  it('применяет выбранные название и класс', async () => {
    styleBtn(100).click();
    const d = dialog();
    d.querySelector('#ws-title').value = 'Моё окно';
    d.querySelector('#ws-class').value = 'Маг';
    d.querySelector('[data-x="apply"]').click();
    await vi.waitFor(() => expect(mocks.applyStyle).toHaveBeenCalled());
    expect(mocks.applyStyle.mock.calls[0][0]).toMatchObject({ pid: 100, title: 'Моё окно', class: 'Маг', clearIcon: false });
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  });

  it('пустое название означает «не менять название»', async () => {
    styleBtn(100).click();
    dialog().querySelector('#ws-title').value = '   ';
    dialog().querySelector('#ws-class').value = 'Маг';
    dialog().querySelector('[data-x="apply"]').click();
    await vi.waitFor(() => expect(mocks.applyStyle).toHaveBeenCalled());
    expect(mocks.applyStyle.mock.calls[0][0].title).toBeNull();
  });

  it('«вернуть значок игры» отменяет выбранный класс', async () => {
    styleBtn(100).click();
    const d = dialog();
    d.querySelector('#ws-class').value = 'Маг';
    d.querySelector('#ws-clear').checked = true;
    d.querySelector('[data-x="apply"]').click();
    await vi.waitFor(() => expect(mocks.applyStyle).toHaveBeenCalled());
    // Противоречие решается в пользу явного «убрать значок»
    expect(mocks.applyStyle.mock.calls[0][0]).toMatchObject({ class: null, clearIcon: true });
  });

  it('ошибка показывается в диалоге и не закрывает его', async () => {
    mocks.applyStyle.mockResolvedValue({ pid: 100, status: 'failed', title: '' });
    styleBtn(100).click();
    dialog().querySelector('[data-x="apply"]').click();
    await vi.waitFor(() => expect(dialog().textContent).toContain('нет доступа'));
    expect(dialog()).toBeTruthy();
  });

  it('отмена закрывает диалог и ничего не применяет', () => {
    styleBtn(100).click();
    dialog().querySelector('[data-x="cancel"]').click();
    expect(mocks.applyStyle).not.toHaveBeenCalled();
  });

  it('после успеха список перечитывается, чтобы видны были новые названия', async () => {
    mocks.details.mockClear();
    styleBtn(100).click();
    dialog().querySelector('[data-x="apply"]').click();
    await vi.waitFor(() => expect(mocks.details).toHaveBeenCalled());
  });
});

describe('связка с Rust', () => {
  const rust = readFileSync('src-tauri/src/launcher.rs', 'utf8');
  const js = readFileSync('js/modules/launcher/launch.js', 'utf8');

  it('команда зарегистрирована и принимает pid, название, класс и сброс значка', () => {
    expect(readFileSync('src-tauri/src/lib.rs', 'utf8')).toContain('launcher::launcher_apply_window_style');
    expect(rust).toContain('pub async fn launcher_apply_window_style');
    expect(rust).toMatch(/pid: u32,[\s\S]{0,200}title: Option<String>/);
    expect(rust).toContain('clear_icon: Option<bool>');
  });

  it('интерфейс передаёт те же поля в camelCase (плюс пиксели значка от canvas)', () => {
    // Вызов идёт через обёртку tauriInvoke, поэтому проверяем имя команды и поля
    expect(js).toContain('launcher_apply_window_style');
    expect(js).toContain('clearIcon: opts.clearIcon ?? false');
    expect(js).toMatch(/title: opts\.title \?\? null/);
    expect(js).toMatch(/class: cls/);
    // Пиксели значка готовит интерфейс (classIconRgba): у Rust не всегда есть PNG рядом с exe
    expect(js).toMatch(/iconSmall,/);
    expect(js).toMatch(/iconBig/);
  });

  it('значки классов есть и в Rust, и в интерфейсе — списки должны совпадать', () => {
    const jsClasses = readFileSync('js/core/constants.js', 'utf8');
    // Каждый класс из интерфейса должен встречаться в списке Rust, иначе значок не поставится
    for (const cls of ['Оборотень', 'Друид', 'Воин', 'Маг', 'Бард', 'Канглонг']) {
      expect(jsClasses, cls).toContain(`'${cls}'`);
      expect(rust, cls).toContain(`("${cls}"`);
    }
  });

  it('пиксели от canvas не отдаются декодеру файлов (иначе значок не ставился)', () => {
    // Пиксели интерфейса — сырой RGBA. `image::load_from_memory` — декодер PNG/JPEG: он на них
    // возвращал ошибку, значок молча не ставился, а название менялось. Это и было «иконка
    // не обновляется в панели задач». Единственный законный вызов — для файла PNG класса.
    const calls = [...rust.matchAll(/load_from_memory\(&?([A-Za-z_][\w]*)/g)].map(m => m[1]);
    expect(calls).toContain('class_icon_bytes');
    expect(calls).not.toContain('icon_small');
    expect(calls).not.toContain('icon_big');
    expect(calls).not.toContain('small_rgba');
    expect(calls).not.toContain('a');
    expect(calls).not.toContain('b');
    // Значок из пикселей собирается отдельной функцией, которая умеет сырой RGBA
    expect(rust).toContain('fn style_icons(');
    expect(rust).toMatch(/style_icons\(icon_small\.as_deref\(\), icon_big\.as_deref\(\), cls\)/);
  });

  it('если значок собрать не удалось, окно не лишается прежнего значка', () => {
    // `None` (а не пара нулей) — иначе Windows сняла бы текущий значок окна
    expect(rust).toMatch(/fn style_icons\([\s\S]{0,400}?-> Option<\(usize, usize\)>/);
    expect(rust).toContain('want_class.and_then(|cls| style_icons(');
  });
});
