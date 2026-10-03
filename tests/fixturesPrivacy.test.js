// Защита от случайной утечки личных данных: в tests/fixtures не должно быть e-mail, ников аккаунта,
// токенов и кук. Правила обезличивания и скрипт очистки: docs/FIXTURES.md
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = 'tests/fixtures';
const files = readdirSync(DIR).filter((f) => /\.(html|json)$/.test(f));
const read = (f) => readFileSync(`${DIR}/${f}`, 'utf8');

describe('фикстуры не содержат личных данных', () => {
  it('есть что проверять', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s', (f) => {
    const text = read(f);
    // e-mail: допускаются только адреса-пустышки
    const emails = (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).filter((e) => !/@(example\.(com|org)|(?:test|t)\.(com|local))$/.test(e));
    expect(emails, 'e-mail').toEqual([]);
    // ники аккаунтов вида u_123456789: допускается только условный
    const nicks = (text.match(/\bu_\d{6,}\b/g) || []).filter((n) => n !== 'u_1000000001');
    expect(nicks, 'ник аккаунта').toEqual([]);
    // токены и подписи в адресах, сессионные куки
    expect(text, 'token в адресе').not.toMatch(/[?&;](?:amp;)?(?:token|securitytoken|hash|session)=(?!X\b)[^&"'\s<>]{6,}/i);
    expect(text, 'куки').not.toMatch(/\b(?:PHPSESSID|bb_sessionhash|bbsessionhash|Set-Cookie)\b/i);
    // реальные картинки и скрипты в HTML-фикстурах не нужны (вес и риск)
    if (f.endsWith('.html')) {
      expect(text, 'скрипты').not.toMatch(/<script\b[^>]*>[^<]{200,}/i);
      expect(text, 'data-картинки').not.toMatch(/data:image\/[a-z]+;base64,[A-Za-z0-9+/]{200,}/);
    }
  });
});
