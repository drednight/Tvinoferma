// tests/launchedWindows.test.js
// Память «какое окно мы запустили» и подстановка её в список окон.
//
// Зачем: окно узнаётся по нику из заголовка, а заголовок и значок слетают вместе. Окно,
// потерявшее заголовок, показывалось как «PID 1234», и восстановить его было нечем.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  rememberLaunched,
  rememberExistingWindow,
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

it('attaches a long-running external client using its real start and survives rereading', () => {
  const started = NOW - 48 * 60 * 60 * 1000;
  rememberExistingWindow(300, 'c2', started);
  const recalled = recalledOwnership([{ pid: 300, uptimeMs: NOW - started }], NOW);
  expect(recalled).toEqual({ 300: 'c2' });
  expect(
    windowRows([win({ pid: 300, startedAt: started, title: 'Perfect World' })], chars, { recalled })[0]
  ).toMatchObject({ known: true, charId: 'c2' });
  expect(recalledOwnership([{ pid: 300, uptimeMs: 60_000 }], NOW)).toEqual({});
});
it('refuses attachment without a verified process start', () => {
  expect(() => rememberExistingWindow(300, 'c2', null)).toThrow();
  expect(() => rememberExistingWindow(300, 'c2', NOW + 1)).toThrow();
});
it('keeps an explicit attachment after a day while the same process is alive', () => {
  const started = NOW - 100000;
  rememberExistingWindow(300, 'c2', started);
  const later = NOW + 2 * 24 * 60 * 60 * 1000;
  vi.setSystemTime(later);
  expect(recalledOwnership([{ pid: 300, uptimeMs: later - started }], later)).toEqual({ 300: 'c2' });
});

it('manual override wins over title, can be changed, and detaching restores automatic recognition', async () => {
  const { windowOwnershipOptions, forgetManualWindow } = await import('../js/modules/launcher/launchedWindows.js');
  const clients = [win({ title: 'Дракон — Жнец' })];
  const row = () => windowRows(clients, chars, windowOwnershipOptions(clients, NOW))[0];
  expect(row()).toMatchObject({ charId: 'c1', ownershipSource: 'title' });
  rememberExistingWindow(100, 'c2', clients[0].startedAt);
  expect(row()).toMatchObject({ charId: 'c2', ownershipSource: 'manual' });
  rememberExistingWindow(100, 'c1', clients[0].startedAt);
  expect(row()).toMatchObject({ charId: 'c1', ownershipSource: 'manual' });
  forgetManualWindow(100, clients[0].startedAt);
  expect(row()).toMatchObject({ charId: 'c1', ownershipSource: 'title' });
});
it('detaching an override restores the original launcher memory without a title', async () => {
  const { windowOwnershipOptions, forgetManualWindow } = await import('../js/modules/launcher/launchedWindows.js');
  const clients = [win()];
  rememberLaunched(100, 'c1');
  rememberExistingWindow(100, 'c2', clients[0].startedAt);
  forgetManualWindow(100, clients[0].startedAt + 5000);
  expect(windowOwnershipOptions(clients, NOW).manual).toEqual({ 100: 'c2' });
  forgetManualWindow(100, clients[0].startedAt);
  expect(windowRows(clients, chars, windowOwnershipOptions(clients, NOW))[0]).toMatchObject({
    charId: 'c1',
    ownershipSource: 'launcher'
  });
});
