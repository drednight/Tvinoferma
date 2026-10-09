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

  it('по умолчанию док свёрнут: в шапке только плашка, список — по кнопке', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const first = startTask('Обновление балансов', { total: 2, cancelable: true });
    startTask('Проверка авторизации', { total: 2, cancelable: true });   // в очереди
    const dock = document.getElementById('tf-task-dock');
    // Плашка текущего скрипта видна всегда — свёрнут именно выпадающий список
    expect(dock.classList.contains('is-open')).toBe(false);
    expect(dock.querySelector('.msk-clock-label').textContent).toBe('Обновление балансов');
    const toggle = dock.querySelector('[data-dock-fold]');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.title).toBe('Развернуть');

    toggle.click();
    expect(dock.classList.contains('is-open')).toBe(true);
    expect(dock.querySelector('.tf-dock-row').textContent).toContain('Обновление балансов');
    expect(dock.querySelector('[data-dock-fold]').title).toBe('Свернуть');

    dock.querySelector('[data-dock-fold]').click();
    expect(dock.classList.contains('is-open')).toBe(false);
    first.finish('Готово');
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

  it('«📄» открывает журнал всех логов в окне, а не разворачивает панель под доком', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const first = startTask('Проверка входа', { total: 2 });
    first.log('строка журнала');
    first.finish('Готово');
    const second = startTask('Балансы', { total: 2 });
    second.log('строка второго');
    const dock = document.getElementById('tf-task-dock');

    // Панели лога под доком больше нет: она наезжала на страницу и обрезалась по высоте
    expect(dock.querySelector('.tf-dock-slot-log')).toBeNull();

    dock.querySelector('[data-dock-open-log]').click();
    const dialog = document.querySelector('.tf-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('.tf-dialog-title').textContent).toBe('📚 Логи скриптов');
    // В окне — сразу все записи журнала, а не лог одной задачи
    const rows = dialog.querySelectorAll('[data-lh-key]');
    expect([...rows].map(r => r.textContent).join(' ')).toContain('Проверка входа');
    expect([...rows].map(r => r.textContent).join(' ')).toContain('Балансы');

    dialog.querySelector('.tf-close').click();
    expect(document.querySelector('.tf-dialog')).toBeNull();
  });

  it('клик по строке списка открывает лог этой задачи', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const first = startTask('Проверка входа', { total: 2 });
    first.log('строка журнала');
    first.finish('Готово');
    const dock = document.getElementById('tf-task-dock');
    dock.querySelector(`[data-dock-log-row="${first.id}"]`).click();
    const dialog = document.querySelector('.tf-dialog');
    expect(dialog.querySelector('.tf-dialog-title').textContent).toContain('Проверка входа');
    expect(dialog.textContent).toContain('строка журнала');
    dialog.querySelector('.tf-close').click();
  });
});

