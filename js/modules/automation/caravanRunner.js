// js/modules/automation/caravanRunner.js
// Запуск «Сундука караванщика» (команда open_caravan_chests) для набора персонажей.
// - персонажи идут параллельно, как при проверке входа: общий лимит окон (browserSlots) из «Настройки → Скрипты»;
// - временные сбои (таймаут, «Проверка безопасности») повторяются столько раз, сколько указано в настройках,
//   но только пока ни один сундук не нажат: после нажатия повтор вслепую не делается (команда сама перечитывает инвентарь,
//   так что ручной «Повторить» безопасен);
// - «Стоп» (signal.cancelled) не даёт начаться новым персонажам; начатый заканчивается и учитывается;
// - если у персонажа нет входа или сайт показал «Проверку безопасности», остальные персонажи этого аккаунта не блокируются:
//   у каждого своё окно и своя сессия.
// Без интерфейса: всё внешнее передаётся параметрами (так проще тестировать).

import { runQueue, sleep, browserSlots } from '../sync/queue.js';
import { rowFromPayload, plainRow, canAutoRetry, statusInfo, rowLabel } from './caravanCore.js';

/** Разброс старта новых персонажей, мс: окна открываются не одновременно. */
export const START_STAGGER_MS = [400, 1400];
const range = (r, random) => r[0] + random() * (r[1] - r[0]);

/**
 * @param {{
 *   chars: Array<{ id: string, nick: string }>,
 *   dryRun?: boolean,                                        // только посчитать сундуки: ничего не нажимается
 *   signal?: { cancelled: boolean },
 *   invokeFn: (cmd: string, args: object) => Promise<any>,
 *   limiter?: object, retries?: number, retryDelayMs?: number,
 *   task?: { setStep?: Function, progress?: Function, log?: Function },
 *   onRow?: (row: object, done: number, total: number) => void,
 *   onStart?: (char: object) => void,
 *   sleepFn?: (ms: number) => Promise<void>, random?: () => number
 * }} opts
 * @returns {Promise<object[]>} строки результата в порядке `chars`
 */
export async function runCaravanBatch({
  chars, dryRun = false, signal = { cancelled: false }, invokeFn, limiter = browserSlots,
  retries = 0, retryDelayMs = 2000, task, onRow, onStart, sleepFn = sleep, random = Math.random
}) {
  const total = chars.length;
  const rows = new Map();
  let started = 0;
  let done = 0;

  const emit = (char, row) => {
    if (rows.has(char.id)) return;
    rows.set(char.id, row);
    done++;
    task?.progress?.(done, total, char.nick);
    onRow?.(row, done, total);
  };

  const attempt = async (char) => {
    for (let a = 0; ; a++) {
      task?.setStep?.(`${char.nick}: ${dryRun ? 'считаю сундуки' : 'открываю сундуки'}${a ? ` (повтор ${a}/${retries})` : ''}`);
      let payload, error;
      try {
        payload = await invokeFn('open_caravan_chests', { charId: char.id, dryRun, timeoutSeconds: Math.min(25 + 15 * a, 60) });
      } catch (e) { error = e; }
      const row = rowFromPayload(char, payload, error);
      if (a >= retries || signal.cancelled || !canAutoRetry(row)) return row;
      task?.log?.(`${char.nick}: повтор ${a + 1}/${retries} (${row.status === 'challenge' ? 'проверка безопасности' : row.error})`, 'info');
      await sleepFn(retryDelayMs * (a + 1));
    }
  };

  const entries = await runQueue(chars, async (char) => {
    if (signal.cancelled) return null;
    if (started++ > 0) await sleepFn(range(START_STAGGER_MS, random));
    if (signal.cancelled) return null;
    onStart?.(char);
    const row = await attempt(char);
    emit(char, row);
    return row;
  }, {
    limiter, retries: 0, signal,
    onDone: (entry) => { if (entry.error) task?.log?.(`${entry.item.nick}: ${entry.error?.message || entry.error}`, 'error'); }
  });
  // «Стоп» нажат до старта персонажа (или его worker упал): строка остановленного
  entries.forEach(e => emit(e.item, e.error
    ? rowFromPayload(e.item, null, e.error)
    : plainRow(e.item, 'cancelled')));

  chars.forEach(c => {
    const row = rows.get(c.id);
    if (row && row.status !== 'cancelled') task?.log?.(`${c.nick}: ${statusInfo(row.status).icon} ${rowLabel(row)}`, statusInfo(row.status).level === 'error' ? 'error' : 'info');
  });
  return chars.map(c => rows.get(c.id));
}
