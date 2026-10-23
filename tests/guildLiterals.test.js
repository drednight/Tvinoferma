// tests/guildLiterals.test.js
// Литералы кланового сайта: адрес, каталог профилей и фраза-пароль.
//
// При переименовании модуля `eternals` → `guild` их задело вместе с идентификаторами,
// и окно открыло несуществующий pw-guild.ru, а сохранённый профиль браузера бросился.
// Идентификаторы переименовывать нужно, а такие строки — нет: они уходят во внешний мир.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const rust = readFileSync('src-tauri/src/guild.rs', 'utf8');
const promo = readFileSync('js/modules/automation/promo.js', 'utf8');

describe('клановый сайт: литералы не переименовываются', () => {
  it('окно открывает настоящий домен', () => {
    expect(rust).toMatch(/const GUILD_URL: &str = "https:\/\/pw-eternals\.ru\//);
    expect(rust).not.toMatch(/pw-guild\.ru/);
  });

  it('каталог профилей остался прежним: иначе потерян вход на сайт', () => {
    // Имя каталога — это путь на диске. Смена имени не переносит профиль, а создаёт рядом
    // новый пустой, и человек оказывается разлогинен на сайте клана.
    expect(rust).toContain('pw-eternals-profiles');
    expect(rust).not.toContain('pw-guild-profiles');
  });

  it('фраза-пароль принимает и старую, и новую форму', () => {
    // Смена фразы молча закрывает путь тем, кто её уже выучил
    expect(promo).toMatch(/'pw-eternals'/);
    expect(promo).toMatch(/'pw-guild'/);
  });

  it('сравнение фразы не чувствительно к регистру и пробелам', () => {
    const fn = promo.match(/const isSecretPhrase = \(value\) =>([^\n]+)/);
    expect(fn, 'нет функции сверки фразы').toBeTruthy();
    expect(fn[1]).toContain('toLowerCase');
    expect(fn[1]).toContain('trim()');
  });

  it('единственное место, где живёт домен, — Rust: в JS своего адреса нет', () => {
    // Два источника адреса разъедутся, и окно откроет не тот
    const js = readFileSync('src-tauri/src/scripts/guild.js', 'utf8');
    expect(js).not.toMatch(/https?:\/\/pw-/);
  });
});
