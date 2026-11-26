// tests/externalApiToken.test.js
// Токен внешнего API: его можно получить, не сжигая.
//
// Почему это отдельно от остальных наборов. Раньше значение показывали один раз —
// сразу после перевыпуска, а в настройках стояло «повторно показать нельзя».
// Практический смысл: потерял копию — вынужден перевыпускать, а перевыпуск
// отключает все уже настроенные программы (`401`). Отсюда и жалоба «токен
// постоянно приходится обновлять». Теперь есть чтение без побочных эффектов, и
// тесты держат именно эту границу:
//   - `peekToken`/`currentToken` читают хранилище и ничего не пишут;
//   - отсутствие записи — не выдуманное значение, а понятный отказ;
//   - повреждённая запись не «чинится» молча новым токеном;
//   - строка панели обещает то, что делает UI, а не старое поведение.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { state } from '../js/core/state.js';
import { peekToken, readToken, TOKEN_PATTERN, __setInvoke } from '../js/modules/externalApi/token.js';
import { currentToken } from '../js/modules/externalApi/index.js';
import { tokenText } from '../js/settings/externalApiPanel.js';

/**
 * Поддельное хранилище ОС: те же команды `secrets_*`, что и у контактов.
 * Возвращает лог вызовов, чтобы видеть, читали токен или перезаписывали.
 */
function fakeVault({ records = {}, fail = null } = {}) {
  /** @type {Array<{ cmd: string, args: any }>} */
  const calls = [];
  const store = { ...records };
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (fail === cmd) throw new Error(`vault down: ${cmd}`);
    if (cmd === 'secrets_get_many') {
      const out = {};
      for (const key of args?.keys || []) if (store[key] !== undefined) out[key] = store[key];
      return out;
    }
    if (cmd === 'secrets_set_many') {
      for (const [key, value] of Object.entries(args?.items || {})) {
        if (value) store[key] = value;
        else delete store[key];
      }
      return { ok: true };
    }
    throw new Error(`неизвестная команда: ${cmd}`);
  };
  __setInvoke(invoke);
  return { calls, store };
}

const TOKEN = 'a'.repeat(64);
const KEY = 'external-api-v1';

describe('внешний API: чтение токена без перевыпуска', () => {
  let settings = null;
  beforeEach(() => {
    state.settings = state.settings || {};
    settings = { enabled: true, port: 47831, allowRead: true, tokenCreatedAt: null };
    state.settings.externalApi = settings;
  });
  afterEach(() => {
    __setInvoke(null);
  });

  it('peekToken отдаёт сохранённое значение и не трогает хранилище', async () => {
    const { calls } = fakeVault({ records: { [KEY]: TOKEN } });
    const result = await peekToken();
    expect(result).toEqual({ ok: true, token: TOKEN });
    // Ровно одно чтение. Запись сюда означает «мы тайком поменяли токен».
    expect(calls.map(c => c.cmd)).toEqual(['secrets_get_many']);
    expect(TOKEN_PATTERN.test(result.token || '')).toBe(true);
  });

  it('currentToken тоже ничего не создаёт, если токен уже есть', async () => {
    const { calls, store } = fakeVault({ records: { [KEY]: TOKEN } });
    const result = await currentToken();
    expect(result).toEqual({ ok: true, token: TOKEN, created: false });
    expect(store[KEY]).toBe(TOKEN);
    expect(calls.some(c => c.cmd === 'secrets_set_many')).toBe(false);
    // Дата создания не должна «омолаживаться» от одного копирования.
    expect(settings.tokenCreatedAt).toBe(null);
  });

  it('нет записи — честный отказ, а не выдуманный токен', async () => {
    fakeVault();
    const peek = await peekToken();
    expect(peek.ok).toBe(false);
    expect(peek.absent).toBe(true);
    expect(peek.token).toBeUndefined();
    expect(peek.error).toContain('Токена ещё нет');
  });

  it('при включённом сервере currentToken создаёт токен один раз и говорит об этом', async () => {
    const { calls, store } = fakeVault();
    const first = await currentToken();
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(TOKEN_PATTERN.test(first.token || '')).toBe(true);
    // Созданное сохранено: следующий запуск приложения увидит то же значение.
    expect(store[KEY]).toBe(first.token);
    expect(settings.tokenCreatedAt).toBeTruthy();
    const second = await currentToken();
    expect(second).toEqual({ ok: true, token: first.token, created: false });
    // Одна запись на создание, больше хранилище не трогали.
    expect(calls.filter(c => c.cmd === 'secrets_set_many').length).toBe(1);
  });

  it('при выключенном сервере ничего не создаётся', async () => {
    settings.enabled = false;
    fakeVault();
    const result = await currentToken();
    expect(result.ok).toBe(false);
    expect(result.token).toBeUndefined();
    expect(settings.tokenCreatedAt).toBe(null);
  });

  it('хранилище недоступно — ошибка наружу, токена нет', async () => {
    fakeVault({ fail: 'secrets_get_many' });
    const peek = await peekToken();
    expect(peek.ok).toBe(false);
    expect(peek.absent).toBeUndefined();
    expect(peek.error).toContain('Не удалось прочитать токен');
  });

  it('повреждённая запись не «чинится» новым токеном молча', async () => {
    fakeVault({ records: { [KEY]: 'too-short' } });
    const result = await currentToken();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('повреждён');
  });

  it('readToken остаётся строгим: null — только когда записи нет', async () => {
    fakeVault();
    expect(await readToken()).toBe(null);
  });
});

describe('внешний API: подпись токена в настройках', () => {
  it('обещает повторное копирование, а не единственный показ', () => {
    const line = tokenText({ tokenCreatedAt: '2026-11-24T10:00:00.000Z' }, { running: true });
    expect(line).toContain('хранилище учётных данных');
    expect(line).toContain('2026');
    expect(line).toContain('скопировать');
    // Старая формулировка («повторно показать нельзя») противоречит UI и
    // заставляла переводить токен — её быть не должно.
    expect(line).not.toContain('нельзя');
  });

  it('без токена говорит, откуда он возьмётся', () => {
    expect(tokenText({}, null)).toContain('ещё не создан');
    expect(tokenText({}, null)).toContain('Скопировать токен');
  });

  it('остановленный сервер помечен: значение в силе, запросы — нет', () => {
    const line = tokenText({ tokenCreatedAt: '2026-11-24T10:00:00.000Z' }, { running: false });
    expect(line).toContain('остановлен');
  });
});
