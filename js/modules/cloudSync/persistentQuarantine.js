// @ts-check
// Эксперимент: отметка для кооперативных операций в одном browser origin.
// Не подключён к приложению, очереди, vault, облаку или настоящему восстановлению.
// Отдельное надёжное хранилище ключа/pin, backup, fsync и native lock здесь НЕ реализованы.

import { generateSyncId, isSyncId } from './envelope.js';
import { object } from './exportSchema.js';
import { tryBrowserSyncOperation } from './browserCoordination.js';

export const QUARANTINE_STORAGE_KEY = 'tf-cloud-sync-quarantine:v1';
const FORMAT = 'tvinoferma-cloud-sync-quarantine';
const VERSION = 1;
const MAX_MARKER_CHARS = 2048;
const BODY_KEYS = ['format', 'version', 'markerId', 'deviceId', 'datasetId', 'phase', 'attemptId'];
const ENVELOPE_KEYS = ['body', 'mac'];
const REVIEW = 'manual_review';
const BLOCKED = Object.freeze({ status: 'blocked_marker', action: REVIEW });
const PENDING = Object.freeze({ status: 'blocked_pending', action: REVIEW });
const UNAVAILABLE = Object.freeze({ status: 'unavailable', action: REVIEW });
const MARKER_UNCERTAIN = Object.freeze({ status: 'marker_write_uncertain', action: REVIEW });
const OPERATION_UNCERTAIN = Object.freeze({ status: 'operation_uncertain', action: REVIEW });
const COMPLETED = Object.freeze({ status: 'completed_for_test', action: REVIEW });

function invalid() {
  return new Error('Некорректная карантинная отметка');
}

function cryptoAndKey(cryptoSource, authKey) {
  const crypto = cryptoSource || globalThis.crypto;
  try {
    if (
      !crypto?.subtle ||
      typeof crypto.getRandomValues !== 'function' ||
      authKey?.type !== 'secret' ||
      authKey.extractable !== false ||
      authKey.algorithm?.name !== 'HMAC' ||
      authKey.algorithm?.hash?.name !== 'SHA-256' ||
      authKey.algorithm?.length !== 256 ||
      !authKey.usages?.includes('sign') ||
      !authKey.usages?.includes('verify')
    ) {
      throw invalid();
    }
  } catch {
    throw invalid();
  }
  return crypto;
}

function pins(input) {
  if (!isSyncId(input.markerId) || !isSyncId(input.deviceId) || !isSyncId(input.datasetId)) throw invalid();
  return { markerId: input.markerId, deviceId: input.deviceId, datasetId: input.datasetId };
}

function bodyFor(expected, phase, attemptId) {
  return {
    format: FORMAT,
    version: VERSION,
    markerId: expected.markerId,
    deviceId: expected.deviceId,
    datasetId: expected.datasetId,
    phase,
    attemptId
  };
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function macBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalid();
  let bytes;
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '=');
    bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    throw invalid();
  }
  if (bytes.length !== 32 || bytesToBase64Url(bytes) !== value) throw invalid();
  return bytes;
}

function bodyBytes(body) {
  return new TextEncoder().encode(JSON.stringify(body));
}

async function signedMarker(crypto, authKey, body) {
  const mac = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', authKey, bodyBytes(body))));
  return JSON.stringify({ body, mac });
}

async function readVerified(raw, crypto, authKey, expected) {
  if (typeof raw !== 'string' || raw.length > MAX_MARKER_CHARS) throw invalid();
  let parsed;
  try {
    parsed = JSON.parse(raw);
    // Наш формат всегда канонический. Это отклоняет и повторные ключи JSON.
    if (JSON.stringify(parsed) !== raw) throw invalid();
    const envelope = object(parsed, ENVELOPE_KEYS);
    const body = object(envelope.body, BODY_KEYS);
    const validPhase =
      (body.phase === 'ready' && body.attemptId === null) || (body.phase === 'pending' && isSyncId(body.attemptId));
    if (
      body.format !== FORMAT ||
      body.version !== VERSION ||
      body.markerId !== expected.markerId ||
      body.deviceId !== expected.deviceId ||
      body.datasetId !== expected.datasetId ||
      !validPhase
    ) {
      throw invalid();
    }
    // Дополнительно фиксируем порядок полей, который подписывает автор отметки.
    const canonicalBody = bodyFor(expected, body.phase, body.attemptId);
    if (JSON.stringify(canonicalBody) !== JSON.stringify(envelope.body)) throw invalid();
    if (!(await crypto.subtle.verify('HMAC', authKey, macBytes(envelope.mac), bodyBytes(canonicalBody)))) {
      throw invalid();
    }
    return canonicalBody;
  } catch {
    throw invalid();
  }
}

/**
 * Только готовит начальную отметку в памяти. Ничего не сохраняет и не проверяет,
 * действительно ли устройство новое. Не используйте для сброса существующей отметки.
 * Ключ и markerId должны быть независимо созданы и сохранены вызывающим кодом.
 *
 * @param {{markerId: string, deviceId: string, datasetId: string, authKey: CryptoKey, cryptoSource?: Crypto}} options
 */
