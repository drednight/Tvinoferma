// @ts-check
// Экспериментальная координация двух вкладок ОДНОГО browser origin.
// Не подключена к приложению, записи state, vault или сети. Блокировка работает
// только если ВСЕ участники добровольно используют это имя и один storage partition.
// Она не заменяет native-межпроцессный lock, backup, независимый якорь или fsync.

import { object } from './exportSchema.js';

// Один ресурс на всё состояние, а не на dataset: разные наборы могут менять один state.
// Имя не содержит данных пользователя и не должно меняться между участниками протокола.
export const BROWSER_SYNC_LOCK_NAME = 'tvinoferma:cloud-sync:local-state:v1';
const BUSY = Object.freeze({ status: 'busy' });
const UNAVAILABLE = Object.freeze({ status: 'unavailable' });
const COMPLETED = Object.freeze({ status: 'completed_for_test', action: 'manual_review' });
const UNCERTAIN = Object.freeze({ status: 'uncertain', action: 'manual_review' });
const BLOCKED = Object.freeze({ status: 'blocked_after_uncertain', action: 'manual_review' });
const MARKER = Object.freeze({});

// После неизвестного исхода никакой следующий callback этого экземпляра модуля
// не запускается. Перезагрузка или другая вкладка эту память теряют: для настоящей
// функции нужна отдельная устойчивая карантинная отметка и восстановление.
let halted = false;

/**
 * Неблокирующая попытка занять Web Lock. Callback должен сам перечитать данные ПОСЛЕ
 * получения блокировки и дождаться всех своих действий. Значение callback не возвращаем:
 * оно может содержать секреты. Исключение после входа — неизвестный исход, не повод
 * повторить запись. Любой результат, включая completed_for_test, требует отдельной
 * проверки и не подтверждает сохранение или право на импорт.
 *
 * Не используем `steal`, таймауты, локальный spin-lock или fallback при отсутствии API.
 * Чужой код того же origin, который не участвует в протоколе или вызывает `steal`,
 * не блокируется этим примитивом. После `steal` callback прежнего владельца может
 * продолжить выполняться, даже если promise блокировки уже отклонён. Отменить его
 * автоматически нельзя. Это не защита от вредоносного или несогласованного кода.
 *
 * @param {{lockManager: any, operation: () => any}} options
 * @returns {Promise<Readonly<{status: string, action?: string}>>}
 */
export async function tryBrowserSyncOperation(options) {
  const input = object(options, ['lockManager', 'operation']);
  if (typeof input.operation !== 'function') throw new Error('Некорректная локальная операция');
  if (halted) return BLOCKED;
  let request;
  try {
    request = input.lockManager?.request;
  } catch {
    return UNAVAILABLE;
  }
  if (typeof request !== 'function') return UNAVAILABLE;

  let called = false;
  let entered = false;
  let settled = false;
  let active = true;
  /** @type {Readonly<{status: string, action?: string}>} */
  let outcome = UNAVAILABLE;
  try {
    const result = await request.call(
      input.lockManager,
      BROWSER_SYNC_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      async lock => {
        // Реальный Web Locks вызывает callback ровно один раз. Повторный вызов
        // не должен запускать потенциально изменяющую данные операцию повторно.
        if (!active || called) {
          if (entered) halted = true;
          throw new Error('Некорректный ответ блокировки');
        }
        called = true;
        if (lock === null) {
          outcome = BUSY;
          settled = true;
          return MARKER;
        }
        if (!lock || lock.name !== BROWSER_SYNC_LOCK_NAME || lock.mode !== 'exclusive') {
          throw new Error('Некорректный ответ блокировки');
        }
        if (halted) {
          outcome = BLOCKED;
          settled = true;
          return MARKER;
        }
        entered = true;
        try {
          await input.operation();
          outcome = COMPLETED;
        } catch {
          halted = true;
          outcome = UNCERTAIN;
        }
        settled = true;
        return MARKER;
      }
    );
    // Настоящий API ждёт завершения callback; ненадёжный адаптер не может выдать
    // ранний ответ за подтверждение. Уже запущенный callback может продолжаться.
    if (!called || !settled || result !== MARKER) {
      if (entered) halted = true;
      return entered ? UNCERTAIN : UNAVAILABLE;
    }
    return halted && outcome === COMPLETED ? UNCERTAIN : outcome;
  } catch {
    if (entered) {
      halted = true;
      return UNCERTAIN;
    }
    return UNAVAILABLE;
  } finally {
    // Не запускаем запоздавший callback неисправного адаптера после возврата.
    active = false;
  }
}
