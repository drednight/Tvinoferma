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

describe('точечное обновление плашек задач', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); document.body.innerHTML = ''; });
  it('новая строка не пересоздаёт чужие плашки, завершение добавляет кнопку скрытия', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const first = startTask('Первая задача'), second = startTask('Вторая задача');
    const other = document.querySelector(`[data-task-card="${second.id}"]`);
    first.log('Новый шаг');expect(document.querySelector(`[data-task-card="${second.id}"]`)).toBe(other);
    first.finish('Готово');expect(document.querySelector(`[data-task-close="${first.id}"]`)).not.toBeNull();
  });
});

describe('ход выполнения в полном логе', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); document.body.innerHTML = '<div id="modal-root"></div>'; });
  it('показывает актуальный прогресс и отмену без повторного открытия того же лога', async () => {
    const { startTask, openTaskLog } = await import('../js/core/taskLog.js');
    const task = startTask('Проверка', {total:4,dock:false,cancelable:true});task.progress(1,4);openTaskLog(task.id);
    expect(document.querySelector('.tf-dialog-sub').textContent).toContain('25%');expect(document.querySelector('.tf-dialog-sub [data-task-log]')).toBeNull();
    task.progress(2,4);await vi.waitFor(() => expect(document.querySelector('.tf-dialog-sub').textContent).toContain('50%'));
    document.querySelector('.tf-dialog-sub [data-task-cancel]').click();expect(task.cancelled).toBe(true);
    const { closeModal } = await import('../js/core/ui.js');closeModal();expect(document.querySelector('.tf-overlay')).toBeNull();task.finish('Готово');
  });
});


describe('частота перерисовки полного журнала', () => {
  it('объединяет поток строк в одну перерисовку и сохраняет фильтр ошибок', async () => {
    vi.resetModules();vi.useFakeTimers();localStorage.clear();document.body.innerHTML='<div id="modal-root"></div>';
    try {
      const {startTask,openTaskLog}=await import('../js/core/taskLog.js');const task=startTask('Проверка',{dock:false});openTaskLog(task.id);
      const checkbox=document.querySelector('[data-only-problems]');checkbox.checked=true;checkbox.dispatchEvent(new Event('change'));
      const list=document.querySelector('.tl-full');for(let i=0;i<500;i++)task.log(`Шаг ${i}`);task.log('Ошибка','error');
      expect(document.querySelector('.tl-full')).toBe(list);await vi.advanceTimersByTimeAsync(100);
      expect(document.querySelector('.tl-full')).not.toBe(list);expect(document.querySelector('[data-only-problems]').checked).toBe(true);
      expect(document.querySelectorAll('.tl-full .tl-entry')).toHaveLength(1);
      const {closeModal}=await import('../js/core/ui.js');closeModal();task.log('После закрытия');await vi.advanceTimersByTimeAsync(200);expect(document.querySelector('.tf-overlay')).toBeNull();
    } finally {vi.useRealTimers();}
  });
});
