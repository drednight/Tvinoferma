import { describe, it, expect, vi } from 'vitest';

vi.mock('../js/core/state.js', () => ({ state: { characters: [{ id: 'c1', nick: 'Ауразак' }] } }));
const { withNick, startTask, logScope } = await import('../js/core/taskLog.js');

describe('ник персонажа в логах', () => {
  it('добавляет ник к строкам scope char:<id>', () => {
    expect(withNick('char:c1', 'Жду загрузки')).toBe('Ауразак: Жду загрузки');
  });
  it('не дублирует ник, если он уже есть', () => {
    expect(withNick('char:c1', 'Ауразак: вход подтверждён')).toBe('Ауразак: вход подтверждён');
  });
  it('другие scope не трогает', () => {
    expect(withNick('scan', 'Текст')).toBe('Текст');
  });
  it('logScope пишет строку с ником в задачу', () => {
    const task = startTask('Тест').watch('char:c1');
    logScope('char:c1', 'Сессия сохранена');
    expect(task.entries.at(-1).message).toBe('Ауразак: Сессия сохранена');
    task.finish('ok');
  });
});
