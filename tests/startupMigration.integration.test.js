import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Точка входа работает с настоящими state/storage/миграцией; подменены только
// native IPC и сеть. Важно проверить порядок не только на уровне адаптера.
const html = readFileSync('index.html', 'utf8');
const body = html.slice(html.indexOf('<body>') + 6).replace(/<script[\s\S]*?<\/script>/g, '');
const OLD = JSON.stringify(
  {
    schemaVersion: 3,
    characters: [{ id: 'old-001', nick: 'Hero#1', contacts: { email: 'user@example.test', password: 'PRIVATE_123' } }],
    parties: [],
    marathons: [],
    settings: { ui: { guideSeen: true }, guild: { enabled: false }, autoVerifyLogins: false }
  },
  null,
  2
);
const CHANGED = '{"schemaVersion":3,"characters":[{"id":"external","nick":"Other"}]}';
let originalInternals;
let originalEventInternals;
let addedListeners;
let alertMock;
let log;
let ipc;
let disk;
let mode;
let initialRaw;
let credentials;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = body;
  localStorage.clear();
  originalInternals = window.__TAURI_INTERNALS__;
  originalEventInternals = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  addedListeners = [];
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      addedListeners.push([target, type, listener, options]);
      return add(type, listener, options);
    });
  }
  alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network blocked in test')));
  initialRaw = OLD;
  disk = { file: initialRaw, backups: [] };
  credentials = new Map();
  mode = 'success';
  ipc = vi.fn(async (cmd, args = {}) => {
    switch (cmd) {
      case 'app_build_profile':
        return mode === 'acceptance-profile'
          ? 'acceptance'
          : mode === 'shared-profile'
            ? 'acceptance-shared'
            : mode === 'unknown-profile'
              ? null
              : 'stable';
      case 'load_state_raw':
        return disk.file;
      case 'create_migration_backup':
        expect(args.expectedRaw).toBe(initialRaw);
        if (mode === 'backup-fails') throw new Error('copy failed');
        disk.backups.push(args.expectedRaw);
        if (mode === 'source-changes') disk.file = CHANGED;
        return 'state.backup-pre-migration.json';
      case 'save_state_if_unchanged':
        if (disk.file !== args.expectedRaw) throw 'TF_STATE_WRITE_UNCHANGED: source changed';
        disk.file = JSON.stringify(args.payload);
        if (mode === 'unknown-result') throw 'TF_STATE_WRITE_UNCERTAIN: response lost';
        return null;
      case 'rename_char_profiles':
      case 'launcher_running_details':
        return [];
      case 'secrets_available':
        return mode !== 'vault-unavailable';
      case 'secrets_get_many':
        if (mode === 'vault-read-error') throw new Error('PRIVATE-READ-ERROR');
        return Object.fromEntries(
          args.keys.filter(key => credentials.has(key)).map(key => [key, credentials.get(key)])
        );
      case 'secrets_set_many':
        for (const [key, value] of Object.entries(args.items)) {
          if (value) credentials.set(key, value);
          else credentials.delete(key);
          if (mode === 'vault-partial-write') throw new Error('PRIVATE-WRITE-ERROR');
        }
        return null;
      case 'secrets_delete_many':
        args.keys.forEach(key => credentials.delete(key));
        return null;
      case 'list_backups':
        return [];
      case 'get_data_dir':
        return '/virtual';
      case 'plugin:event|listen':
        return 1;
      default:
        return null;
    }
  });
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: vi.fn() };
  window.__TAURI_INTERNALS__ = {
    invoke: ipc,
    transformCallback: vi.fn(() => 1),
    unregisterCallback: vi.fn(),
    convertFileSrc: path => path
  };
});

