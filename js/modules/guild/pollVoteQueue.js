// js/modules/guild/pollVoteQueue.js
// Очередь голосов в опросы: локальный выбор показывается сразу, отправка на сайт
// — отложенный фоновый шаг, как у ответов на события (responseQueue.js).
//
// Отдельная очередь от ответов на события: голос валидации и подтверждение
// проверяются по опросу в сводке (polls), а не по событию.

export const POLL_VOTE_IDLE_MS = 7000;

/**
 * Нормализация очереди голосов: только корректные номера опроса и вариантов,
 * уникальные, не более 200 вариантов на голос. Неподтверждённые остаются.
 */
export function normalizePendingPollVotes(rows) {
  const unique = new Map();
  for (const row of Array.isArray(rows) ? rows.slice(-200) : []) {
    const pollId = String(row?.pollId || '');
    const optionIds = (Array.isArray(row?.optionIds) ? row.optionIds : []).map(String);
    if (
      /^\d{1,12}$/.test(pollId) &&
      optionIds.length &&
      optionIds.length <= 200 &&
      new Set(optionIds).size === optionIds.length &&
      optionIds.every(id => /^\d{1,12}$/.test(id))
    ) {
      unique.set(pollId, { pollId, optionIds, failed: row?.failed === true });
    }
  }
  return [...unique.values()];
}

/**
 * Очередь голосов в опросы клана. Поведение копирует очередь ответов:
 * - enqueue сразу сохраняет намерение и перерисовывает экран (оптимистичный выбор);
 * - после паузы (POLL_VOTE_IDLE_MS) фоново отправляет голос и перепроверяет его
//  по свежей сводке; неподтверждённый голос остаётся для повтора.
 */
export function createPollVoteQueue({
  getEntries,
  saveEntries,
  send,
  read,
  begin,
  changed = () => {},
  enabled = () => true
}) {
  let timer,
    running = false,
    lastAction = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const schedule = () => {
    clearTimeout(timer);
    if (!running && enabled() && getEntries().some(row => !row.failed))
      timer = setTimeout(() => void flush(), Math.max(0, lastAction + POLL_VOTE_IDLE_MS - Date.now()));
  };
  const touch = () => {
    lastAction = Date.now();
    schedule();
  };
  const save = async rows => {
    const stored = saveEntries(rows);
    changed();
    await stored;
  };
  async function enqueue(pollId, optionIds) {
    const id = String(pollId || '');
    const options = (Array.isArray(optionIds) ? optionIds : []).map(String);
    if (!enabled() || !/^\d{1,12}$/.test(id) || !options.length || options.length > 200 ||
        new Set(options).size !== options.length || options.some(id => !/^\d{1,12}$/.test(id))) {
      return false;
    }
    lastAction = Date.now();
    const choice = { pollId: id, optionIds: options, failed: false };
    try {
      await save([...getEntries().filter(row => row.pollId !== id), choice]);
    } catch (error) {
      // Не давать старому таймеру отправить голос, если локальное сохранение не удалось.
      choice.failed = true;
      changed();
      schedule();
      throw error;
    }
    schedule();
    return true;
  }
  async function flush() {
    clearTimeout(timer);
    if (running || !enabled() || !getEntries().some(row => !row.failed)) return;
    running = true;
    let task,
      snapshot = [];
    try {
      task = await begin();
      await task.waitTurn();
      // Пока пользователь ещё выбирает, ждём последних голосов.
      while (Date.now() < lastAction + POLL_VOTE_IDLE_MS) {
        task.progress(0, getEntries().length, 'Ожидание последних голосов');
        await pause(lastAction + POLL_VOTE_IDLE_MS - Date.now());
      }
      if (!enabled()) return;
      snapshot = getEntries().filter(row => !row.failed);
      for (const [index, row] of snapshot.entries()) {
        if (!enabled()) break;
        // readPendingPollVotes нормализует и возвращает новые объекты каждый раз,
        // поэтому сравниваем не по ссылке, а по pollId.
        if (!getEntries().some(r => r.pollId === row.pollId)) continue;
        task.progress(index, snapshot.length, 'Переносятся голоса в опросы');
        try {
          const reply = await send(row.pollId, row.optionIds);
          if (!reply?.ok) task.log(`Опрос ${row.pollId}: проверяем результат по сводке сайта`, 'warn');
        } catch {
          // Неполученное подтверждение не доказывает отказ: проверяем сайт.
          task.log(`Опрос ${row.pollId}: голос не получен, проверяем сайт`, 'warn');
        }
      }
      if (!enabled()) return;
      let report;
      for (let attempt = 0; attempt < 2; attempt++) {
        await pause(3000);
        if (!enabled()) return;
        try {
          report = await read();
        } catch {
          // Сохраняем последнее успешное наблюдение, если перечитывание не удалось.
        }
        if (snapshot.every(row => confirmed(row, report))) break;
      }
      if (!enabled()) return;
      const missing = snapshot.filter(row => getEntries().some(r => r.pollId === row.pollId) && !confirmed(row, report)).length;
      await save(
        getEntries().flatMap(row =>
          !snapshot.some(s => s.pollId === row.pollId) ? [row] : confirmed(row, report) ? [] : [{ ...row, failed: true }]
        )
      );
      task.finish(
        missing
          ? `Не подтверждено голосов: ${missing}. Нажмите вариант для повтора.`
          : getEntries().some(row => !row.failed)
            ? 'Пакет обработан. Новые голоса ожидают отправки.'
            : 'Голоса подтверждены сайтом',
        missing ? 'warn' : 'done'
      );
    } catch {
      // Сохраняем намерения даже при ошибке сохранения, журнала или перечитывания.
      task?.finish('Не удалось подтвердить отправку. Голоса сохранены для повторной попытки.', 'warn');
      const rows = getEntries();
      try {
        await save(rows.map(row => (snapshot.some(s => s.pollId === row.pollId) || !snapshot.length ? { ...row, failed: true } : row)));
      } catch {
        /* остаются в памяти */
      }
    } finally {
      if (task?.status === 'running') task.finish('Отправка приостановлена. Голоса сохранены локально.', 'warn');
      running = false;
      changed();
      schedule();
    }
  }
  /** Голос подтверждён, если в свежей сводке опрос существует и выбраны те же варианты. */
  function confirmed(row, report) {
    return report?.polls?.some(
      poll =>
        poll.id === row.pollId &&
        row.optionIds.every(id => poll.options?.some(option => option.id === id && option.selected))
    );
  }
  async function reconcile(report) {
    if (running) return;
    const entries = getEntries();
    const kept = entries.filter(row => !confirmed(row, report));
    if (kept.length !== entries.length) await save(kept);
  }
  return { enqueue, touch, resume: touch, flush, reconcile };
}
