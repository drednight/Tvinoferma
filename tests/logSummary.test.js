// tests/logSummary.test.js
// Итоговая таблица в журнале скриптов и перепроверка ошибок перед ней.
//
// Зачем: по журналу итог приходилось собирать глазами («Коля: ок», «Сокол: ок»,
// «Дима: таймаут»), а сколько в сети — непонятно, пока не сложишь руками.
import { describe, it, expect } from 'vitest';
import { startTask } from '../js/core/taskLog.js';
import { authSummaryRows } from '../js/modules/sync/syncManager.js';

const char = (nick, isLoggedIn, over = {}) => ({ id: `c-${nick}`, nick, isLoggedIn, ...over });

describe('итоговая таблица в журнале', () => {
  it('запись добавляется в конец журнала и не ломает счётчики', () => {
    const task = startTask('Проверка', { total: 1 });
    task.log('начали', 'step');
    task.summaryTable([{ name: 'Коля', status: 'Авторизован', tone: 'ok' }]);
    const last = task.entries[task.entries.length - 1];
    expect(last.level).toBe('summary');
    expect(last.rows[0].name).toBe('Коля');
    // Таблица не ошибка и не предупреждение: счётчики плашки не должны от неё краснеть
    expect(task.errors).toBe(0);
    expect(task.warnings).toBe(0);
  });

  it('пустая таблица не занимает место в журнале', () => {
    const task = startTask('Проверка', { total: 0 });
    const before = task.entries.length;
    task.summaryTable([]);
    expect(task.entries.length).toBe(before + 1);
    // Запись есть, а рисовать нечего — это разные вещи, и решает рендер
    expect(task.entries[task.entries.length - 1].rows).toEqual([]);
  });

  it('строки без имени в таблицу не попадают', () => {
    const rows = authSummaryRows([char('Коля', true), { isLoggedIn: true }], []);
    expect(rows.map((r) => r.name)).toEqual(['Коля']);
  });
});

describe('строки итогов проверки входа', () => {
  it('три состояния не смешиваются', () => {
    const rows = authSummaryRows([
      char('Коля', true),
      char('Сокол', false),
      char('Дима', null)
    ], []);
    expect(rows.map((r) => [r.name, r.status, r.tone])).toEqual([
      ['Коля', 'Авторизован', 'ok'],
      ['Сокол', 'Не авторизован', 'warn'],
      // «Нет входа» — это ответ сайта, «не получилось» — наша неудача. Смешивать нельзя.
      ['Дима', 'Не получилось', 'error']
    ]);
    // Пояснение обязано быть у всех, кроме «Авторизован»: там всё ясно и дописывать нечего
    expect(rows[0].note).toBe('');
    expect(rows[1].note).not.toBe('');
  });

  it('причина неудачи попадает в пояснение', () => {
    const rows = authSummaryRows([char('Дима', null, { lastLoginReason: 'Таймаут' })], []);
    expect(rows[0].note).toContain('Таймаут');
  });

  it('пропущенные не молчат: их тоже видно в таблице', () => {
    // Персонаж с открытым окном не проверяли — молчать о нём нельзя, иначе итог врёт
    const rows = authSummaryRows([char('Коля', true)], ['Дима']);
    expect(rows.map((r) => r.status)).toEqual(['Авторизован', 'Пропущен']);
    expect(rows[1].note).toContain('окно');
  });

  it('порядок строк совпадает с порядком проверки', () => {
    const rows = authSummaryRows([char('Б', true), char('А', true), char('В', true)], []);
    expect(rows.map((r) => r.name)).toEqual(['Б', 'А', 'В']);
  });
});