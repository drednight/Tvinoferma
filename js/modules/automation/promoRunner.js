// js/modules/automation/promoRunner.js
// Запуск активации промокодов (Issue #25) для набора персонажей и набора кодов.
// - персонажи идут параллельно, как при проверке входа: общий лимит окон (browserSlots) из «Настройки → Скрипты»;
// - у одного персонажа коды идут по очереди (каждый — отдельная страница /pin/<код>), с короткой паузой;
// - временные сбои (таймаут, «Проверка безопасности») повторяются столько раз, сколько указано в настройках,
//   но только пока кнопка не нажата: после нажатия повтор мог бы активировать код дважды;
// - «Стоп» (signal.cancelled) не даёт начаться новым вводам; уже начатый заканчивается и учитывается;
// - если сайт отклонил код у нескольких персонажей подряд и ни разу не принял, остальным он не вводится.
// Без интерфейса: всё внешнее передаётся параметрами (так проще тестировать).

import { runQueue, sleep, browserSlots } from '../sync/queue.js';
import { rowFromPayload, plainRow, canAutoRetry, isTransient, isOk, isInvalid, codeKey } from './promoCore.js';

/** Пауза между кодами одного персонажа, мс: от и до (случайная). */
export const CODE_PAUSE_MS = [1000, 2000];
/** Разброс старта новых персонажей, мс: окна открываются не одновременно. */
export const START_STAGGER_MS = [400, 1400];
/** Сколько отказов по коду подряд (без единого принятия) считаем «код неверный» и прекращаем его вводить. */
export const REJECT_LIMIT = 3;

const range = (r, random) => r[0] + random() * (r[1] - r[0]);

/**
 * @param {{
 *   codes: string[],
 *   chars: Array<{ id: string, nick: string }>,
 *   skip?: (code: string, char: object) => (object|null),   // уже введено/решено: готовая часть строки, окно не открывается
 *   signal?: { cancelled: boolean },
 *   invokeFn: (cmd: string, args: object) => Promise<any>,
 *   limiter?: object, retries?: number, retryDelayMs?: number,
 *   task?: { setStep?: Function, progress?: Function, log?: Function },
 *   onRow?: (row: object, done: number, total: number) => void,
 *   sleepFn?: (ms: number) => Promise<void>, random?: () => number
 * }} opts
 * @returns {Promise<object[]>} строки результата: персонажи по порядку, у каждого коды по порядку
 */
export async function runPromoBatch({
  codes, chars, skip, signal = { cancelled: false }, invokeFn, limiter = browserSlots,
  retries = 0, retryDelayMs = 2000, task, onRow, sleepFn = sleep, random = Math.random
}) {
  const total = codes.length * chars.length;
  const rows = new Map();                       // "charId|код" → строка
  const rejected = new Map();                   // код → сколько раз сайт его отклонил
  const accepted = new Set();                   // коды, которые сайт хотя бы раз принял
  const dead = new Set();                       // коды, которые больше не вводим
  let started = 0;
  let done = 0;

  const key = (char, code) => `${char.id}|${codeKey(code)}`;
  const emit = (char, code, row) => {
    if (rows.has(key(char, code))) return;
    rows.set(key(char, code), row);
    done++;
    task?.progress?.(done, total, char.nick);
    onRow?.(row, done, total);
  };

  const attempt = async (char, code) => {
    for (let a = 0; ; a++) {
      task?.setStep?.(`${char.nick}: ввожу промокод${a ? ` (повтор ${a}/${retries})` : ''}`);
      let payload, error;
      try {
        payload = await invokeFn('activate_promo', { charId: char.id, code, dryRun: false, timeoutSeconds: Math.min(25 + 15 * a, 60) });
      } catch (e) { error = e; }
      const row = rowFromPayload(char, code, payload, error);
      if (a >= retries || signal.cancelled || !canAutoRetry(row, isTransient)) return row;
      task?.log?.(`${char.nick}: повтор ${a + 1}/${retries} (${row.status === 'challenge' ? 'проверка безопасности' : row.error})`, 'info');
      await sleepFn(retryDelayMs * (a + 1));
    }
  };

  const worker = async (char) => {
    const skips = codes.map(code => skip?.(code, char) || null);
    let blocked = null;      // причина, по которой остальные коды этого персонажа не вводим
    let invoked = 0;
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (skips[i]) { emit(char, code, plainRow(char, code, skips[i].status || 'already_used', skips[i].detail ?? null, { skipped: true })); continue; }
      if (signal.cancelled) { emit(char, code, plainRow(char, code, 'cancelled')); continue; }
      if (blocked) { emit(char, code, plainRow(char, code, 'not_run', blocked)); continue; }
      if (dead.has(codeKey(code))) { emit(char, code, plainRow(char, code, 'not_run', 'Сайт не принял этот код у других персонажей — не вводился')); continue; }
      if (invoked === 0 && started++ > 0) await sleepFn(range(START_STAGGER_MS, random));
      else if (invoked > 0) await sleepFn(range(CODE_PAUSE_MS, random));
      invoked++;
      if (signal.cancelled) { emit(char, code, plainRow(char, code, 'cancelled')); continue; }

      const row = await attempt(char, code);
      emit(char, code, row);

      const k = codeKey(code);
      if (isOk(row.status)) accepted.add(k);
      else if (isInvalid(row.status)) {
        rejected.set(k, (rejected.get(k) || 0) + 1);
        if (rejected.get(k) >= REJECT_LIMIT && !accepted.has(k)) dead.add(k);
      } else if (row.status === 'not_logged_in' || row.status === 'challenge' || row.error === 'window_open') {
        blocked = row.status === 'not_logged_in' ? 'У персонажа нет входа' : row.status === 'challenge' ? 'Сайт показал проверку безопасности' : 'Открыто окно персонажа';
      }
    }
  };

  const entries = await runQueue(chars, worker, {
    limiter, retries: 0, signal,
    onDone: (entry) => { if (entry.error) task?.log?.(`${entry.item.nick}: ${entry.error?.message || entry.error}`, 'error'); }
  });
  // Если «Стоп» нажат до старта персонажа, его worker не запускался: помечаем строки остановленными
  entries.forEach(e => codes.forEach(code => emit(e.item, code, plainRow(e.item, code, 'cancelled'))));

  return chars.flatMap(char => codes.map(code => rows.get(key(char, code))).filter(Boolean));
}
