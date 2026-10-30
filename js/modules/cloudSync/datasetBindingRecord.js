// @ts-check
// Несекретный, но личный локальный pin. Формат совпадает с Rust; он сам по себе
// не подтверждает независимый источник root pin, соответствие папки, согласие
// человека, доказательство dataKey или наличие резервной копии. Не логировать.
import { validCredentialId } from './providers/oauthCredentialRecord.js';
import { object } from './exportSchema.js';
import { validGoogleId } from './providers/common.js';

const PREFIX = 'tf-dataset-binding-v1';
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
function failed() {
  return new Error('Некорректная локальная привязка набора синхронизации');
}
function safePin(value, idField) {
  const pin = object(value, [idField, 'sha256']);
  if (!validCredentialId(pin[idField]) || typeof pin.sha256 !== 'string' || !HEX.test(pin.sha256)) throw failed();
  return Object.freeze({ [idField]: pin[idField], sha256: pin.sha256 });
}
function copy(value) {
  const input = object(
    value,
    ['provider', 'accountSlotId', 'keySlotId', 'datasetId', 'keyPin', 'rootPin'],
    ['folderId']
  );
  if (
    !['google', 'yandex'].includes(input.provider) ||
    !validCredentialId(input.accountSlotId) ||
    !validCredentialId(input.keySlotId) ||
    !validCredentialId(input.datasetId) ||
    (input.provider === 'google' ? !validGoogleId(input.folderId) : input.folderId !== undefined)
  )
    throw failed();
  const keyPin = safePin(input.keyPin, 'bundleId');
  const rootPin = safePin(input.rootPin, 'versionId');
  return Object.freeze({
    provider: input.provider,
    accountSlotId: input.accountSlotId,
    keySlotId: input.keySlotId,
    datasetId: input.datasetId,
    keyPin,
    rootPin,
    ...(input.provider === 'google' ? { folderId: input.folderId } : {})
  });
}
function encoded(binding) {
  return [
    PREFIX,
    binding.provider,
    'ready',
    binding.accountSlotId,
    binding.keySlotId,
    binding.datasetId,
    binding.keyPin.bundleId,
    binding.keyPin.sha256,
    binding.rootPin.versionId,
    binding.rootPin.sha256,
    binding.folderId ?? '-'
  ].join('|');
}

/** Доверие устанавливает вызывающая сторона, не эта функция. */
export function createDatasetBindingRecord(value) {
  try {
    const binding = copy(value);
    return Object.freeze({ binding, raw: encoded(binding) });
  } catch {
    throw failed();
  }
}

/** Разбирает канонический локальный pin; совпадение с vault проверяется отдельно. */
export function parseDatasetBindingRecord(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 1024 || /[^\x20-\x7e]/.test(raw)) throw failed();
    const fields = raw.split('|');
    if (fields.length !== 11 || fields[0] !== PREFIX || fields[2] !== 'ready') throw failed();
    const provider = fields[1];
    const binding = copy({
      provider,
      accountSlotId: fields[3],
      keySlotId: fields[4],
      datasetId: fields[5],
      keyPin: { bundleId: fields[6], sha256: fields[7] },
      rootPin: { versionId: fields[8], sha256: fields[9] },
      ...(provider === 'google' ? { folderId: fields[10] } : {})
    });
    if (encoded(binding) !== raw) throw failed();
    return Object.freeze({ binding, raw });
  } catch {
    throw failed();
  }
}
