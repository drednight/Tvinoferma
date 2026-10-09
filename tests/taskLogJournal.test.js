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

describe('пауза и мгновенная остановка', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); document.body.innerHTML = '<div class="topbar-right"></div>'; });

  it('пауза останавливает очередь и продолжается обратно', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const seen = [];
    const task = startTask('Проверка входа', { total: 2, cancelable: true }).onPause(v => seen.push(v));
    expect(task.paused).toBe(false);
    task.togglePause();
    expect(task.paused).toBe(true);
    task.togglePause();
    expect(task.paused).toBe(false);
    expect(seen).toEqual([true, false]);
    // Пауза не отменяет задачу: её можно продолжить
    expect(task.cancelled).toBe(false);
  });

  it('стоп обрывает работу сразу, отмена — только очередь', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    let cancelled = 0, stopped = 0;
    const task = startTask('Передача предметов', { total: 2, cancelable: true })
      .onCancel(() => cancelled++)
      .onStop(() => stopped++);

    task.cancel();
    expect(cancelled).toBe(1);
    expect(stopped).toBe(0);

    const second = startTask('Магазин', { total: 2, cancelable: true })
      .onCancel(() => cancelled++)
      .onStop(() => stopped++);
    second.stop();
    expect(stopped).toBe(1);
    expect(second.cancelled).toBe(true);
    // Повторное нажатие ничего не делает
    second.stop();
    expect(stopped).toBe(1);
  });
});

describe('док задач в шапке', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); document.body.innerHTML = '<div class="topbar-right"></div>'; });

  it('плашка живёт в топбаре, показывает название скрипта и проценты', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const task = startTask('Проверка входа', { total: 4, cancelable: true });
    task.progress(1, 4, 'Аа');
    const dock = document.getElementById('tf-task-dock');
    expect(dock.parentElement.classList.contains('topbar-right')).toBe(true);
    expect(dock.querySelector('.msk-clock-label').textContent).toBe('Проверка входа');
    expect(dock.querySelector('.msk-clock-zone').textContent).toBe('25%');
    expect(dock.querySelector('.tf-dock-bar > span').getAttribute('style')).toContain('width:25%');
    // Пауза и стоп — у выполняемого скрипта
    expect(dock.querySelector('[data-dock-pause]')).not.toBeNull();
    expect(dock.querySelector('[data-dock-stop]')).not.toBeNull();
  });

  it('кнопка обновления в топбаре ближе к центру, чем логи', async () => {
    document.body.innerHTML = '<div class="topbar-right"><button id="update-badge"></button></div>';
    const { startTask } = await import('../js/core/taskLog.js');
    startTask('Проверка входа', { total: 2 });
    const dock = document.getElementById('tf-task-dock');
    expect(dock.previousElementSibling?.id).toBe('update-badge');
  });

  it('плашка видна и когда задач нет, и кнопки паузы/стопа в ней не мельчат', async () => {
    const { renderDock } = await import('../js/core/taskLog.js');
    renderDock();
    const dock = document.getElementById('tf-task-dock');
    expect(dock.classList.contains('is-idle')).toBe(true);
    expect(dock.querySelector('.msk-clock-label').textContent).toBe('Скрипты не выполняются');
    expect(dock.querySelector('.msk-clock-zone').textContent).toBe('простой');
    expect(dock.querySelector('[data-dock-pause]')).toBeNull();
  });

  it('кнопка паузы в доке переключает задачу', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const task = startTask('Балансы', { total: 2, cancelable: true });
    const dock = document.getElementById('tf-task-dock');
    dock.querySelector('[data-dock-pause]').click();
    expect(task.paused).toBe(true);
    expect(dock.querySelector('[data-dock-pause]').textContent.trim()).toBe('▶');
    dock.querySelector('[data-dock-stop]').click();
    expect(task.cancelled).toBe(true);
  });

  it('«Открыть лог» не открывает новое окно: логи копятся в очереди', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const first = startTask('Проверка входа', { total: 2 });
    first.log('строка журнала');
    first.finish('Готово');
    const second = startTask('Балансы', { total: 2 });
    second.log('строка второго');
    const dock = document.getElementById('tf-task-dock');
    const bar = () => dock.querySelector('.tf-dock-slot-bar');

    // Без заявки в очереди кнопка показывает то, что под рукой: выполняющийся скрипт
    bar().querySelector('[data-dock-open-log]').click();
    expect(dock.querySelector('.tf-dock-slot-log').textContent).toContain('строка второго');

    // Пока один лог открыт, заявка на другой не переключает его, а встаёт в очередь
    dock.querySelector(`[data-task-log="${first.id}"]`).click();
    expect(dock.querySelector('.tf-dock-slot-log').textContent).toContain('строка второго');
    expect(bar().querySelector('.tf-dock-queue')).not.toBeNull();

    dock.querySelector('[data-dock-log-close]').click();
    expect(dock.querySelector('.tf-dock-slot-log').textContent).toBe('');
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

describe('отзыв ошибок после успеха', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); document.body.innerHTML = ''; });

  it('ошибки и предупреждения персонажа исчезают, если тот же scope отработал успешно', async () => {
    const { startTask, logScope } = await import('../js/core/taskLog.js');
    const task = startTask('Проверка входа');
    task.watch('char:a', 'char:b');
    logScope('char:a', 'Аа: таймаут страницы', 'error');
    logScope('char:a', 'Аа: не дождался ответа', 'warn');
    logScope('char:b', 'Вв: таймаут страницы', 'error');
    expect(task.errors).toBe(2); expect(task.warnings).toBe(1);

    // Повтор прошёл: ошибки Аа больше не актуальны, ошибки Вв — ещё да
    task.resolveProblems('char:a');

    const text = task.entries.map(e => e.message).join('\n');
    expect(text).not.toContain('Аа: таймаут страницы');
    expect(text).not.toContain('не дождался ответа');
    expect(text).toContain('Вв: таймаут страницы');
    expect(task.errors).toBe(1); expect(task.warnings).toBe(0);
    // В логе остаётся след, что строки сняли, — иначе непонятно, куда делись строки
    expect(text).toContain('ошибки сняты');
  });

  it('задача без ошибок после отзыва остаётся зелёной, а не жёлтой', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const task = startTask('Проверка входа');
    task.log('Аа: ошибка разбора', 'error', 'char:a');
    task.log('ошибки', 'error');
    expect(task.status).toBe('running');

    task.resolveProblems('char:a');
    // Общая строка «ошибки» осталась — значит и статус остаётся прежним
    expect(task.errors).toBe(1);

    const clean = startTask('Проверка балансов');
    clean.log('Аа: таймаут', 'error', 'char:a');
    clean.resolveProblems('char:a');
    clean.finish('Готово');
    expect(clean.status).toBe('done');
    expect(clean.summary).toBe('Готово');
  });

  it('повтор по areas не трогает чужие строки и ничего не пишет, если ошибок не было', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const task = startTask('Проверка входа');
    task.log('Вв: таймаут', 'error', 'char:b');
    const before = task.entries.length;
    task.resolveProblems('char:a');   // у Аа ошибок не было
    expect(task.entries).toHaveLength(before);
    expect(task.errors).toBe(1);
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
