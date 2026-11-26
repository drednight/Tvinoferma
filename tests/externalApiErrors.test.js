// tests/externalApiErrors.test.js
// Каталог кодов ошибок: единая форма {"error":{"code","message"}}, читаемые
// подписи и журнал приложения.
//
// Зачем отдельный тест: коды живут в трёх местах — JS-мост, Rust (`http.rs`) и
// страница. Если они разойдутся, пользователь увидит код, которого нет в
// справочнике. Тест сверяет JS-каталог с Rust и с копией для страницы.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ERROR_CATALOG,
  errorBody,
  errorCatalogRows,
  errorHint,
  errorTitle,
  auditLine
} from '../js/modules/externalApi/errors.js';
import { errorBody as mutateErrorBody } from '../js/modules/externalApi/actions/mutate.js';
import { auditLines } from '../js/settings/externalApiPanel.js';

const ROOT = resolve(process.cwd(), 'src-tauri/src/external_api');
const rust = ['http.rs', 'mod.rs'].map(file => readFileSync(resolve(ROOT, file), 'utf8')).join('\n');

/**
 * Коды, которые Rust реально отдаёт. Формы записи в коде:
 *   error_body("too_many_connections", "…")   Response::error(404, "not_found", "…")
 *   error_body(422, "invalid_value", "…")     (429, "too_many_requests", "…")
 * Первая строка регулярки ловит пары «статус, код», вторая — одиночный код.
 * Без этого тест проверял бы сам себя вместо Rust.
 */
function rustCodes() {
  const codes = new Set();
  const pairs = /\b\d{3}\s*,\s*"([a-z_]+)"/g;
  const singles = /error_body\(\s*"([a-z_]+)"/g;
  for (const match of rust.matchAll(pairs)) codes.add(match[1]);
  for (const match of rust.matchAll(singles)) codes.add(match[1]);
  return [...codes].sort();
}

describe('каталог кодов ошибок', () => {
  it('каждый код — со статусом 400–599, подписью и советом', () => {
    const rows = errorCatalogRows();
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      expect(row.status).toBeGreaterThanOrEqual(400);
      expect(row.status).toBeLessThanOrEqual(599);
      expect(row.code).toMatch(/^[a-z][a-z_]*$/);
      expect(row.title.length).toBeGreaterThan(6);
      // Подпись — по-русски: «Значение не принято», а не «invalid_value».
      expect(row.title).toMatch(/[А-Яа-яЁё]/);
      expect(row.hint.length).toBeGreaterThan(10);
    }
  });

  it('столбики идут по возрастанию статуса, коды внутри статуса — по алфавиту', () => {
    const rows = errorCatalogRows();
    const keys = rows.map(row => `${String(row.status).padStart(3, '0')} ${row.code}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('нет кодов-двойников: один код — одно место в каталоге', () => {
    const codes = errorCatalogRows().map(row => row.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('подписи читаются по-русски и объясняют, что делать', () => {
    expect(errorTitle('invalid_value')).toBe('Значение не принято (422)');
    expect(errorTitle('no_such_character')).toBe('Персонаж не найден (404)');
    expect(errorHint('invalid_value')).toMatch(/поля|значен|допустим/i);
    expect(errorHint('no_such_character')).toMatch(/id|спис|персонаж/i);
  });

  it('неизвестный код не ломает ответ: общая подпись по статусу', () => {
    expect(errorTitle('some_future_code')).toMatch(/Ошибка/);
    expect(errorHint('some_future_code')).toBeTruthy();
  });

  it('тело ошибки — единая форма, при 500 текст исключения не утекает', () => {
    const body = errorBody({ status: 422, code: 'invalid_value', message: 'Неизвестный стат «nope»' });
    expect(body).toEqual({
      status: 422,
      body: { error: { code: 'invalid_value', message: 'Неизвестный стат «nope»' } }
    });
    const internal = errorBody(Object.assign(new Error('секретный путь /home/user'), { status: 500 }));
    expect(internal.body.error.code).toBe('internal_error');
    expect(internal.body.error.message).not.toContain('секретный');
    // mutate.js берёт формат из общего модуля — копий быть не должно.
    expect(mutateErrorBody({ status: 422, code: 'invalid_value', message: 'x' })).toEqual({
      status: 422,
      body: { error: { code: 'invalid_value', message: 'x' } }
    });
  });

  it('коды JS-каталога известны Rust-коду и наоборот', () => {
    const canonical = new Set(Object.keys(ERROR_CATALOG));
    const fromRust = rustCodes();
    expect(fromRust.length).toBeGreaterThan(10);
    const unknownInJs = fromRust.filter(code => !canonical.has(code));
    expect(unknownInJs).toEqual([]);
    // У каждого кода каталога есть подпись — даже если Rust пока его не отдаёт.
    for (const code of canonical) expect(errorTitle(code)).toMatch(/[А-Яа-яЁё]/);
  });

  it('журнал приложения подписывает ошибки, а успехи — нет', () => {
    const atMs = new Date('2026-01-02T03:04:05Z').getTime();
    const lines = auditLines([
      { atMs, method: 'GET', path: '/api/v1/health', status: 200, ms: 5 },
      { atMs, method: 'GET', path: '/api/v1/characters', status: 404, code: 'no_such_character', ms: 3 }
    ]);
    // Свежие записи сверху.
    expect(lines[0]).toContain('→ 404');
    expect(lines[0]).toContain('Персонаж не найден (404)');
    expect(lines[1]).toContain('→ 200');
    // У успеха между кодом и длительностью пусто: подписей-ошибок нет.
    expect(lines[1]).toMatch(/→ 200\s+\(5 мс\)$/);
    // У ошибки подпись стоит ровно на этом месте.
    expect(lines[0]).toMatch(/→ 404\s+Персонаж не найден \(404\)\s+\(3 мс\)$/);
    expect(auditLines([])).toEqual(['Журнал пуст.']);
    // Одна строка — одна запись: формат общий с мостом.
    expect(auditLine({ atMs, method: 'POST', path: '/x', status: 400, code: 'bad_request', ms: 1 })).toContain(
      'Некорректный запрос (400)'
    );
  });

  it('старые записи без кода подписываются по статусу', () => {
    const [line] = auditLines([{ atMs: Date.now(), method: 'GET', path: '/x', status: 401, ms: 1 }]);
    expect(line).toContain('→ 401');
    expect(line).toMatch(/[А-Яа-яЁё]/);
  });
});
