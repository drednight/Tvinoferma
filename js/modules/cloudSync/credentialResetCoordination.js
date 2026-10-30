// @ts-check
// Координация ТОЛЬКО этого JS-контекста: не lock ОС и не устойчивый карантин.
// Не даёт фабричному сбросу начаться одновременно с пользовательским входом
// или забыванием доступа, которые могут записать Credential Manager после сброса.
let active = 0;
let uncertain = false;
let resetting = false;

function blocked() {
  return new Error(
    'Сброс остановлен: завершите операции с облачным доступом и проверьте неподтверждённые результаты перед перезапуском.'
  );
}

/** Регистрирует один пользовательский сценарий с возможной записью OAuth. */
export function beginCloudCredentialOperation() {
  if (resetting) throw blocked();
  active++;
  let finished = false;
  return Object.freeze({
    /** @param {boolean} outcomeUncertain */
    finish(outcomeUncertain) {
      if (finished || typeof outcomeUncertain !== 'boolean') throw blocked();
      finished = true;
      if (outcomeUncertain) uncertain = true;
      active--;
    }
  });
}

/**
 * Синхронно закрывает вход/забывание до первого ожидания сброса. Если сброс не
 * дошёл до отправки IPC, вызывающий освобождает барьер. После отправки он остаётся
 * закрыт до перезапуска, даже если результат сброса неизвестен.
 */
export function beginCloudCredentialReset() {
  if (resetting || active || uncertain) throw blocked();
  resetting = true;
  let released = false;
  return () => {
    if (released) throw blocked();
    released = true;
    resetting = false;
  };
}
