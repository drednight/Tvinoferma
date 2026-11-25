// tests/externalApiAcceptanceProfile.test.js
// Внешний API в тестовой сборке.
//
// Раньше Rust отказывал в запуске для любого не-`stable` профиля: проверить
// контракт на живой тестовой сборке было нельзя. Теперь API работает и там, но
// так, чтобы не мешать рабочей копии: свой порт по умолчанию и свой токен.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { statusText, profileNote } from '../js/settings/externalApiPanel.js';

const ROOT = resolve(process.cwd(), 'src-tauri/src/external_api');
const rust = readFileSync(resolve(ROOT, 'mod.rs'), 'utf8');
const index = readFileSync(resolve(process.cwd(), 'js/modules/externalApi/index.js'), 'utf8');
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

describe('внешний API в тестовой сборке', () => {
  it('Rust больше не отказывает тестовой сборке в запуске', () => {
    expect(rust).not.toContain('Внешний API выключен в тестовой сборке');
    // Запуск не должен начинаться с проверки профиля на отказ.
    const start = rust.slice(rust.indexOf('pub fn external_api_start'));
    const body = start.slice(0, start.indexOf('let _guard'));
    expect(body).not.toMatch(/app_build_profile\(\)\s*!=\s*"stable"/);
  });

  it('порт тестовой сборки свой: 47832 против 47831, и он применяется', () => {
    expect(rust).toContain('pub const DEFAULT_PORT: u16 = 47831;');
    expect(rust).toContain('pub const ACCEPTANCE_DEFAULT_PORT: u16 = 47832;');
    expect(rust).toContain('fn port_for_profile');
    // Функция подставляется в самом запуске, а не только объявлена.
    const start = rust.slice(rust.indexOf('pub fn external_api_start'));
    expect(start.slice(0, start.indexOf('let _guard'))).toContain('port_for_profile(options.port)');
    // Тест в Rust-модуле закрепляет правило.
    expect(rust).toContain('acceptance_builds_get_their_own_default_port');
  });

  it('статус отдаёт профиль, панель его помечает', () => {
    expect(rust).toContain('pub profile: String');
    expect(rust).toContain('profile: crate::profile::app_build_profile().to_string()');
    expect(index).toContain('const DEFAULT_PORT = 47831');
    // Стабильная сборка — без пометки.
    expect(profileNote({ profile: 'stable' })).toBe('');
    expect(profileNote({})).toBe('');
    // Тестовые — с явным предупреждением.
    expect(profileNote({ profile: 'acceptance' })).toMatch(/Тестовая сборка/);
    expect(profileNote({ profile: 'acceptance-shared' })).toMatch(/ТЕСТОВАЯ СБОРКА/);
    const line = statusText({
      running: true,
      port: 47832,
      scopes: { read: true },
      profile: 'acceptance'
    });
    expect(line).toContain('47832');
    expect(line).toMatch(/Тестовая сборка/);
    // У стабильной сборки пометки нет.
    expect(statusText({ running: true, port: 47831, scopes: { read: true }, profile: 'stable' })).not.toMatch(
      /Тестовая/
    );
  });

  it('в панели настроек порт тестовой сборки объяснён', () => {
    expect(html).toContain('47832');
    expect(html).toMatch(/тестовой сборке/i);
  });

  it('изоляция обеспечивается не запретом, а разными портом и токеном', () => {
    const profile = readFileSync(resolve(process.cwd(), 'src-tauri/src/profile.rs'), 'utf8');
    // Хранилище токена различается по профилю.
    expect(profile).toContain('com.tvinoferma.desktop.acceptance');
    expect(profile).toContain('pub const VAULT_SERVICE: &str = APP_ID;');
    // И это записано в документации, чтобы запрет не вернули «на всякий случай».
    const doc = readFileSync(resolve(process.cwd(), 'docs/EXTERNAL-API.md'), 'utf8');
    expect(doc).toMatch(/тестовая и рабочая копии могут работать одновременно/i);
    expect(doc).toContain('47832');
  });
});
