import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../js/core/ui.js', () => ({ toast: vi.fn() }));

import { autostartNote, healAutostart, bindAutostart, getAutostart, setAutostart } from '../js/desktop/autostart.js';
import { toast } from '../js/core/ui.js';

const html = readFileSync('index.html', 'utf8');
const info = (over = {}) => ({ supported: true, enabled: false, minimized: true, path: '', current: false, broken: false, admin: false, selfElevated: false, ...over });

describe('автозапуск: тексты', () => {
  it('выключен, включён в трее, включён с окном, чужая копия, не Windows', () => {
    expect(autostartNote(info())).toBe('Выключен.');
    expect(autostartNote(info({ enabled: true, minimized: true, current: true }))).toContain('сразу в трей');
    expect(autostartNote(info({ enabled: true, minimized: false, current: true }))).toContain('с окном');
    expect(autostartNote(info({ enabled: true, current: false, path: 'D:\\Old\\t.exe' }))).toContain('D:\\Old\\t.exe');
    expect(autostartNote(info({ supported: false }))).toContain('только в Windows');
    expect(autostartNote(info({ selfElevated: true }))).toContain('запущена от администратора');
  });

  it('где искать запись: обычный режим — в Диспетчере задач, от администратора — в Планировщике', () => {
    // Обычный режим: запись в реестре, её видно в диспетчере задач
    const plain = autostartNote(info({ enabled: true, minimized: true, current: true }));
    expect(plain).toContain('Диспетчер задач → Автозагрузка');
    expect(plain).toContain('Tvinoferma');

    // От администратора: задание Планировщика, в «Автозагрузке» диспетчера его не будет —
    // без этой подсказки кажется, что автозапуск не работает
    const admin = autostartNote(info({ enabled: true, minimized: true, current: true, admin: true }));
    expect(admin).toContain('Планировщик заданий');
    expect(admin).toContain('не видно');
    expect(admin).toContain('от администратора');
  });
});

describe('автозапуск: команды Rust', () => {
  it('статус и переключение идут в autostart_status / autostart_set', async () => {
    const invoke = vi.fn(async () => info());
    await getAutostart({ invoke });
    await setAutostart(1, 0, 0, { invoke });
    expect(invoke).toHaveBeenNthCalledWith(1, 'autostart_status');
    expect(invoke).toHaveBeenNthCalledWith(2, 'autostart_set', { enabled: true, minimized: false, admin: false });
  });

  it('запись на несуществующий файл перезаписывается с тем же режимом; исправная и выключенная не трогаются', async () => {
    const invoke = vi.fn(async () => info({ enabled: true, current: true }));
    await healAutostart(info({ enabled: true, broken: true, minimized: false }), { invoke });
    expect(invoke).toHaveBeenCalledWith('autostart_set', { enabled: true, minimized: false, admin: false });
    invoke.mockClear();
    expect(await healAutostart(info({ enabled: true, current: true }), { invoke })).toBeNull();
    expect(await healAutostart(info(), { invoke })).toBeNull();
    // запись «от администратора» молча не пересоздаётся: это был бы запрос UAC при каждом запуске
    expect(await healAutostart(info({ enabled: true, broken: true, admin: true }), { invoke })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('автозапуск: переключатели в настройках', () => {
  beforeEach(() => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    document.body.innerHTML = doc.getElementById('autostart-block').outerHTML;
    toast.mockClear();
  });

  it('блок есть в разметке и по умолчанию скрыт (вне приложения он не нужен)', () => {
    expect(document.getElementById('autostart-block').hidden).toBe(true);
    expect(document.getElementById('autostart-enabled')).toBeTruthy();
    expect(document.getElementById('autostart-minimized')).toBeTruthy();
    expect(document.getElementById('autostart-admin')).toBeTruthy();
  });

  it('показывает текущее состояние, а изменение переключателя отправляется в Rust', async () => {
    let current = info({ enabled: true, minimized: true, current: true });
    const invoke = vi.fn(async (cmd, args) => {
      if (cmd === 'autostart_set') current = info({ enabled: args.enabled, minimized: args.minimized, admin: args.admin, current: true });
      return current;
    });
    await bindAutostart({ invoke });
    const on = document.getElementById('autostart-enabled');
    const min = document.getElementById('autostart-minimized');
    expect(document.getElementById('autostart-block').hidden).toBe(false);
    expect(on.checked).toBe(true);
    expect(min.checked).toBe(true);

    min.checked = false;
    min.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('autostart_set', { enabled: true, minimized: false, admin: false }));
    await vi.waitFor(() => expect(document.getElementById('autostart-note').textContent).toContain('с окном'));

    on.checked = false;
    on.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('autostart_set', { enabled: false, minimized: false, admin: false }));
    await vi.waitFor(() => expect(min.disabled).toBe(true)); // режим без автозапуска не выбирается
    expect(document.getElementById('autostart-admin').disabled).toBe(true);
  });

  it('«От имени администратора» отправляет admin=true и показывает предупреждение про запрос Windows', async () => {
    let current = info({ enabled: true, minimized: true, current: true });
    const invoke = vi.fn(async (cmd, args) => {
      if (cmd === 'autostart_set') current = info({ ...current, admin: args.admin });
      return current;
    });
    await bindAutostart({ invoke });
    const adm = document.getElementById('autostart-admin');
    expect(adm.checked).toBe(false);
    adm.checked = true;
    adm.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('autostart_set', { enabled: true, minimized: true, admin: true }));
    expect(toast.mock.calls[0][0]).toContain('спросит разрешение');
    await vi.waitFor(() => expect(document.getElementById('autostart-note').textContent).toContain('от администратора'));
  });

  it('не Windows: блок остаётся скрытым; ошибка записи показывается и состояние перечитывается', async () => {
    await bindAutostart({ invoke: async () => info({ supported: false }) });
    expect(document.getElementById('autostart-block').hidden).toBe(true);

    let fail = false;
    const invoke = vi.fn(async (cmd) => {
      if (cmd === 'autostart_set' && fail) throw new Error('Не удалось записать автозапуск (код 5)');
      return info();
    });
    await bindAutostart({ invoke });
    fail = true;
    const on = document.getElementById('autostart-enabled');
    on.checked = true;
    on.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toContain('код 5');
    await vi.waitFor(() => expect(on.checked).toBe(false));
  });
});

describe('автозапуск: Rust', () => {
  it('задание Планировщика с наивысшими правами создаётся вместо записи Run', () => {
    const rs = readFileSync('src-tauri/src/autostart.rs', 'utf8');
    expect(rs).toContain('HighestAvailable');
    expect(rs).toContain('/Create');
    expect(rs).toMatch(/task_create\([\s\S]{0,200}reg::remove\(VALUE_NAME\)/);
  });

  it('команды зарегистрированы, окно прячется при --minimized', () => {
    const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
    expect(lib).toContain('autostart::autostart_status');
    expect(lib).toContain('autostart::autostart_set');
    expect(lib).toMatch(/started_minimized\(\)[\s\S]{0,200}hide\(\)/);
  });
});
