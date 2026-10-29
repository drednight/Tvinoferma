// @ts-check
// Идентификатор облачной синхронизации хранится отдельно от локального id сущности.
// Нормализаторы сохраняют существующее значение как есть: повреждённый или повторный
// syncId нельзя молча заменить. Проверка и назначение делаются при подготовке синхронизации.

/** @param {any} input */
export function preserveSyncId(input) {
  return input && Object.hasOwn(input, 'syncId') ? { syncId: input.syncId } : {};
}

/** При копировании в новую сущность старый sync-ID оставлять нельзя. @param {any} input */
export function withoutSyncId(input) {
  const copy = { ...input };
  delete copy.syncId;
  return copy;
}
