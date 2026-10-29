// @ts-check
// Основа для будущей синхронизации. Этот модуль не подключён к сохранению или облаку.
// Ключ генерируется случайно; не используйте пароль пользователя как ключ AES.
// До работы с реальными данными требуется интеграция, проверка безопасности и восстановление ключа.

const FORMAT = 'tvinoferma-cloud-sync';
const VERSION = 1;
const ALGORITHM = 'AES-256-GCM';
const KEY_PREFIX = 'TF1-';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_CIPHER_BYTES = MAX_SNAPSHOT_BYTES + TAG_BYTES;
const MAX_NODES = 500_000;
const MAX_DEPTH = 64;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVELOPE_FIELDS = ['algorithm', 'ciphertext', 'datasetId', 'format', 'iv', 'version', 'versionId'];
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

function webCrypto(source) {
  const crypto = source || globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Безопасная криптография недоступна');
  }
  return crypto;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x4000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value, maxBytes) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length % 4 === 1 ||
    value.length > Math.ceil(maxBytes / 3) * 4
  ) {
    throw new Error('Некорректные данные синхронизации');
  }
  let binary;
  try {
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4));
  } catch {
    throw new Error('Некорректные данные синхронизации');
  }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  // Отвергаем неканонические варианты и варианты с лишними незначащими битами.
  if (bytes.length > maxBytes || bytesToBase64Url(bytes) !== value) {
    throw new Error('Некорректные данные синхронизации');
  }
  return bytes;
}

function keyBytes(recoveryKey) {
  if (typeof recoveryKey !== 'string' || !recoveryKey.startsWith(KEY_PREFIX)) {
    throw new Error('Некорректный ключ восстановления');
  }
  let bytes;
  try {
    bytes = base64UrlToBytes(recoveryKey.slice(KEY_PREFIX.length), KEY_BYTES);
  } catch {
    throw new Error('Некорректный ключ восстановления');
  }
  if (bytes.length !== KEY_BYTES) throw new Error('Некорректный ключ восстановления');
  return bytes;
}

/** Идентификатор набора/версии/устройства в локальном формате. */
export function isSyncId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Не позволяем JSON.stringify молча терять поля, числа, элементы массива или исполнять getters. */
function validSnapshot(snapshot) {
  if (!plainObject(snapshot)) throw new Error('Снимок должен быть объектом');
  let nodes = 0;
  const ancestors = new WeakSet();
  function visit(value, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('Снимок слишком сложный');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      if (value.length > MAX_SNAPSHOT_BYTES) throw new Error('Снимок слишком большой');
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return;
    if (typeof value !== 'object') throw new Error('Снимок содержит неподдерживаемое значение');
    const array = Array.isArray(value);
    if (!array && !plainObject(value)) throw new Error('Снимок содержит неподдерживаемый объект');
    if (ancestors.has(value)) throw new Error('Снимок содержит циклическую ссылку');
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw new Error('Снимок содержит неполный массив');
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('Снимок содержит неподдерживаемое поле');
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || unsafeKeys.has(key)) {
        throw new Error('Снимок содержит неподдерживаемое поле');
      }
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        throw new Error('Снимок содержит неподдерживаемый массив');
      }
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(snapshot, 0);
}

function checkEnvelope(envelope) {
  if (!plainObject(envelope)) throw new Error('Некорректный облачный файл');
  const descriptors = Object.getOwnPropertyDescriptors(envelope);
  const keys = Reflect.ownKeys(envelope);
  if (
    keys.some(key => typeof key !== 'string') ||
    keys.length !== ENVELOPE_FIELDS.length ||
    ENVELOPE_FIELDS.some(key => !descriptors[key] || !('value' in descriptors[key]) || !descriptors[key].enumerable)
  ) {
    throw new Error('Некорректный облачный файл');
  }
  const fields = Object.fromEntries(ENVELOPE_FIELDS.map(key => [key, descriptors[key].value]));
  if (
    fields.format !== FORMAT ||
    fields.version !== VERSION ||
    fields.algorithm !== ALGORITHM ||
    !isSyncId(fields.datasetId) ||
    !isSyncId(fields.versionId)
  ) {
    throw new Error('Неподдерживаемый облачный файл');
  }
  const iv = base64UrlToBytes(fields.iv, IV_BYTES);
  const ciphertext = base64UrlToBytes(fields.ciphertext, MAX_CIPHER_BYTES);
  if (iv.length !== IV_BYTES || ciphertext.length < TAG_BYTES) throw new Error('Некорректный облачный файл');
  return { iv, ciphertext, datasetId: fields.datasetId, versionId: fields.versionId };
}

