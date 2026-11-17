// Latest local intentions are separate from the last verified website report.
// Failed/ambiguous writes stay visible and durable; only an explicit new click retries them.
export const RESPONSE_IDLE_MS = 7000;

export function normalizePendingResponses(rows) {
  const unique = new Map();
  for (const row of Array.isArray(rows) ? rows.slice(-200) : []) {
    const eventId = String(row?.eventId || '');
    if (/^\d{1,12}$/.test(eventId) && ['yes', 'no'].includes(row?.response))
      unique.set(eventId, { eventId, response: row.response, failed: row.failed === true });
  }
  return [...unique.values()];
}

export function createResponseQueue({
  getEntries,
  saveEntries,
  send,
  read,
  begin,
  changed = () => {},
  enabled = () => true,
  onLogin = () => {}
}) {
  let timer,
    running = false,
    lastAction = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const schedule = () => {
    clearTimeout(timer);
    if (!running && enabled() && getEntries().some(row => !row.failed))
      timer = setTimeout(() => void flush(), Math.max(0, lastAction + RESPONSE_IDLE_MS - Date.now()));
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
  async function enqueue(eventId, response) {
    if (!enabled() || !/^\d{1,12}$/.test(String(eventId)) || !['yes', 'no'].includes(response)) return false;
    lastAction = Date.now();
    const choice = { eventId: String(eventId), response, failed: false };
    try {
      await save([...getEntries().filter(row => row.eventId !== String(eventId)), choice]);
    } catch (error) {
      // Do not let an older debounce timer send a choice whose local save failed.
      // No second disk write here: its outcome may be uncertain.
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
      // Other scripts may have held the dock while the user was still choosing events.
      while (Date.now() < lastAction + RESPONSE_IDLE_MS) {
        task.progress(0, getEntries().length, 'Ожидание последних ответов');
        await pause(lastAction + RESPONSE_IDLE_MS - Date.now());
      }
      if (!enabled()) return;
      snapshot = getEntries().filter(row => !row.failed);
      for (const [index, row] of snapshot.entries()) {
        if (!enabled()) break;
        if (!getEntries().includes(row)) continue;
        task.progress(index, snapshot.length, 'Переносятся ответы в кланер');
        // `busy` — в окне клана уже идёт синхронизация (guild_sync держит флаг). POST
        // ещё не ушёл, поэтому повторяем через короткую паузу, а не списываем в loss.
        let reply;
        let sendError = '';
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            reply = await send(row.eventId, row.response);
            sendError = '';
            break;
          } catch (error) {
            sendError = String(error?.message || error || '');
            if (sendError !== 'busy' || attempt === 2 || !enabled()) break;
            await pause(1200);
          }
        }
        if (sendError) {
          // A lost acknowledgement does not prove the write failed. Reconcile before reporting it.
          task.log(`Событие ${row.eventId}: ответ не получен, проверяем сайт`, 'warn');
        } else if (!reply?.ok) {
          task.log(`Событие ${row.eventId}: проверяем результат по сводке сайта`, 'warn');
        }
      }
      if (!enabled()) return;
      let report;
      let verifyError = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        await pause(3000);
        if (!enabled()) return;
        try {
          report = await read();
          verifyError = '';
        } catch (error) {
          // Keep the last successful observation if a later verification read fails;
          // remember the reason so a dead session is reported actionably.
          verifyError = String(error?.message || error || '');
          if (verifyError === 'login') onLogin();
        }
        if (
          snapshot.every(row =>
            report?.events?.some(event => event.id === row.eventId && event.response === row.response)
          )
        )
          break;
      }
      if (!enabled()) return;
      const confirmed = row =>
        report?.events?.some(event => event.id === row.eventId && event.response === row.response);
      const missing = snapshot.filter(row => getEntries().includes(row) && !confirmed(row)).length;
      await save(
        getEntries().flatMap(row =>
          !snapshot.includes(row) ? [row] : confirmed(row) ? [] : [{ ...row, failed: true }]
        )
      );
      const sessionMessage =
        'Сессия окна клана в приложении не активна. Откройте сайт клана через приложение и войдите на нём, затем нажмите выбранный ответ.';
      task.finish(
        verifyError === 'login'
          ? sessionMessage
          : missing
            ? `Не подтверждено ответов: ${missing}. Нажмите выбранный ответ для повтора.`
            : getEntries().some(row => !row.failed)
              ? 'Пакет обработан. Новые ответы ожидают переноса.'
              : 'Ответы подтверждены сайтом',
        verifyError === 'login' || missing ? 'warn' : 'done'
      );
    } catch {
      // Preserve intentions even when storage, a script-log dependency or verification fails.
      task?.finish('Не удалось подтвердить перенос. Ответы сохранены для повторной попытки.', 'warn');
      const rows = getEntries();
      try {
        await save(rows.map(row => (snapshot.includes(row) || !snapshot.length ? { ...row, failed: true } : row)));
      } catch {
        /* retained in memory */
      }
    } finally {
      if (task?.status === 'running') task.finish('Перенос приостановлен. Ответы сохранены локально.', 'warn');
      running = false;
      changed();
      schedule();
    }
  }
  async function reconcile(report) {
    if (running) return;
    const entries = getEntries();
    const kept = entries.filter(
      row => !report?.events?.some(event => event.id === row.eventId && event.response === row.response)
    );
    if (kept.length !== entries.length) await save(kept);
  }
  return { enqueue, touch, resume: touch, flush, reconcile };
}
