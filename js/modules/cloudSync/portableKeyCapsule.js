// @ts-check
// Экспериментальное восстановление ключа из самой зашифрованной версии, без отдельного POST.
// В капсуле только две ЗАШИФРОВАННЫЕ обёртки ключа, salt, параметры KDF и proof; она видна
// провайдеру и допускает офлайн-подбор слабых паролей. Она не подтверждает свежесть, историю,
// резервную копию, сохранность секрета, идентичность аккаунта или применение данных.
// Доверенный pin/datasetId должны быть получены отдельно, не из того же облачного файла.
import { decryptSnapshot, isSyncId, MAX_KEY_CAPSULE_BYTES } from './envelope.js';
import { object } from './exportSchema.js';
import { copyKeyBundle, fingerprintKeyBundle, openKeyBundle, verifyKeyBundleDataKey } from './keyBundle.js';
import { copyCloudEnvelope } from './providers/common.js';

const ENVELOPE_FIELDS = ['format', 'version', 'algorithm', 'datasetId', 'versionId', 'iv', 'ciphertext'];
const HEX = /^[0-9a-f]{64}$/;

function failed() {
  return new Error('Не удалось проверить переносимый набор ключей');
}
function pinCopy(value) {
  const pin = object(value, ['bundleId', 'sha256']);
  if (!isSyncId(pin.bundleId) || typeof pin.sha256 !== 'string' || !HEX.test(pin.sha256)) throw failed();
  return Object.freeze({ bundleId: pin.bundleId, sha256: pin.sha256 });
}
function bundleCopy(value) {
  const bundle = copyKeyBundle(value);
  Object.freeze(bundle.main);
  Object.freeze(bundle.backup);
  return Object.freeze(bundle);
}
function encode(value) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function encodeBundle(bundle) {
  const raw = JSON.stringify(bundle);
  if (raw.length > MAX_KEY_CAPSULE_BYTES || !/^[\x20-\x7e]+$/.test(raw)) throw failed();
  return encode(raw);
}
function decodeBundle(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > Math.ceil((MAX_KEY_CAPSULE_BYTES * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw failed();
  let raw;
  try {
    raw = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4));
  } catch {
    throw failed();
  }
  if (raw.length > MAX_KEY_CAPSULE_BYTES || !/^[\x20-\x7e]+$/.test(raw) || encode(raw) !== value) throw failed();
  const bundle = bundleCopy(JSON.parse(raw));
  // Отвергаем дубли, пробелы, иной порядок полей и альтернативные сериализации.
  if (JSON.stringify(bundle) !== raw) throw failed();
  return bundle;
}
function checkedEnvelope(value) {
  const fields = object(value, ENVELOPE_FIELDS, ['keyCapsule']);
  const envelope = copyCloudEnvelope(fields, fields.datasetId);
  if (envelope.version !== 2) throw failed();
  const bundle = decodeBundle(envelope.keyCapsule);
  if (bundle.datasetId !== envelope.datasetId) throw failed();
  return { envelope, bundle };
}

/**
 * Подготавливает публичную зашифрованную капсулу для версии. Данные и секреты остаются
 * в памяти; proof и сохранённый доверенный pin проверяются ДО помещения файла в очередь.
 * @param {{bundle: any, pin: any, dataKey: string, datasetId: string, cryptoSource?: Crypto}} options
 */
export async function makePortableKeyCapsule(options) {
  const input = object(options, ['bundle', 'pin', 'dataKey', 'datasetId'], ['cryptoSource']);
  const bundle = bundleCopy(input.bundle);
  const pin = pinCopy(input.pin);
  if (!isSyncId(input.datasetId) || bundle.datasetId !== input.datasetId) throw failed();
  const capsule = encodeBundle(bundle);
  await verifyKeyBundleDataKey({
    bundle,
    expectedDatasetId: input.datasetId,
    expectedPin: pin,
    dataKey: input.dataKey,
    cryptoSource: input.cryptoSource
  });
  return capsule;
}

/**
 * Показывает неподтверждённые метаданные файла для ручного сопоставления. Полученный
 * отсюда pin НЕ становится доверенным автоматически и не означает свежесть файла.
 * @param {{envelope: any, cryptoSource?: Crypto}} options
 */
export async function inspectPortableEnvelope(options) {
  const input = object(options, ['envelope'], ['cryptoSource']);
  const { envelope, bundle } = checkedEnvelope(input.envelope);
  const pin = pinCopy(await fingerprintKeyBundle(bundle, input.cryptoSource));
  return Object.freeze({ envelope, bundle, pin });
}

/**
 * Проверяет, что v2 действительно содержит обёртки для данного внутреннего ключа.
 * При отсутствии expectedPin проверяется лишь самосогласованность, НЕ доверие и свежесть.
 * @param {{envelope: any, dataKey: string, expectedPin?: any, cryptoSource?: Crypto}} options
 */
export async function verifyPortableEnvelopeBinding(options) {
  const input = object(options, ['envelope', 'dataKey'], ['expectedPin', 'cryptoSource']);
  const expectedPin = Object.hasOwn(input, 'expectedPin') ? pinCopy(input.expectedPin) : null;
  const inspected = await inspectPortableEnvelope({ envelope: input.envelope, cryptoSource: input.cryptoSource });
  await verifyKeyBundleDataKey({
    bundle: inspected.bundle,
    expectedDatasetId: inspected.envelope.datasetId,
    expectedPin: expectedPin || inspected.pin,
    dataKey: input.dataKey,
    cryptoSource: input.cryptoSource
  });
  return inspected;
}

/**
 * Открывает v2 на другом ПК только с НЕЗАВИСИМО подтверждёнными datasetId и pin.
 * Возвращённый dataKey является секретом: только в защищённое хранилище, не в UI/логи.
 * Снимок ещё не проверен как история, не сравнен и не применён. Записи и сети нет.
 * @param {{envelope: any, expectedDatasetId: string, expectedPin: any, role: 'main'|'backup', secret: string, cryptoSource?: Crypto}} options
 */
export async function openPortableEnvelope(options) {
  const input = object(options, ['envelope', 'expectedDatasetId', 'expectedPin', 'role', 'secret'], ['cryptoSource']);
  const expectedPin = pinCopy(input.expectedPin);
  if (!isSyncId(input.expectedDatasetId)) throw failed();
  const inspected = await inspectPortableEnvelope({ envelope: input.envelope, cryptoSource: input.cryptoSource });
  if (inspected.envelope.datasetId !== input.expectedDatasetId) throw failed();
  const opened = await openKeyBundle({
    bundle: inspected.bundle,
    expectedDatasetId: input.expectedDatasetId,
    expectedPin,
    role: input.role,
    secret: input.secret,
    cryptoSource: input.cryptoSource
  });
  const dataKey = opened.dataKey;
  const snapshot = await decryptSnapshot({
    envelope: inspected.envelope,
    recoveryKey: dataKey,
    expectedDatasetId: input.expectedDatasetId,
    cryptoSource: input.cryptoSource
  });
  return Object.freeze({
    datasetId: inspected.envelope.datasetId,
    versionId: inspected.envelope.versionId,
    bundle: inspected.bundle,
    pin: expectedPin,
    dataKey,
    snapshot
  });
}
