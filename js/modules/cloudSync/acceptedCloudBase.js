// @ts-check
// Локальная привязка состояния к явно принятому облачному снимку. Записывается
// вместе с state, а соответствующий anchorId — в зашифрованной очереди до неё.
// Это не защита от согласованного отката или прямых IPC вне протокола.
import { isSyncId } from './envelope.js';
import { object } from './exportSchema.js';

const KEY = 'cloudSyncAcceptedBase';
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
function invalid() {
  return new Error('Не удалось проверить принятую локальную основу');
}
function checked(value) {
  const input = object(value, ['version', 'provider', 'datasetId', 'pin', 'anchorId']);
  const pin = object(input.pin, ['versionId', 'sha256']);
  if (
    input.version !== 1 ||
    !['google', 'yandex'].includes(input.provider) ||
    !isSyncId(input.datasetId) ||
    !isSyncId(input.anchorId) ||
    !isSyncId(pin.versionId) ||
    typeof pin.sha256 !== 'string' ||
    !HEX.test(pin.sha256) ||
    new Set([input.datasetId, input.anchorId, pin.versionId]).size !== 3
  )
    throw invalid();
  return {
    version: 1,
    provider: input.provider,
    datasetId: input.datasetId,
    pin: { versionId: pin.versionId, sha256: pin.sha256 },
    anchorId: input.anchorId
  };
}

/** Создаёт локальную метку только после принятия полностью совпадающего снимка. */
export function withAcceptedCloudBase(settings, value) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid();
  const next = checked(value);
  if (Object.hasOwn(settings, KEY)) {
    const previous = checked(settings[KEY]);
    if (JSON.stringify(previous) !== JSON.stringify(next)) throw invalid();
  }
  return { ...settings, [KEY]: next };
}

/** Отсутствие, повреждение или несовпадение обеих частей закрывает публикацию. */
export function requireMatchingCloudBase(settings, value) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid();
  const request = object(value, ['provider', 'datasetId', 'adoptedBase']);
  if (request.adoptedBase === null) {
    if (Object.hasOwn(settings, KEY)) throw invalid();
    return;
  }
  const adopted = object(request.adoptedBase, ['pin', 'anchorId']);
  const expected = checked({
    version: 1,
    provider: request.provider,
    datasetId: request.datasetId,
    pin: adopted.pin,
    anchorId: adopted.anchorId
  });
  if (!Object.hasOwn(settings, KEY) || JSON.stringify(checked(settings[KEY])) !== JSON.stringify(expected))
    throw invalid();
}
