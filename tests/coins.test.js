import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseCoins, roundCoins, formatCoins, formatDelta, normalizeCoinHistory,
  applyCoinBalance, needsCoinRecheck, COIN_PARSER_VERSION
} from '../js/core/coins.js';
import { normalizeCharacter } from '../js/core/state.js';

const PARSE_CASES = [
  ['285', 285], ['28,5', 28.5], ['28.5', 28.5], ['28,50', 28.5], ['28,55', 28.5],
  ['1 285', 1285], ['1\u00a0285', 1285], ['1 285,5', 1285.5], ['1\u00a0285,5', 1285.5],
  ['1.285,5', 1285.5], ['1,285.5', 1285.5],
  ['1,285', 1285], ['1.285', 1285], ['1,285,000', 1285000], ['12 345', 12345],
  ['0,5', 0.5], ['.5', 0.5], ['0,285', 0.2], ['12,3456', 12.3], ['0, 285', 0.2], ['28,59', 28.5], ['0', 0],
  [' 28,5 ', 28.5], ['28,5 ДМ', 28.5]
];

describe('parseCoins', () => {
  it.each(PARSE_CASES)('%j → %s', (text, expected) => {
    expect(parseCoins(text)).toBe(expected);
  });
  it('мусор → NaN', () => {
    ['', 'abc', null, undefined, '1,2,3', '1.2.3,4'].forEach((t) => expect(parseCoins(t)).toBeNaN());
  });
});

describe.each(['balance.js', 'shop.js'])('копия parseCoins в src-tauri/src/scripts/%s', (file) => {
  const src = readFileSync(resolve(process.cwd(), `src-tauri/src/scripts/${file}`), 'utf8');
  const body = src.slice(src.indexOf('/*PARSE_START*/'), src.indexOf('/*PARSE_END*/'));
  const siteParse = new Function(`${body}; return parseCoins;`)();
  it('даёт те же результаты, что и js/core/coins.js', () => {
    PARSE_CASES.forEach(([text]) => expect(siteParse(text)).toBe(parseCoins(text)));
    ['', 'abc', '1,2,3'].forEach((t) => expect(siteParse(t)).toBeNaN());
  });
  it('исходники функций совпадают', () => {
    const own = readFileSync(resolve(process.cwd(), 'js/core/coins.js'), 'utf8');
    const ownBody = own.slice(own.indexOf('/*PARSE_START*/'), own.indexOf('/*PARSE_END*/'));
    const norm = (t) => t.split('\n').map((l) => l.trim()).join('\n');
    expect(norm(body)).toBe(norm(ownBody));
  });
});

describe('форматирование', () => {
  it('целые без дроби, дробные с одним знаком', () => {
    expect(formatCoins(285)).toBe('285');
    expect(formatCoins(28.5)).toBe('28,5');
    expect(formatCoins(28.0)).toBe('28');
    expect(formatCoins(1285.5).replace(/\s/g, ' ')).toBe('1 285,5');
    expect(formatCoins(28.4999999)).toBe('28,5');
  });
  it('дельта со знаком', () => {
    expect(formatDelta(2.5)).toBe('+2,5');
    expect(formatDelta(-256.5)).toBe('−256,5'.replace('−', '-'));
    expect(formatDelta(10)).toBe('+10');
  });
  it('roundCoins убирает хвосты', () => {
    expect(roundCoins(0.1 + 0.2)).toBe(0.3);
    expect(roundCoins('abc')).toBe(0);
  });
});

