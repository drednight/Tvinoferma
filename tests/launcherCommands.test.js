// Связка интерфейса и Rust для новых команд запуска игры и разбора скриншота.
// Проверяем, что имена команд и параметры совпадают с обеих сторон: расхождение
// проявилось бы только в собранном приложении, где эти тесты и нужны.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const rustLib = readFileSync('src-tauri/src/lib.rs', 'utf8');
const rustLauncher = readFileSync('src-tauri/src/launcher.rs', 'utf8');
const rustOcr = readFileSync('src-tauri/src/stats_ocr.rs', 'utf8');
const rustReset = readFileSync('src-tauri/src/commands/factory_reset.rs', 'utf8');
const jsLaunch = readFileSync('js/modules/launcher/launch.js', 'utf8');
const jsImport = readFileSync('js/modules/characters/statsImport.js', 'utf8');
const jsReset = readFileSync('js/settings/factoryReset.js', 'utf8');

describe('новые команды зарегистрированы в Rust', () => {
  it.each([
    'launcher::launcher_running_details',
    'launcher::launcher_close_clients_pids',
    'launcher::launcher_decorate_clients',
    'stats_ocr::stats_ocr_available',
    'stats_ocr::stats_ocr_read',
    'commands::factory_reset::factory_reset'
  ])('%s', (name) => {
    expect(rustLib).toContain(name);
  });

  it('модуль разбора скриншота подключён к приложению', () => {
    expect(rustLib).toContain('mod stats_ocr;');
    expect(readFileSync('src-tauri/src/commands/mod.rs', 'utf8')).toContain('pub mod factory_reset;');
  });
});

describe('список окон игры: параметры совпадают', () => {
  // Срез начинается с описания структуры: сам атрибут serde стоит выше строки `pub struct`
  const struct = rustLauncher.slice(
    rustLauncher.indexOf('/// Один запущенный клиент игры'),
    rustLauncher.indexOf('/// Запущенные клиенты игры с подробностями')
  );

  it('Rust отдаёт те поля, которые читает интерфейс', () => {
    for (const field of ['pid', 'image', 'started_at', 'title', 'hwnd', 'elevated']) {
      expect(struct, field).toContain(field);
    }
    // camelCase — так поля приходят в JS
    expect(struct).toContain('rename_all = "camelCase"');
    expect(jsLaunch).toContain('launcher_running_details');
  });

  it('закрытие выбранных окон принимает список PID', () => {
    expect(rustLauncher).toContain('pub async fn launcher_close_clients_pids(pids: Vec<u32>)');
    expect(jsLaunch).toContain("'launcher_close_clients_pids', { pids }");
  });
});

describe('повторная подпись окон: параметры совпадают', () => {
  const target = rustLauncher.slice(rustLauncher.indexOf('pub struct DecorateTarget'), rustLauncher.indexOf('pub struct DecorateResult'));

  it('Rust ждёт pid, title и значки в camelCase', () => {
    for (const field of ['pid', 'title', 'icon_small', 'icon_big']) {
      expect(target, field).toContain(field);
    }
    expect(target).toContain('rename_all = "camelCase"');
  });

  it('интерфейс передаёт именно эти поля', () => {
    expect(jsLaunch).toContain("invoke('launcher_decorate_clients', { targets: list })");
    expect(jsLaunch).toContain('iconSmall: r.decor.iconSmall || null');
    expect(jsLaunch).toContain('iconBig: r.decor.iconBig || null');
  });

  it('итог подписи проверяется после запуска пати', () => {
    const party = readFileSync('js/modules/launcher/partyLaunch.js', 'utf8');
    expect(party).toContain('verifyLaunchedDecor(results)');
  });
});

describe('разбор скриншота: параметры совпадают', () => {
  it('Rust принимает байты картинки и отдаёт строки с координатами', () => {
    expect(rustOcr).toContain('pub async fn stats_ocr_read(image: Vec<u8>)');
    expect(rustOcr).toContain('pub struct OcrLine');
    for (const field of ['text', 'x', 'y', 'w', 'h']) {
      expect(rustOcr, field).toContain(`pub ${field}`);
    }
  });

  it('интерфейс передаёт байты и читает строки', () => {
    expect(jsImport).toContain("invoke('stats_ocr_read', { image: Array.from(buffer) })");
    expect(jsImport).toContain('res?.lines || []');
  });

  it('есть проверка доступности распознавания в системе', () => {
    expect(rustOcr).toContain('pub async fn stats_ocr_available()');
    expect(jsImport).toContain("invoke('stats_ocr_available')");
  });

  it('размер файла ограничен: скриншот окна, а не что угодно', () => {
    expect(rustOcr).toContain('MAX_BYTES');
    expect(rustOcr).toMatch(/24 \* 1024 \* 1024/);
  });
});

describe('полный сброс: параметры совпадают', () => {
  it('Rust принимает ключи хранилища ОС и отдаёт отчёт', () => {
    // Сигнатура может быть записана в одну строку или разбита rustfmt — проверяем суть
    expect(rustReset).toMatch(/pub async fn factory_reset\([\s\S]{0,120}?keys: Vec<String>/);
    expect(rustReset).toContain('pub struct FactoryResetReport');
    expect(jsReset).toContain("invoke('factory_reset', { keys })");
  });

  it('интерфейс передаёт ключи, собранные из данных', () => {
    expect(jsReset).toContain("invoke('factory_reset', { keys })");
    expect(jsReset).toContain('secretsToRemove(appState.characters)');
  });

  it('сброс удаляет и файлы, и записи хранилища ОС', () => {
    for (const what of ['cookie-bank', 'pw-sync-profiles', 'state.json', 'cookie-bank-key']) {
      expect(rustReset, what).toContain(what);
    }
  });

  it('кнопка сброса есть в разметке и спрятана среди опасных действий', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain('id="factory-reset-btn"');
    const zone = html.slice(html.indexOf('id="danger-zone"'));
    expect(zone.indexOf('factory-reset-btn')).toBeGreaterThan(-1);
    // Кнопка внутри вложенного сворачиваемого блока — случайно не нажать
    expect(html).toContain('data-factory-reset="1"');
  });

  it('кнопки проверки окон игры больше нет', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).not.toContain('inspect-game-windows-btn');
    const settings = readFileSync('js/settings/settings.js', 'utf8');
    expect(settings).not.toContain('inspect-game-windows-btn');
  });
});