function associatedData(datasetId, versionId) {
  // Порядок и формат фиксированы; изменение идентификаторов или типа нарушит проверку GCM.
  return new TextEncoder().encode(JSON.stringify([FORMAT, VERSION, ALGORITHM, datasetId, versionId]));
}

async function importKey(crypto, recoveryKey, usage) {
  const raw = keyBytes(recoveryKey);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
  } finally {
    raw.fill(0);
  }
}

/** 256 случайных бит; ключ нужно передать пользователю для восстановления на другом ПК. */
export function generateRecoveryKey(cryptoSource) {
  const crypto = webCrypto(cryptoSource);
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  try {
    return KEY_PREFIX + bytesToBase64Url(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** Идентификатор набора или версии: только криптографическая случайность, без ника и времени. */
export function generateSyncId(cryptoSource) {
  const crypto = webCrypto(cryptoSource);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Шифрует JSON-снимок AES-256-GCM с новой случайной nonce. Никакой сети и записи здесь нет.
 * @param {{ snapshot?: any, recoveryKey?: string, datasetId?: string, versionId?: string, cryptoSource?: Crypto }} [options]
 */
export async function encryptSnapshot({ snapshot, recoveryKey, datasetId, versionId, cryptoSource } = {}) {
  if (!isSyncId(datasetId) || !isSyncId(versionId)) throw new Error('Некорректный идентификатор синхронизации');
  validSnapshot(snapshot);
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  if (plaintext.byteLength > MAX_SNAPSHOT_BYTES) {
    plaintext.fill(0);
    throw new Error('Снимок слишком большой');
  }
  try {
    const crypto = webCrypto(cryptoSource);
    const key = await importKey(crypto, recoveryKey, 'encrypt');
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: associatedData(datasetId, versionId), tagLength: 128 },
      key,
      plaintext
    );
    return {
      format: FORMAT,
      version: VERSION,
      algorithm: ALGORITHM,
      datasetId,
      versionId,
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(new Uint8Array(encrypted))
    };
  } finally {
    plaintext.fill(0);
  }
}

/** Проверяет JSON-совместимость снимка, но не разрешённость его бизнес-полей. */
export function validateJsonSnapshot(snapshot) {
  validSnapshot(snapshot);
  return true;
}

/** Проверяет формат внешнего файла, не расшифровывая и не применяя содержимое. */
export function validateEnvelope(envelope) {
  checkEnvelope(envelope);
  return true;
}

/**
 * Расшифровывает только ожидаемый набор; вызывающая сторона дополнительно проверяет схему и историю версий.
 * @param {{ envelope?: any, recoveryKey?: string, expectedDatasetId?: string, cryptoSource?: Crypto }} [options]
 */
export async function decryptSnapshot({ envelope, recoveryKey, expectedDatasetId, cryptoSource } = {}) {
  // Зафиксировать заголовок до первого await: внешний объект может быть изменён вызывающей стороной.
  const { iv, ciphertext, datasetId, versionId } = checkEnvelope(envelope);
  if (!isSyncId(expectedDatasetId) || datasetId !== expectedDatasetId) {
    throw new Error('Облачный файл относится к другому набору данных');
  }
  const crypto = webCrypto(cryptoSource);
  const key = await importKey(crypto, recoveryKey, 'decrypt');
  let plaintext;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: associatedData(datasetId, versionId), tagLength: 128 },
        key,
        ciphertext
      )
    );
    const snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    validSnapshot(snapshot);
    return snapshot;
  } catch {
    // Не раскрываем содержимое файла, пароль или детали ошибки в сообщении и логах.
    throw new Error('Не удалось проверить или расшифровать облачный файл');
  } finally {
    plaintext?.fill(0);
  }
}
