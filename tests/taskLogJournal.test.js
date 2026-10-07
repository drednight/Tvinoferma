// Журнал «Скрипты» переживает перезапуск приложения (issue #89):
// раньше loadJournal() вызывался до объявления class Task и молча возвращал пустой список.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../js/core/state.js', () => ({ state: { characters: [] } }));

const taskItems = async () => {
  await import('../js/core/taskLog.js'); // регистрирует источник «Скрипты» и читает журнал
  const { collectLogs } = await import('../js/core/logHub.js');
  return collectLogs({ source: 'task' }).items;
};

describe('журнал задач после перезапуска', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); });

  it('завершённая задача сохраняется и видна после «перезапуска»', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const task = startTask('Проверка баланса');
    task.log('шаг 1');
    task.finish('Готово', 'done');
    expect((await taskItems()).map(x => x.title)).toContain('Проверка баланса');

    // Перезапуск: модули загружаются заново, localStorage остаётся
    vi.resetModules();
    const items = await taskItems();
    expect(items.map(x => x.title)).toContain('Проверка баланса');
  });

  it('при запуске плашки прошлых задач не показываются, а в журнале остаются; новая задача плашку получает', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    startTask('Прошлая проверка').finish('Готово', 'warn');   // записана в журнал сразу, плашка ещё не скрылась

    vi.resetModules();
    document.body.innerHTML = '';
    const mod = await import('../js/core/taskLog.js');
    expect((await taskItems()).map(x => x.title)).toContain('Прошлая проверка');
    mod.startTask('Новая проверка');
    const dock = document.getElementById('tf-task-dock');
    expect(dock.textContent).toContain('Новая проверка');
    expect(dock.textContent).not.toContain('Прошлая проверка');
  });

  it('повреждённый журнал в localStorage не ломает запуск', async () => {
    localStorage.setItem('tf_task_journal_v1', '{не json');
    await import('../js/core/taskLog.js');
    expect(await taskItems()).toEqual([]);
  });
});
