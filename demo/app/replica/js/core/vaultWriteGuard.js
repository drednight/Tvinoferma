// @ts-check
// Служебные признаки результата записи контактов в хранилище ОС.
// Они живут только в этом JS-контексте: это не durable-журнал и не native lock.

const PREFIX = 'TF_VAULT_WRITE_UNCERTAIN:';
const changedSnapshots = new WeakSet();

/** Ошибка не содержит ключей, контактов, путей или исходного сообщения IPC. */
export function vaultWriteGuardError() {
  return new Error(`${PREFIX} Хранилище учётных данных могло измениться или не совпадает с прочитанным`);
}

/** @param {unknown} error */
export function isVaultWriteGuardError(error) {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return message.startsWith(PREFIX);
}

/** Отмечаем только объект подготовленного снимка, не добавляя в него служебные поля. */
export function markVaultUpdated(snapshot) {
  if (snapshot && typeof snapshot === 'object') changedSnapshots.add(snapshot);
}

/** @param {unknown} snapshot */
export function wasVaultUpdated(snapshot) {
  return !!snapshot && typeof snapshot === 'object' && changedSnapshots.has(snapshot);
}
