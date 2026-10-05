// Список запущенных окон игры (js/modules/launcher/windowList.js): ник и класс из заголовка окна,
// время работы, пометка «окно запущено не из Твинофермы», порядок строк.
import { describe, it, expect } from 'vitest';

import {
  formatUptime, parseWindowTitle, windowRows, rowLabel, closeSelectedText
} from '../js/modules/launcher/windowList.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const at = (minAgo) => NOW - minAgo * 60000;

describe('время работы окна', () => {
  it('секунды, минуты, часы', () => {
    expect(formatUptime(5000)).toBe('5 с');
    expect(formatUptime(90000)).toBe('1 мин');
    expect(formatUptime(3600e3 * 1.5)).toBe('1 ч 30 мин');
    expect(formatUptime(3600e3 * 2 + 5 * 60000)).toBe('2 ч 05 мин');
  });

  it('отрицательное и пустое значение не ломают вывод', () => {
    expect(formatUptime(-100)).toBe('0 с');
    expect(formatUptime(undefined)).toBe('0 с');
  });
});

describe('разбор заголовка окна', () => {
  it('наш заголовок «Ник — Класс» разбирается на части', () => {
    expect(parseWindowTitle('Ауразак — Воин')).toEqual({ nick: 'Ауразак', cls: 'Воин' });
    expect(parseWindowTitle('Ник с пробелом — Маг')).toEqual({ nick: 'Ник с пробелом', cls: 'Маг' });
    expect(parseWindowTitle('ТолькоНик')).toEqual({ nick: 'ТолькоНик', cls: '' });
  });

  it('игровые заголовки ником не считаются: такое окно покажем как PID', () => {
    expect(parseWindowTitle('Perfect World')).toBeNull();
    expect(parseWindowTitle('Element Client')).toBeNull();
    expect(parseWindowTitle('')).toBeNull();
    expect(parseWindowTitle('   ')).toBeNull();
  });

  it('слишком длинный «ник» — это не ник', () => {
    expect(parseWindowTitle('x'.repeat(60))).toBeNull();
  });
});

describe('строки списка окон', () => {
  const characters = [
    { id: 'a', nick: 'Ауразак', class: 'Воин', partyIds: ['p1'] },
    { id: 'b', nick: 'Мираж', class: 'Маг', partyIds: ['p2'] }
  ];

  it('окно сопоставляется с персонажем по нику, класс берётся из карточки', () => {
    const rows = windowRows(
      [{ pid: 100, image: 'elementclient_64.exe', startedAt: at(10), title: 'Ауразак — Воин', elevated: false }],
      characters, { now: NOW }
    );
    expect(rows[0]).toMatchObject({ pid: 100, nick: 'Ауразак', cls: 'Воин', known: true, charId: 'a' });
    expect(rows[0].uptimeMs).toBe(600000);
  });

  it('окно не из Твинофермы остаётся безымянным и показывается как PID', () => {
    const rows = windowRows(
      [{ pid: 4242, image: 'elementclient_64.exe', startedAt: at(3), title: 'Perfect World', elevated: false }],
      characters, { now: NOW }
    );
    expect(rows[0].known).toBe(false);
    expect(rows[0].nick).toBe('');
    expect(rowLabel(rows[0])).toBe('PID 4242');
  });

  it('ник без класса в подписи идёт один', () => {
    const rows = windowRows([{ pid: 1, title: 'Незнакомец', startedAt: null }], characters, { now: NOW });
    expect(rows[0].nick).toBe('Незнакомец');
    expect(rowLabel(rows[0])).toBe('Незнакомец');
    expect(rows[0].uptimeMs).toBeNull();
  });

  it('порядок: сначала узнанные персонажи по алфавиту, затем безымянные окна по PID', () => {
    const rows = windowRows([
      { pid: 500, title: 'Perfect World', startedAt: at(1) },
      { pid: 200, title: 'Мираж — Маг', startedAt: at(1) },
      { pid: 100, title: 'Ауразак — Воин', startedAt: at(1) }
    ], characters, { now: NOW });
    expect(rows.map(r => r.pid)).toEqual([100, 200, 500]);
  });

  it('фильтр по пати оставляет только участников выбранных пати', () => {
    const rows = windowRows([
      { pid: 100, title: 'Ауразак — Воин', startedAt: at(1) },
      { pid: 200, title: 'Мираж — Маг', startedAt: at(1) }
    ], characters, { now: NOW, partyIds: ['p1'] });
    // Второе окно остаётся в списке (его нельзя потерять), но персонаж не сопоставляется
    expect(rows.find(r => r.pid === 100).known).toBe(true);
    expect(rows.find(r => r.pid === 200).known).toBe(false);
  });

  it('пустой список и отсутствующие поля не ломают вывод', () => {
    expect(windowRows([], characters)).toEqual([]);
    expect(windowRows(null, null)).toEqual([]);
    const [row] = windowRows([{ pid: 7 }], [], { now: NOW });
    expect(row).toMatchObject({ pid: 7, nick: '', known: false, uptimeMs: null });
  });
});

describe('итог закрытия выбранных окон', () => {
  it('все закрылись, часть закрылась, нечего закрывать', () => {
    expect(closeSelectedText({ found: 3, closed: 3 })).toBe('Закрыто окон: 3');
    expect(closeSelectedText({ found: 3, closed: 2, failed: 1 })).toBe('Закрыто 2 из 3');
    expect(closeSelectedText({ found: 0 })).toBe('Выбранные окна уже закрыты');
    expect(closeSelectedText({ error: 'нет доступа' })).toContain('нет доступа');
  });
});