afterEach(async () => {
  // Boot starts some dynamic imports without awaiting them; drain them before removing
  // the fake IPC to avoid work from one test leaking into the next one.
  await vi.dynamicImportSettled();
  for (const [target, type, listener, options] of addedListeners) target.removeEventListener(type, listener, options);
  window.__TAURI_INTERNALS__ = originalInternals;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = originalEventInternals;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function boot() {
  const { boot: start } = await import('../js/main.js');
  await start();
  expect(log).toHaveBeenCalledWith('[BOOT] Application ready.');
}

function calls(name) {
  return ipc.mock.calls.filter(([cmd]) => cmd === name);
}

function order(name) {
  return ipc.mock.calls.findIndex(([cmd]) => cmd === name);
}

describe('реальный порядок старта с имитацией native IPC', () => {
  it('не переносит профили и vault, когда копия не создана', async () => {
    mode = 'backup-fails';
    await boot();
    expect(disk.file).toBe(OLD);
    expect(disk.backups).toEqual([]);
    expect(calls('rename_char_profiles')).toHaveLength(0);
    expect(ipc.mock.calls.some(([cmd]) => cmd.startsWith('secrets_'))).toBe(false);
    expect(calls('save_state_if_unchanged')).toHaveLength(0);
    expect(document.getElementById('storage-readonly-banner').hidden).toBe(false);
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('Миграция и сохранение остановлены'));
    const { persist } = await import('../js/core/storage.js');
    await expect(persist()).rejects.toThrow('Запись остановлена');
  });

  it('не открывает автоматически приветствие или гайд после ошибки копирования пустого состояния', async () => {
    mode = 'backup-fails';
    initialRaw = JSON.stringify({ schemaVersion: 9, characters: [], settings: { ui: {} } });
    disk.file = initialRaw;
    await boot();
    document.querySelector('.next-nav .tab[data-tab="characters"]').click();
    await vi.advanceTimersByTimeAsync(21000);
    expect(document.querySelector('.onb-modal')).toBeNull();
    expect(document.querySelector('.tf-dialog-title')?.textContent).not.toBe('Как работает Твиноферма');
    expect(disk.file).toBe(initialRaw);
    expect(calls('save_state_if_unchanged')).toHaveLength(0);
  });

  it('при ошибке до подготовки копии также блокирует запись и сохраняет исходный файл', async () => {
    initialRaw = '{"schemaVersion":3,"characters":null}';
    disk.file = initialRaw;
    const { boot: start } = await import('../js/main.js');
    await start();
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('Критическая ошибка запуска'));
    expect(document.getElementById('storage-readonly-banner').hidden).toBe(false);
    expect(disk.file).toBe(initialRaw);
    expect(calls('create_migration_backup')).toHaveLength(0);
    expect(calls('rename_char_profiles')).toHaveLength(0);
    expect(ipc.mock.calls.some(([cmd]) => cmd.startsWith('secrets_'))).toBe(false);
    const { persist } = await import('../js/core/storage.js');
    await expect(persist()).rejects.toThrow('Запись остановлена');
  });

  it('создаёт копию до переноса профилей/vault и до подтверждённой записи', async () => {
    await boot();
    expect(disk.backups).toEqual([OLD]);
    expect(order('load_state_raw')).toBeLessThan(order('create_migration_backup'));
    expect(order('create_migration_backup')).toBeLessThan(order('rename_char_profiles'));
    expect(order('create_migration_backup')).toBeLessThan(order('secrets_available'));
    expect(order('create_migration_backup')).toBeLessThan(order('save_state_if_unchanged'));
    expect(calls('secrets_set_many')).toHaveLength(1);
    expect(calls('save_state_if_unchanged')).toHaveLength(1);
    expect(JSON.parse(disk.file).schemaVersion).toBe(10);
    expect(JSON.parse(disk.file).characters[0].contacts).toBeNull();
    expect(document.getElementById('storage-readonly-banner').hidden).toBe(true);
  });

  it('при изменении источника после копии не заменяет его и предупреждает о профилях/vault', async () => {
    mode = 'source-changes';
    await boot();
    expect(disk.file).toBe(CHANGED);
    expect(disk.backups).toEqual([OLD]);
    expect(calls('save_state_if_unchanged')).toHaveLength(1);
    expect(calls('rename_char_profiles')).toHaveLength(1);
    expect(calls('secrets_set_many')).toHaveLength(1);
    expect(document.getElementById('storage-readonly-banner').textContent).toContain('могли уже измениться');
    const { persist } = await import('../js/core/storage.js');
    await expect(persist()).rejects.toThrow('Запись остановлена');
  });

  it('не повторяет запись и запрещает восстановление при потерянном ответе', async () => {
    mode = 'unknown-result';
    await boot();
    expect(disk.backups).toEqual([OLD]);
    expect(JSON.parse(disk.file).schemaVersion).toBe(10);
    expect(calls('save_state_if_unchanged')).toHaveLength(1);
    expect(document.getElementById('storage-readonly-banner').hidden).toBe(false);
    const { persist, restoreStoredBackup } = await import('../js/core/storage.js');
    await expect(persist()).rejects.toThrow('Запись остановлена');
    await expect(restoreStoredBackup('state.backup-pre-migration.json')).rejects.toThrow('Запись остановлена');
    expect(calls('save_state_if_unchanged')).toHaveLength(1);
  });

  it('не сохраняет пустые контакты, когда state ссылается на недоступный vault', async () => {
    initialRaw = JSON.stringify({
      schemaVersion: 10,
      secretsInVault: true,
      characters: [{ id: 'Hero', nick: 'Hero', contacts: null }],
      settings: { ui: { guideSeen: true }, guild: { enabled: false }, autoVerifyLogins: false }
    });
    disk.file = initialRaw;
    mode = 'vault-unavailable';
    const pending = boot();
    await vi.waitFor(() => expect(calls('secrets_available')).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(7000);
    await pending;
    expect(calls('secrets_available')).toHaveLength(4);
    expect(disk.file).toBe(initialRaw);
    expect(calls('save_state')).toHaveLength(0);
    expect(calls('save_state_if_unchanged')).toHaveLength(0);
    expect(calls('secrets_set_many')).toHaveLength(0);
    expect(document.getElementById('storage-readonly-banner').textContent).toContain('Учётные данные');
    expect(document.getElementById('storage-readonly-banner').textContent).toContain('vault_probe_unavailable');
    const { renderSettings } = await import('../js/settings/settings.js');
    await renderSettings();
    expect(document.getElementById('vault-status').textContent).toContain('Сохранение остановлено');
    expect(document.getElementById('vault-status').textContent).toContain('vault_probe_unavailable');
    expect(document.getElementById('vault-status').textContent).not.toContain('контакты сохраняются в state.json');
    const { persist } = await import('../js/core/storage.js');
    await expect(persist()).rejects.toThrow('Запись остановлена');
  });

  it('не читает vault при неоднозначных исходных ID после нормализации', async () => {
    initialRaw = JSON.stringify({
      ...JSON.parse(OLD),
      schemaVersion: 10,
      secretsInVault: true,
      characters: [
        { id: 'same', nick: 'Первый', contacts: null },
        { id: 'Same', nick: 'Второй', contacts: null }
      ]
    });
    disk.file = initialRaw;
    credentials.set('same', '{"email":"PRIVATE"}');
    await boot();
    expect(disk.file).toBe(initialRaw);
    expect(ipc.mock.calls.some(([cmd]) => cmd === 'secrets_get_many' || cmd === 'save_state')).toBe(false);
    expect(document.getElementById('storage-readonly-banner').textContent).toContain('Учётные данные');
    expect(document.getElementById('storage-readonly-banner').textContent).toContain('vault_identity_mapping_invalid');
  });

  it('останавливает цепочку переноса старых ключей до чтения vault и профилей', async () => {
    initialRaw = JSON.stringify({
      ...JSON.parse(OLD),
      secretsInVault: true,
      characters: [
        { id: 'a', nick: 'b', contacts: null },
        { id: 'b', nick: 'c', contacts: null }
      ]
    });
    disk.file = initialRaw;
    credentials.set('b', '{"email":"PRIVATE"}');
    await boot();
    expect(disk.file).toBe(initialRaw);
    expect(
      ipc.mock.calls.some(([cmd]) =>
        ['secrets_get_many', 'secrets_set_many', 'rename_char_profiles', 'save_state_if_unchanged'].includes(cmd)
      )
    ).toBe(false);
    expect(document.getElementById('storage-readonly-banner').textContent).toContain('Учётные данные');
    expect(document.getElementById('storage-readonly-banner').textContent).toContain('vault_identity_mapping_invalid');
  });

  it.each([
    { email: 'new@example.test', password: 'PRIVATE-NEW' },
    { email: '', password: '', recoveryEmail: '', phone: '' }
  ])('при повторном включении vault не заменяет сохранённые открытые контакты устаревшими', async contacts => {
    initialRaw = JSON.stringify({
      schemaVersion: 10,
      characters: [{ id: 'Hero', nick: 'Hero', contacts }],
      settings: {
        security: { useVault: true },
        ui: { guideSeen: true },
        guild: { enabled: false },
        autoVerifyLogins: false
      }
    });
    disk.file = initialRaw;
    credentials.set('Hero', '{"email":"old@example.test","password":"PRIVATE-OLD"}');
    await boot();
    expect(disk.file).toBe(initialRaw);
    expect(credentials.get('Hero')).toBe('{"email":"old@example.test","password":"PRIVATE-OLD"}');
    expect(calls('secrets_set_many')).toHaveLength(0);
    expect(calls('save_state')).toHaveLength(0);
    expect(calls('save_state_if_unchanged')).toHaveLength(0);
    expect(document.getElementById('storage-readonly-banner').textContent).toContain(
      'контакты и данные хранилища ОС различаются'
    );
    const { renderSettings } = await import('../js/settings/settings.js');
    await renderSettings();
    expect(document.getElementById('vault-status').textContent).toContain(
      'Открытые контакты и данные хранилища ОС различаются'
    );
    expect(JSON.stringify(alertMock.mock.calls)).not.toContain('PRIVATE-OLD');
    expect(JSON.stringify(alertMock.mock.calls)).not.toContain('PRIVATE-NEW');
    const { state } = await import('../js/core/state.js');
    expect(state.characters[0].contacts.email).toBe(contacts.email);
    const compare = document.querySelector('[data-vault-review]');
    expect(compare).not.toBeNull();
    compare.click();
    expect(document.querySelector('.tf-dialog').innerHTML).not.toContain('PRIVATE-NEW');
    expect(document.querySelector('.tf-dialog').innerHTML).not.toContain('PRIVATE-OLD');
    const consent = document.querySelectorAll('.tf-dialog-body input[type="checkbox"]')[1];
    consent.click();
    document.querySelector('.tf-dialog-foot button:last-child').click();
    await vi.dynamicImportSettled();
    expect(calls('save_state_if_unchanged')).toHaveLength(1);
    expect(JSON.parse(disk.file).characters[0].contacts).toBeNull();
    expect(disk.backups).toContain(initialRaw);
    expect(credentials.get('Hero')).toContain('PRIVATE-OLD');
    expect(calls('secrets_set_many')).toHaveLength(0);
    expect(document.body.textContent).toContain('Выбор записан');
  });

  it('при повреждённой записи vault останавливает миграцию до переноса профилей', async () => {
    credentials.set('old-001', '{"password":"PRIVATE-BROKEN"');
    await boot();
    expect(disk.file).toBe(OLD);
    expect(disk.backups).toEqual([OLD]);
    expect(calls('rename_char_profiles')).toHaveLength(0);
    expect(calls('secrets_set_many')).toHaveLength(0);
    expect(calls('save_state_if_unchanged')).toHaveLength(0);
    expect(credentials.get('old-001')).toBe('{"password":"PRIVATE-BROKEN"');
    expect(document.getElementById('storage-readonly-banner').hidden).toBe(false);
    expect(JSON.stringify(alertMock.mock.calls)).not.toContain('PRIVATE-BROKEN');
  });

  it('делает проверенную копию перед переносом контактов и при текущей схеме', async () => {
    initialRaw = JSON.stringify({
      schemaVersion: 10,
      characters: [{ id: 'Hero', nick: 'Hero', contacts: { email: 'user@example.test', password: 'PRIVATE_123' } }],
      settings: { ui: { guideSeen: true }, guild: { enabled: false }, autoVerifyLogins: false }
    });
    disk.file = initialRaw;
    await boot();
    expect(disk.backups).toEqual([initialRaw]);
    expect(order('secrets_get_many')).toBeLessThan(order('create_migration_backup'));
    expect(order('create_migration_backup')).toBeLessThan(order('secrets_set_many'));
    expect(order('secrets_set_many')).toBeLessThan(order('save_state_if_unchanged'));
    expect(calls('secrets_get_many')).toHaveLength(3); // загрузка, проверка до записи, readback
    expect(JSON.parse(credentials.get('Hero')).password).toBe('PRIVATE_123');
    expect(JSON.parse(disk.file).characters[0].contacts).toBeNull();
    expect(document.getElementById('storage-readonly-banner').hidden).toBe(true);
  });

  it('не переносит контакты при неподтверждённой копии даже на текущей схеме', async () => {
    initialRaw = JSON.stringify({
      schemaVersion: 10,
      characters: [{ id: 'Hero', nick: 'Hero', contacts: { email: 'user@example.test', password: 'PRIVATE_123' } }],
      settings: { ui: { guideSeen: true }, guild: { enabled: false }, autoVerifyLogins: false }
    });
    disk.file = initialRaw;
    mode = 'backup-fails';
    await boot();
    expect(disk.file).toBe(initialRaw);
    expect(calls('secrets_set_many')).toHaveLength(0);
    expect(calls('save_state_if_unchanged')).toHaveLength(0);
    expect(document.getElementById('storage-readonly-banner').textContent).toContain('Копия перед переносом');
  });

  it('после частичной записи vault сохраняет исходный файл и запрещает повтор и восстановление', async () => {
    initialRaw = JSON.stringify({
      schemaVersion: 10,
      characters: [{ id: 'Hero', nick: 'Hero', contacts: { email: 'user@example.test', password: 'PRIVATE_123' } }],
      settings: { ui: { guideSeen: true }, guild: { enabled: false }, autoVerifyLogins: false }
    });
    disk.file = initialRaw;
    mode = 'vault-partial-write';
    await boot();
    expect(disk.backups).toEqual([initialRaw]);
    expect(disk.file).toBe(initialRaw);
    expect(credentials.has('Hero')).toBe(true); // заглушка знает, что запись успела произойти
    expect(calls('save_state_if_unchanged')).toHaveLength(0);
    expect(document.getElementById('storage-readonly-banner').hidden).toBe(false);
    const { persist, restoreStoredBackup } = await import('../js/core/storage.js');
    await expect(persist()).rejects.toThrow('Запись остановлена');
    await expect(restoreStoredBackup('state.backup-pre-migration.json')).rejects.toThrow('Запись остановлена');
  });

  it('не пропускает неизвестный формат метки vault и не раскрывает его значение', async () => {
    initialRaw = JSON.stringify({ schemaVersion: 10, secretsInVault: 'PRIVATE-MARKER', characters: [] });
    disk.file = initialRaw;
    await boot();
    expect(ipc.mock.calls.some(([cmd]) => cmd.startsWith('secrets_'))).toBe(false);
    expect(calls('save_state')).toHaveLength(0);
    expect(disk.file).toBe(initialRaw);
    expect(document.getElementById('storage-readonly-banner').hidden).toBe(false);
    expect(JSON.stringify(alertMock.mock.calls)).not.toContain('PRIVATE-MARKER');
  });
});

it('starts read-only after a possible interrupted duplicate merge and does not migrate or write vault', async () => {
  const { beginDuplicateMergeJournal } = await import('../js/core/duplicateMergeJournal.js');
  const entry = beginDuplicateMergeJournal('state.backup-123-dup-0123456789abcdef01234567-42-1.json');
  await boot();
  const banner = document.getElementById('storage-readonly-banner');
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain('слияние карточек');
  expect(banner.querySelector('button').textContent).toContain('Проверить слияние');
  expect(disk.file).toBe(OLD);
  expect(calls('create_migration_backup')).toHaveLength(0);
  expect(calls('rename_char_profiles')).toHaveLength(0);
  expect(ipc.mock.calls.some(([cmd]) => cmd.startsWith('secrets_'))).toBe(false);
  const { persist } = await import('../js/core/storage.js');
  await expect(persist()).rejects.toThrow('Запись остановлена');
  expect(JSON.parse(localStorage.getItem('tf:duplicate-merge-pending-v1'))).toEqual(entry);
});

it('fails closed at startup when the interruption marker is malformed', async () => {
  localStorage.setItem('tf:duplicate-merge-pending-v1', '{');
  await boot();
  expect(document.getElementById('storage-readonly-banner').textContent).toContain('Не удалось проверить отметку');
  expect(calls('create_migration_backup')).toHaveLength(0);
  expect(ipc.mock.calls.some(([cmd]) => cmd.startsWith('secrets_'))).toBe(false);
  const { persist } = await import('../js/core/storage.js');
  await expect(persist()).rejects.toThrow('Запись остановлена');
});

it('shows an unmistakable test-build banner after native profile detection', async () => {
  mode = 'acceptance-profile';
  await boot();
  const banner = document.getElementById('build-profile-banner');
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain('ТЕСТОВАЯ СБОРКА');
  expect(banner.textContent).toContain('не проверена');
});

it('warns and disables updates when native profile cannot be determined', async () => {
  mode = 'unknown-profile';
  await boot();
  const banner = document.getElementById('build-profile-banner');
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain('Обновления отключены');
});

it('warns prominently that the test build changes the stable shared profile', async () => {
  mode = 'shared-profile';
  await boot();
  const banner = document.getElementById('build-profile-banner');
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain('ОБЩИЙ ПРОФИЛЬ');
  expect(banner.textContent).toContain('затрагивают данные основной версии');
  expect(banner.textContent).toContain('Автообновление отключено');
});