describe('точечное обновление плашек задач', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); document.body.innerHTML = ''; });
  it('новая строка не пересоздаёт чужие плашки, завершение добавляет кнопку скрытия', async () => {
    // Проверяем на карточке задачи, встроенной в страницу: в списке шапки карточек больше нет,
    // там тихие строки без кнопок (см. док «список задач под плашкой»).
    const { startTask, taskCardHtml } = await import('../js/core/taskLog.js');
    const first = startTask('Первая задача'), second = startTask('Вторая задача');
    document.body.innerHTML = `<div id="holder">${taskCardHtml(first)}${taskCardHtml(second)}</div>`;
    const other = document.querySelector(`[data-task-card="${second.id}"]`);
    first.log('Новый шаг');
    expect(document.querySelector(`[data-task-card="${second.id}"]`)).toBe(other);
    first.finish('Готово');
    expect(document.querySelector(`[data-task-close="${first.id}"]`)).not.toBeNull();
  });

  it('список под плашкой — строки без кнопок: имя скрипта, его дело и ход работы', async () => {
    const { startTask, renderDock } = await import('../js/core/taskLog.js');
    const task = startTask('Проверка входа', { total: 4, cancelable: true });
    task.progress(2, 4, 'Аа');
    renderDock();
    const dock = document.getElementById('tf-task-dock');
    const row = dock.querySelector('.tf-dock-row');
    expect(row.textContent).toContain('Проверка входа');
    expect(row.textContent).toContain('Аа');           // чем скрипт занят
    expect(row.textContent).toContain('50%');
    expect(row.textContent).toContain('2/4');
    // Кнопок в строке нет: управление скриптом живёт на плашке в шапке
    expect(row.querySelector('button')).toBeNull();
    expect(row.querySelector('[data-task-cancel]')).toBeNull();
  });

  it('второй скрипт встаёт в очередь: сверху идущий, ниже «в очереди»', async () => {
    const { startTask, renderDock } = await import('../js/core/taskLog.js');
    const first = startTask('Обновление балансов', { total: 4, cancelable: true });
    first.progress(1, 4, 'ДМ 29');
    const second = startTask('Проверка авторизации', { total: 2, cancelable: true });
    renderDock();
    const dock = document.getElementById('tf-task-dock');
    const rows = [...dock.querySelectorAll('.tf-dock-row')];

    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Обновление балансов');   // идущий — сверху
    expect(rows[0].textContent).toContain('1/4');
    expect(rows[1].textContent).toContain('Проверка авторизации'); // ждущий — под ним
    expect(rows[1].textContent).toContain('в очереди');
    // Плашка и кнопки пауза/стоп относятся только к идущему скрипту
    expect(dock.querySelector('.msk-clock-label').textContent).toBe('Обновление балансов');
    expect(dock.querySelector(`[data-dock-pause="${first.id}"]`)).not.toBeNull();
    expect(dock.querySelector(`[data-dock-stop="${second.id}"]`)).toBeNull();

    // Ждущий не начинает работу, пока первый не закончит
    let started = false;
    const turn = second.waitTurn().then(() => { started = true; });
    await Promise.resolve();
    expect(started).toBe(false);

    first.finish('Готово');
    await turn;
    expect(started).toBe(true);
    renderDock();
    const after = [...document.getElementById('tf-task-dock').querySelectorAll('.tf-dock-row')];
    expect(after[0].textContent).toContain('Проверка авторизации');
    expect(after[0].textContent).not.toContain('в очереди');
  });

  it('очередь идёт по порядку запуска, а не по последнему нажатию', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const first = startTask('Первый', { total: 1, cancelable: true });
    const second = startTask('Второй', { total: 1, cancelable: true });
    const third = startTask('Третий', { total: 1, cancelable: true });
    const order = [];
    second.waitTurn().then(() => order.push('второй'));
    third.waitTurn().then(() => order.push('третий'));
    first.finish('Готово');
    second.finish('Готово');
    third.finish('Готово');
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['второй', 'третий']);
  });

  it('скрипт, отменённый в очереди, не запускается и не блокирует следующих', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const first = startTask('Идущий', { total: 1, cancelable: true });
    const dropped = startTask('Отменённый', { total: 1, cancelable: true });
    const next = startTask('Следующий', { total: 1, cancelable: true });
    dropped.cancel();                          // пользователь снял ожидание
    expect(dropped.waiting).toBe(false);
    let ran = false;
    next.waitTurn().then(() => { ran = true; });
    first.finish('Готово');
    await Promise.resolve(); await Promise.resolve();
    expect(ran).toBe(true);
  });

  it('задачи вне дока очередь не занимают: мастер марафона работает сразу', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    startTask('Док-скрипт', { total: 1, cancelable: true });
    const plain = startTask('Мастер марафона', { dock: false, total: 1 });
    expect(plain.waiting).toBe(false);
    let started = false;
    plain.waitTurn().then(() => { started = true; });
    await Promise.resolve();
    expect(started).toBe(true);
  });

  it('пауза видна в списке словами, а не только сменой кнопки', async () => {
    const { startTask, renderDock } = await import('../js/core/taskLog.js');
    const task = startTask('Балансы', { total: 2, cancelable: true });
    task.progress(1, 2, 'Бб');
    renderDock();
    const dock = document.getElementById('tf-task-dock');
    expect(dock.querySelector('.tf-dock-row').textContent).toContain('Бб');
    task.togglePause();
    renderDock();
    expect(dock.querySelector('.tf-dock-row').textContent).toContain('на паузе');
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
