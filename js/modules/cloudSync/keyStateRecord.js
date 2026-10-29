// @ts-check
// Каноническая локальная запись внутреннего ключа. Содержит секретный dataKey:
// только для защищённого хранилища ОС, никогда не для localStorage, логов или сети.
// Не подтверждает свежесть OS-записи, физическое сохранение или сохранение backup-ключа.
import { isSyncId } from './envelope.js';
import { object } from './exportSchema.js';
import { copyKeyBundle, verifyKeyBundleDataKey } from './keyBundle.js';

const FORMAT = 'tvinoferma-cloud-key-state';
const MAX_RECORD = 16 * 1024;
const MAX_BUNDLE = 12_000;
const HEX = /^[0-9a-f]{64}$/;

function failed() {
  return new Error('Не удалось проверить локальную запись ключа синхронизации');
}
function encode(value) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_BUNDLE || !/^[A-Za-z0-9_-]+$/.test(value))
    throw failed();
  let text;
  try {
    text = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4));
  } catch {
    throw failed();
  }
  if (encode(text) !== value || !/^[\x20-\x7e]+$/.test(text)) throw failed();
  return text;
}
function validateIds(slotId, revision, datasetId, bundleId) {
  const ids = [slotId, revision, datasetId, bundleId];
  if (!ids.every(isSyncId) || new Set(ids).size !== ids.length) throw failed();
}
function safeBundle(bundle) {
  const copy = copyKeyBundle(bundle);
  Object.freeze(copy.main);
  Object.freeze(copy.backup);
  return Object.freeze(copy);
}
function safePin(value) {
  const input = object(value, ['bundleId', 'sha256']);
  if (!isSyncId(input.bundleId) || typeof input.sha256 !== 'string' || !HEX.test(input.sha256)) throw failed();
  return Object.freeze({ bundleId: input.bundleId, sha256: input.sha256 });
}
function rawFor(state) {
  const raw = JSON.stringify({
    format: FORMAT,
    version: 1,
    slotId: state.slotId,
    revision: state.revision,
    datasetId: state.datasetId,
    bundleId: state.bundle.bundleId,
    fingerprint: state.pin.sha256,
    dataKey: state.dataKey,
    bundle: encode(JSON.stringify(state.bundle))
  });
  if (raw.length > MAX_RECORD) throw failed();
  return raw;
}

/**
 * Строит запись только после проверки доказательства обеих обёрток внутренним ключом.
 * Возвращаемые state и raw содержат секрет: не показывать и не логировать.
 * @param {any} value
 * @param {Crypto} [cryptoSource]
 */
export async function createKeyStateRecord(value, cryptoSource) {
  try {
    const input = object(value, ['slotId', 'revision', 'datasetId', 'bundle', 'pin', 'dataKey']);
    const bundle = safeBundle(input.bundle);
    const pin = safePin(input.pin);
    validateIds(input.slotId, input.revision, input.datasetId, bundle.bundleId);
    if (bundle.datasetId !== input.datasetId || pin.bundleId !== bundle.bundleId) throw failed();
    await verifyKeyBundleDataKey({
      bundle,
      expectedDatasetId: input.datasetId,
      expectedPin: pin,
      dataKey: input.dataKey,
      cryptoSource
    });
    const state = Object.freeze({
      slotId: input.slotId,
      revision: input.revision,
      datasetId: input.datasetId,
      bundle,
      pin,
      dataKey: input.dataKey
    });
    return Object.freeze({ state, raw: rawFor(state) });
  } catch {
    throw failed();
  }
}

/** Каждое чтение заново проверяет форму, привязки, отпечаток и криптографическое доказательство. */
export async function parseKeyStateRecord(raw, cryptoSource) {
  try {
    if (typeof raw !== 'string' || raw.length > MAX_RECORD || !/^[\x20-\x7e]+$/.test(raw)) throw failed();
    const input = object(JSON.parse(raw), [
      'format',
      'version',
      'slotId',
      'revision',
      'datasetId',
      'bundleId',
      'fingerprint',
      'dataKey',
      'bundle'
    ]);
    if (input.format !== FORMAT || input.version !== 1) throw failed();
    const bundleJson = decode(input.bundle);
    const bundle = safeBundle(JSON.parse(bundleJson));
    if (JSON.stringify(bundle) !== bundleJson || input.bundleId !== bundle.bundleId) throw failed();
    const result = await createKeyStateRecord(
      {
        slotId: input.slotId,
        revision: input.revision,
        datasetId: input.datasetId,
        bundle,
        pin: { bundleId: input.bundleId, sha256: input.fingerprint },
        dataKey: input.dataKey
      },
      cryptoSource
    );
    if (result.raw !== raw) throw failed();
    return result;
  } catch {
    throw failed();
  }
}
