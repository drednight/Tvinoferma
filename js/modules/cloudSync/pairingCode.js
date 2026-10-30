// @ts-check
// Код сверки НЕ является паролем и не даёт доступа к зашифрованным данным. Он содержит
// только ID и доверенные отпечатки корня/обёрток. Его необходимо передавать по отдельному
// аутентифицированному каналу: подменённый код не становится доверенным из-за формата.
// Не подтверждает полноту облака, свежесть, сохранность ключа или готовность применения.
import { isSyncId } from './envelope.js';
import { object } from './exportSchema.js';

const FORMAT = 'tvinoferma-pairing-code';
const PREFIX = 'TFP1-';
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
const MAX_RAW = 2048;
function failed() {
  return new Error('Некорректный код сверки синхронизации');
}
function pin(value, idField) {
  const input = object(value, [idField, 'sha256']);
  if (!isSyncId(input[idField]) || typeof input.sha256 !== 'string' || !HEX.test(input.sha256)) throw failed();
  return Object.freeze({ [idField]: input[idField], sha256: input.sha256 });
}
function descriptor(value) {
  const input = object(value, ['format', 'version', 'datasetId', 'keyPin', 'rootPin']);
  if (input.format !== FORMAT || input.version !== 1 || !isSyncId(input.datasetId)) throw failed();
  return Object.freeze({
    format: FORMAT,
    version: 1,
    datasetId: input.datasetId,
    keyPin: pin(input.keyPin, 'bundleId'),
    rootPin: pin(input.rootPin, 'versionId')
  });
}
function encode(raw) {
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Создаёт код из УЖЕ ДОВЕРЕННЫХ ID и отпечатков. Не получает их из облака и не
 * проверяет, что пользователь сохранил код или секрет. Код не содержит dataKey.
 * @param {{datasetId:string, keyPin:any, rootPin:any}} options
 */
export function createPairingCode(options) {
  const input = object(options, ['datasetId', 'keyPin', 'rootPin']);
  const value = descriptor({ format: FORMAT, version: 1, ...input });
  return PREFIX + encode(JSON.stringify(value));
}

/** Разбирает код, но не подтверждает его источник или целостность канала передачи. */
export function parsePairingCode(code) {
  if (
    typeof code !== 'string' ||
    !code.startsWith(PREFIX) ||
    code.length > PREFIX.length + Math.ceil((MAX_RAW * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(code.slice(PREFIX.length))
  )
    throw failed();
  const encoded = code.slice(PREFIX.length);
  try {
    const raw = atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (encoded.length % 4)) % 4));
    if (raw.length > MAX_RAW || !/^[\x20-\x7e]+$/.test(raw) || encode(raw) !== encoded) throw failed();
    const value = descriptor(JSON.parse(raw));
    if (JSON.stringify(value) !== raw) throw failed();
    return value;
  } catch {
    throw failed();
  }
}