describe('applyCoinBalance', () => {
  it('тот же баланс: меняется только дата проверки, «+0» не пишется', () => {
    const c = { ancientCoins: 28.5, lastCoinUpdate: '2026-01-01T00:00:00.000Z', coinHistory: [] };
    const r = applyCoinBalance(c, 28.5, { now: '2026-02-02T00:00:00.000Z' });
    expect(r).toEqual({ changed: false, delta: 0 });
    expect(c.lastCoinUpdate).toBe('2026-02-02T00:00:00.000Z');
    expect(c.coinHistory).toEqual([]);
  });
  it('изменение: запись с точной дельтой, новые сверху', () => {
    const c = { ancientCoins: 28.3, coinHistory: [] };
    applyCoinBalance(c, 28.5, { now: '2026-02-02T00:00:00.000Z' });
    expect(c.coinHistory).toHaveLength(1);
    expect(c.coinHistory[0]).toMatchObject({ delta: 0.2, balanceAfter: 28.5 });
    expect(c.ancientCoins).toBe(28.5);
  });
  it('история не ограничена по количеству, новые сверху', () => {
    const c = { ancientCoins: 0, coinHistory: [] };
    for (let i = 1; i <= 25; i++) {
      applyCoinBalance(c, i, { now: new Date(2026, 0, i).toISOString() });
    }
    expect(c.coinHistory).toHaveLength(25);
    expect(c.coinHistory[0].balanceAfter).toBe(25);
    expect(c.coinHistory[24].balanceAfter).toBe(1);
  });
});

describe('нормализация сохранённых данных', () => {
  it('убирает старые «+0», остальные записи не обрезает', () => {
    const history = [
      { id: 'z', date: '2026-03-01T00:00:00Z', delta: 0 },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, date: new Date(2026, 0, i + 1).toISOString(), delta: i + 1 }))
    ];
    const out = normalizeCoinHistory(history);
    expect(out).toHaveLength(12);
    expect(out.some((h) => h.id === 'z')).toBe(false);
    expect(out[0].id).toBe('h11');
  });
  it('normalizeCharacter сохраняет дробный баланс', () => {
    const c = normalizeCharacter({ id: 'a', nick: 'A', ancientCoins: 28.54 });
    expect(c.ancientCoins).toBe(28.5);
  });
});

describe('пометка старых данных баланса (issue #1)', () => {
  const old = (extra = {}) => ({ ancientCoins: 285, lastCoinUpdate: '2025-01-01T00:00:00Z', coinHistory: [{ delta: 285, date: '2025-01-01T00:00:00Z' }], ...extra });

  it('данные, записанные до исправления, требуют перепроверки', () => {
    expect(needsCoinRecheck(old())).toBe(true);
    expect(needsCoinRecheck(old({ coinsParserV: 1 }))).toBe(true);
  });
  it('новый персонаж и проверенный по новой версии — без пометки', () => {
    expect(needsCoinRecheck({ ancientCoins: 0, coinHistory: [] })).toBe(false);
    expect(needsCoinRecheck(old({ coinsParserV: COIN_PARSER_VERSION }))).toBe(false);
    expect(needsCoinRecheck(null)).toBe(false);
  });
  it('перепроверка снимает пометку и подписывает запись в истории', () => {
    const c = old();
    const r = applyCoinBalance(c, 28.5, { now: '2025-02-01T00:00:00Z' });
    expect(r).toEqual({ changed: true, delta: -256.5 });
    expect(c.coinsParserV).toBe(COIN_PARSER_VERSION);
    expect(needsCoinRecheck(c)).toBe(false);
    expect(c.coinHistory[0].note).toMatch(/Перепроверка/);
  });
  it('если значение верное, пометка снимается без записи «+0»', () => {
    const c = old({ ancientCoins: 28.5 });
    expect(applyCoinBalance(c, 28.5).changed).toBe(false);
    expect(needsCoinRecheck(c)).toBe(false);
    expect(c.coinHistory).toHaveLength(1);
  });
  it('обычная синхронизация подписывается как раньше', () => {
    const c = old({ coinsParserV: COIN_PARSER_VERSION });
    applyCoinBalance(c, 300);
    expect(c.coinHistory[0].note).toBe('Автосинхронизация PW Online');
  });
  it('версия сохраняется при нормализации; старый файл без поля → 0 (будет пометка)', () => {
    expect(normalizeCharacter({ nick: 'a', coinsParserV: 2 }).coinsParserV).toBe(2);
    expect(normalizeCharacter({ nick: 'a', ancientCoins: 285, lastCoinUpdate: '2025-01-01T00:00:00Z' }).coinsParserV).toBe(0);
  });
});
