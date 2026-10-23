// tests/launchedWindows.test.js
// Память «какое окно мы запустили» и подстановка её в список окон.
//
// Зачем: окно узнаётся по нику из заголовка, а заголовок и значок слетают вместе. Окно,
// потерявшее заголовок, показывалось как «PID 1234», и восстановить его было нечем.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  rememberLaunched,
  forgetLaunched,
  recalledOwnership,
  pruneLaunched
} from '../js/modules/launcher/launchedWindows.js';
import { windowRows } from '../js/modules/launcher/windowList.js';

const NOW = 1_700_000_000_000;
const chars = [
  { id: 'c1', nick: 'Дракон', class: 'Жнец', partyIds: ['p1'] },
  { id: 'c2', nick: 'Сокол', class: 'Лучник', partyIds: [] }
];
const win = (over = {}) => ({
  pid: 100,
  image: 'elementclient.exe',
  startedAt: NOW - 60_000,
  title: '',
  elevated: false,
  ...over
});

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe('память запусков', () => {
  it('помнит, чьё это окно', () => {
    rememberLaunched(100, 'c1');
    expect(recalledOwnership([{ pid: 100, uptimeMs: 60_000 }], NOW)).toEqual({ 100: 'c1' });
  });

  it('не доверяет записи, если окно стартовало в другое время', () => {
    // Главная защита: после перезагрузки системы PID переиспользуются. Окно с тем же
    // номером, но запущенное часом позже, — не наше.
    rememberLaunched(100, 'c1');
    const started = NOW - 60 * 60 * 1000;
    expect(recalledOwnership([{ pid: 100, uptimeMs: NOW - started }], NOW)).toEqual({});
  });

  it('окно без времени старта не угадываем', () => {
    rememberLaunched(100, 'c1');
    expect(recalledOwnership([{ pid: 100, uptimeMs: null }], NOW)).toEqual({});
  });

  it('мусор в хранилище не ломает чтение', () => {
    window.localStorage.setItem('tf:launched-windows', 'не json');
    expect(recalledOwnership([{ pid: 1, uptimeMs: 1000 }], NOW)).toEqual({});
  });

  it('вычищаются PID, которых больше нет среди окон', () => {
    rememberLaunched(100, 'c1');
    rememberLaunched(200, 'c2');
    pruneLaunched([{ pid: 200 }]);
    expect(recalledOwnership([{ pid: 200, uptimeMs: 60_000 }], NOW)).toEqual({ 200: 'c2' });
    expect(recalledOwnership([{ pid: 100, uptimeMs: 60_000 }], NOW)).toEqual({});
  });

  it('forgetLaunched убирает запись', () => {
    rememberLaunched(100, 'c1');
    forgetLaunched(100);
    expect(recalledOwnership([{ pid: 100, uptimeMs: 60_000 }], NOW)).toEqual({});
  });
});

describe('список окон узнаёт потерявшие заголовок', () => {
  it('окно с чужим заголовком получает персонажа из памяти', () => {
    rememberLaunched(100, 'c1');
    const recalled = recalledOwnership([{ pid: 100, uptimeMs: 60_000 }], NOW);
    const [row] = windowRows([win()], chars, { now: NOW, recalled });
    expect(row.known).toBe(true);
    expect(row.charId).toBe('c1');
    expect(row.nick).toBe('Дракон');
    expect(row.cls).toBe('Жнец');
  });

  it('окно, запущенное не нами, остаётся безымянным', () => {
    // Память о нём ничего не знает — значит, отображать его как «PID 100» честнее,
    // чем приписать чужое окно чужому персонажу
    const [row] = windowRows([win()], chars, { now: NOW, recalled: {} });
    expect(row.known).toBe(false);
    expect(row.nick).toBe('');
  });

  it('заголовок важнее памяти: окно с «Ник — Класс» опознаётся как раньше', () => {
    rememberLaunched(100, 'c2'); // в памяти другой персонаж
    const [row] = windowRows([win({ title: 'Дракон — Жнец' })], chars, { now: NOW, recalled: { 100: 'c2' } });
    expect(row.charId).toBe('c1');
    expect(row.nick).toBe('Дракон');
  });
});
