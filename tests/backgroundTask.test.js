import { it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ startTask: vi.fn(), finish: vi.fn(), log: vi.fn() }));
vi.mock('../js/core/taskLog.js', () => ({ startTask: mocks.startTask }));
import { backgroundTask } from '../js/core/backgroundTask.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.startTask.mockReturnValue({ finish: mocks.finish, log: mocks.log });
});
it('journals background start, steps and finish without occupying the script queue', async () => {
  const task = backgroundTask('Проверка серверов');
  task.log('Чтение');
  task.finish('Готово');
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('Готово', 'done'));
  expect(mocks.startTask).toHaveBeenCalledWith('Фоновая задача: Проверка серверов', { dock: false });
  expect(mocks.log).toHaveBeenCalledWith('Чтение');
});
it('does not fail the background reader when the journal is unavailable', async () => {
  mocks.startTask.mockImplementation(() => {
    throw new Error('storage unavailable');
  });
  expect(() => {
    const task = backgroundTask('Новости');
    task.log('Чтение');
    task.finish('Недоступно', 'warn');
  }).not.toThrow();
  await vi.waitFor(() => expect(mocks.startTask).toHaveBeenCalled());
});