export async function prepareFreshQuarantineMarker(options) {
  const input = object(options, ['markerId', 'deviceId', 'datasetId', 'authKey'], ['cryptoSource']);
  const expected = pins(input);
  const crypto = cryptoAndKey(input.cryptoSource, input.authKey);
  return signedMarker(crypto, input.authKey, bodyFor(expected, 'ready', null));
}

/**
 * Пробует выполнить ОДНУ кооперативную операцию под Web Lock. Перед callback сначала
 * проверяет независимые pin и HMAC, записывает pending и точно перечитывает строку.
 * Ошибка callback оставляет pending; новое чтение в другой вкладке или после загрузки
 * блокирует callback. Только после успешного callback отметка возвращается в ready.
 * Никакой результат callback, исключение, путь, ключ или данные не возвращаются.
 *
 * Предполагается доверенный Storage с атомарной заменой одной строки, отдельно сохранённые
 * ключ и pin, неизменные методы Storage и кооперация ВСЕХ писателей. Функция не проверяет
 * физическую долговечность, защищённость отдельного хранилища или правильность callback.
 * Откат старой подписанной ready-отметки не выявляется. Web Locks можно обойти или украсть;
 * их loss нельзя надёжно синхронно обнаружить, а уже начатый callback может продолжаться.
 * Эту модель нельзя подключать к реальным изменениям или считать восстановлением.
 *
 * @param {{markerId: string, deviceId: string, datasetId: string, authKey: CryptoKey,
 *  cryptoSource?: Crypto, markerStorage: Storage, lockManager: any, operation: () => any}} options
 * @returns {Promise<Readonly<{status: string, action?: string}>>}
 */
export async function tryQuarantinedBrowserOperation(options) {
  const input = object(
    options,
    ['markerId', 'deviceId', 'datasetId', 'authKey', 'markerStorage', 'lockManager', 'operation'],
    ['cryptoSource']
  );
  const expected = pins(input);
  const crypto = cryptoAndKey(input.cryptoSource, input.authKey);
  if (
    !input.markerStorage ||
    typeof input.markerStorage.getItem !== 'function' ||
    typeof input.markerStorage.setItem !== 'function' ||
    typeof input.operation !== 'function'
  ) {
    throw invalid();
  }
  // Ссылки на параметры фиксируются до первого await; снаружи нельзя заменить
  // сам объект Storage или callback в исходном options во время операции.
  const storage = input.markerStorage;
  const operation = input.operation;
  const authKey = input.authKey;
  let active = true;
  /** @type {Readonly<{status: string, action?: string}>} */
  let outcome = UNAVAILABLE;
  try {
    const result = await tryBrowserSyncOperation({
      lockManager: input.lockManager,
      operation: async () => {
        let raw;
        try {
          raw = storage.getItem(QUARANTINE_STORAGE_KEY);
        } catch {
          outcome = UNAVAILABLE;
          return;
        }
        let marker;
        try {
          marker = await readVerified(raw, crypto, authKey, expected);
        } catch {
          outcome = BLOCKED;
          return;
        }
        if (!active) return;
        if (marker.phase === 'pending') {
          outcome = PENDING;
          return;
        }

        let pendingRaw;
        try {
          const attemptId = generateSyncId(crypto);
          pendingRaw = await signedMarker(crypto, authKey, bodyFor(expected, 'pending', attemptId));
        } catch {
          outcome = UNAVAILABLE;
          return;
        }
        if (!active) return;
        // Если отметка изменилась во время проверки/подписи, не затираем её.
        try {
          if (storage.getItem(QUARANTINE_STORAGE_KEY) !== raw) {
            outcome = BLOCKED;
            return;
          }
        } catch {
          outcome = UNAVAILABLE;
          return;
        }
        try {
          storage.setItem(QUARANTINE_STORAGE_KEY, pendingRaw);
          if (storage.getItem(QUARANTINE_STORAGE_KEY) !== pendingRaw) throw invalid();
        } catch {
          outcome = MARKER_UNCERTAIN;
          // Сообщаем координатору о неизвестном исходе, чтобы он остановил и этот JS-модуль.
          throw invalid();
        }

        try {
          await operation();
        } catch {
          outcome = OPERATION_UNCERTAIN;
          throw invalid();
        }
        // Если wrapper уже узнал о потере lock, не снимаем pending при позднем продолжении.
        // Это не устраняет гонку с принудительным steal до доставки уведомления в JS.
        if (!active) return;
        let readyRaw;
        try {
          readyRaw = await signedMarker(crypto, authKey, bodyFor(expected, 'ready', null));
        } catch {
          outcome = OPERATION_UNCERTAIN;
          throw invalid();
        }
        if (!active) return;
        try {
          // Не перезаписываем чужую/изменённую отметку даже после завершения callback.
          if (storage.getItem(QUARANTINE_STORAGE_KEY) !== pendingRaw) throw invalid();
          storage.setItem(QUARANTINE_STORAGE_KEY, readyRaw);
          if (storage.getItem(QUARANTINE_STORAGE_KEY) !== readyRaw) throw invalid();
        } catch {
          outcome = MARKER_UNCERTAIN;
          throw invalid();
        }
        outcome = COMPLETED;
      }
    });
    if (result.status === 'completed_for_test') return outcome;
    if (result.status === 'uncertain' && (outcome === MARKER_UNCERTAIN || outcome === OPERATION_UNCERTAIN)) {
      return outcome;
    }
    return result;
  } finally {
    active = false;
  }
}
