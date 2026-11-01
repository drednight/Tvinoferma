// @ts-check
// Координация ТОЛЬКО этого JS-контекста: не lock ОС и не устойчивый карантин.
// Не даёт фабричному сбросу начаться одновременно с пользовательским входом
// или забыванием доступа, которые могут записать Credential Manager после сброса.
let active = 0;
let dataActive = false;
let uncertain = false;
let resetting = false;
let logoutWaiting = false;
let wakeLogout = null;
// An explicit logout with a lost native reply must not leave this provider's
// cached sessions usable. Other standalone providers remain independent.
const logoutUncertain = new Set();
export function blockCloudProviderAfterLogout(provider) {
  if (!['google', 'yandex'].includes(provider)) throw blocked();
  logoutUncertain.add(provider);
}
export function cloudProviderLogoutUncertain(provider) {
  return logoutUncertain.has(provider);
}

function blocked() {
  return new Error(
    'Сброс остановлен: завершите операции с облачным доступом и проверьте неподтверждённые результаты перед перезапуском.'
  );
}

/** Регистрирует один пользовательский сценарий с возможной записью OAuth. */
export function beginCloudCredentialOperation() {
  if (resetting || dataActive || logoutWaiting) throw blocked();
  active++;
  let finished = false;
  return Object.freeze({
    /** @param {boolean} outcomeUncertain */
    finish(outcomeUncertain) {
      if (finished || typeof outcomeUncertain !== 'boolean') throw blocked();
      finished = true;
      if (outcomeUncertain) uncertain = true;
      active--;
      if (!active) wakeLogout?.();
    }
  });
}

/**
 * Операции с данными и привязками не должны начинаться после неизвестного
 * результата любого участвующего облачного IPC в этом контексте. Это не
 * устойчивый или межпроцессный карантин; после перезапуска нужна проверка.
 */
export function beginCloudDataOperation() {
  if (uncertain || resetting || active || dataActive || logoutWaiting) throw blocked();
  dataActive = true;
  active++;
  let finished = false;
  return Object.freeze({
    /** @param {boolean} outcomeUncertain */
    finish(outcomeUncertain) {
      if (finished || typeof outcomeUncertain !== 'boolean') throw blocked();
      finished = true;
      if (outcomeUncertain) uncertain = true;
      active--;
      if (!active) wakeLogout?.();
      dataActive = false;
    }
  });
}

/**
 * Синхронно закрывает вход/забывание до первого ожидания сброса. Если сброс не
 * дошёл до отправки IPC, вызывающий освобождает барьер. После отправки он остаётся
 * закрыт до перезапуска, даже если результат сброса неизвестен.
 */
export function beginCloudCredentialReset() {
  if (resetting || active || uncertain || logoutWaiting) throw blocked();
  resetting = true;
  let released = false;
  return () => {
    if (released) throw blocked();
    released = true;
    resetting = false;
  };
}

/**
 * Reserve an exclusive local logout before waiting for an in-flight file check.
 * No polling, cancellation of unknown native writes or dependency on signing out
 * the other provider. A previous uncertainty still blocks reset/data writes;
 * only this slot-CAS, secret-only logout may proceed under the native lock.
 */
export async function beginCloudLogoutOperation(provider) {
  if (!['google', 'yandex'].includes(provider) || resetting || logoutWaiting || logoutUncertain.has(provider))
    throw blocked();
  logoutWaiting = true;
  try {
    if (active)
      await new Promise(resolve => {
        wakeLogout = resolve;
      });
    dataActive = true;
    active++;
    let finished = false;
    return Object.freeze({
      finish(outcomeUncertain) {
        if (finished || typeof outcomeUncertain !== 'boolean') throw blocked();
        finished = true;
        if (outcomeUncertain) uncertain = true;
        active--;
        dataActive = false;
        if (!active) wakeLogout?.();
      }
    });
  } finally {
    wakeLogout = null;
    logoutWaiting = false;
  }
}
