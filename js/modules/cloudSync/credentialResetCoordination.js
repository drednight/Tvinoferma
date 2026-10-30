// @ts-check
// Координация ТОЛЬКО этого JS-контекста: не lock ОС и не устойчивый карантин.
// Не даёт фабричному сбросу начаться одновременно с пользовательским входом
// или забыванием доступа, которые могут записать Credential Manager после сброса.
let active = 0;
let dataActive = false;
let uncertain = false;
let resetting = false;

function blocked() {
  return new Error(
    'Сброс остановлен: завершите операции с облачным доступом и проверьте неподтверждённые результаты перед перезапуском.'
  );
}

/** Регистрирует один пользовательский сценарий с возможной записью OAuth. */
export function beginCloudCredentialOperation() {
  if (resetting || dataActive) throw blocked();
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
 * Операции с данными и привязками не должны начинаться после неизвестного
 * результата любого участвующего облачного IPC в этом контексте. Это не
 * устойчивый или межпроцессный карантин; после перезапуска нужна проверка.
 */
export function beginCloudDataOperation() {
  if (uncertain || resetting || active || dataActive) throw blocked();
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
  if (resetting || active || uncertain) throw blocked();
  resetting = true;
  let released = false;
  return () => {
    if (released) throw blocked();
    released = true;
    resetting = false;
  };
}
