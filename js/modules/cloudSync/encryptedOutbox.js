// @ts-check
// Зашифрованная очередь — подготовительный модуль, ещё не подключённый к приложению и облаку.
// Внутри очереди только облачные конверты; исходные данные и ключ не записываются в Storage.
// Web Storage не даёт надёжной межпроцессной транзакции и fsync. Перед выпуском нужен
// проверенный атомарный Tauri-бэкенд, синхронизация с сохранением state и восстановление после сбоя.

import { encryptSnapshot, isSyncId, validateEnvelope } from './envelope.js';
import { object } from './exportSchema.js';

const FORMAT = 'tvinoferma-encrypted-outbox';
const VERSION = 1;
const KEY_PREFIX = 'tf-cloud-sync-outbox:';
const MAX_ENTRIES = 100;
const MAX_SERIALIZED_CHARS = 64 * 1024 * 1024;
const HEADER_KEYS = ['datasetId', 'deviceId', 'entries', 'format', 'version'];
const ENVELOPE_KEYS = ['algorithm', 'ciphertext', 'datasetId', 'format', 'iv', 'version', 'versionId'];
const locks = new WeakMap();
// Запоминание неизвестного исхода только для того же объекта Storage и этого
// экземпляра JS-модуля. Это не устойчивый карантин и не блокировка других вкладок.
const uncertain = new WeakMap();

function uncertainError() {
  return new Error('Исход записи очереди неизвестен; требуется проверка');
}
function requireCertain(storage, key) {
  if (uncertain.get(storage)?.has(key)) throw uncertainError();
}
function markUncertain(storage, key) {
  let keys = uncertain.get(storage);
  if (!keys) {
    keys = new Set();
    uncertain.set(storage, keys);
  }
  keys.add(key);
}

// Сериализация обращений в одном JS-контексте и ко всем экземплярам с тем же Storage и ключом.
// Это НЕ блокировка других процессов или WebView.
function exclusive(storage, key, action) {
  let byKey = locks.get(storage);
  if (!byKey) {
    byKey = new Map();
    locks.set(storage, byKey);
  }
  const previous = byKey.get(key) || Promise.resolve();
  const operation = previous.then(action);
  const tail = operation.then(
    () => undefined,
    () => undefined
  );
  byKey.set(key, tail);
  tail.then(() => {
    if (byKey.get(key) === tail) byKey.delete(key);
  });
  return operation;
}

function sameEnvelope(a, b) {
  return ENVELOPE_KEYS.every(key => a[key] === b[key]) && a.keyCapsule === b.keyCapsule;
}

function validateState(data, deviceId, datasetId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Очередь синхронизации повреждена');
  const keys = Object.keys(data).sort();
  if (
    keys.length !== HEADER_KEYS.length ||
    HEADER_KEYS.some((key, index) => keys[index] !== key) ||
    data.format !== FORMAT ||
    data.version !== VERSION ||
    data.deviceId !== deviceId ||
    data.datasetId !== datasetId ||
    !Array.isArray(data.entries) ||
    data.entries.length > MAX_ENTRIES
  ) {
    throw new Error('Очередь синхронизации повреждена или относится к другому набору');
  }
  const ids = new Set();
  for (const envelope of data.entries) {
    try {
      validateEnvelope(envelope);
    } catch {
      throw new Error('Очередь синхронизации повреждена');
    }
    if (envelope.datasetId !== datasetId || ids.has(envelope.versionId)) {
      throw new Error('Очередь синхронизации повреждена или относится к другому набору');
    }
    ids.add(envelope.versionId);
  }
  return data;
}

/**
 * Storage должен поддерживать атомарную замену одного ключа в рамках этого контекста.
 * Экземпляр не создаёт и не изменяет очередь, пока не поставлена первая версия.
 */
export class EncryptedOutbox {
  /** @param {{ storage?: Storage, deviceId?: string, datasetId?: string, cryptoSource?: Crypto }} [options] */
  constructor({ storage, deviceId, datasetId, cryptoSource } = {}) {
    if (
      !storage ||
      (typeof storage !== 'object' && typeof storage !== 'function') ||
      typeof storage.getItem !== 'function' ||
      typeof storage.setItem !== 'function' ||
      !isSyncId(deviceId) ||
      !isSyncId(datasetId)
    ) {
      throw new Error('Не удалось открыть очередь синхронизации');
    }
    this.storage = storage;
    this.deviceId = deviceId;
    this.datasetId = datasetId;
    this.cryptoSource = cryptoSource;
    this.key = KEY_PREFIX + deviceId;
    // Иначе во время ожидания шифрования можно заменить storage/key и выйти из
    // очереди сериализации, выбранной при вызове enqueueSnapshot.
    Object.freeze(this);
  }

  #read() {
    requireCertain(this.storage, this.key);
    let raw;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      throw new Error('Не удалось прочитать очередь синхронизации');
    }
    if (raw === null) {
      return { format: FORMAT, version: VERSION, deviceId: this.deviceId, datasetId: this.datasetId, entries: [] };
    }
    if (typeof raw !== 'string' || raw.length > MAX_SERIALIZED_CHARS)
      throw new Error('Очередь синхронизации повреждена');
    let parsed;
    try {
      parsed = JSON.parse(raw);
      // Наш писатель создаёт только компактный JSON.stringify. Иная форма может
      // скрывать повторные ключи, которые JSON.parse молча отбросит при перезаписи.
      if (JSON.stringify(parsed) !== raw) throw new Error('invalid');
    } catch {
      throw new Error('Очередь синхронизации повреждена');
    }
    return validateState(parsed, this.deviceId, this.datasetId);
  }

  #write(state) {
    requireCertain(this.storage, this.key);
    const raw = JSON.stringify(state);
    if (raw.length > MAX_SERIALIZED_CHARS) throw new Error('Очередь синхронизации заполнена');
    try {
      this.storage.setItem(this.key, raw);
      if (this.storage.getItem(this.key) !== raw) throw uncertainError();
    } catch {
      // Исключение или несовпадение после setItem не доказывает, что записи не было.
      // Нельзя слепо повторять, очищать или продолжать отправку из этой очереди.
      markUncertain(this.storage, this.key);
      throw uncertainError();
    }
  }

  /**
   * Создаёт зашифрованную версию и сохраняет её в очереди. Входной снимок фиксируется
   * до первого await; несколько одновременных вызовов сохраняются в порядке вызовов.
   * @param {{ snapshot?: any, recoveryKey?: string, versionId?: string }} [options]
   */
  enqueueSnapshot({ snapshot, recoveryKey, versionId } = {}) {
    const encrypted = encryptSnapshot({
      snapshot,
      recoveryKey,
      datasetId: this.datasetId,
      versionId,
      cryptoSource: this.cryptoSource
    }).then(
      value => ({ value }),
      error => ({ error })
    );
    return exclusive(this.storage, this.key, async () => {
      const result = await encrypted;
      if ('error' in result) throw result.error;
      const state = this.#read();
      if (state.entries.length >= MAX_ENTRIES) throw new Error('Очередь синхронизации заполнена');
      if (state.entries.some(entry => entry.versionId === versionId)) {
        throw new Error('Эта версия уже находится в очереди');
      }
      state.entries.push(result.value);
      this.#write(state);
      return { versionId, pending: state.entries.length };
    });
  }

  /** Получает копию зашифрованных ожидающих версий без исходных данных и ключа. */
  list() {
    return exclusive(this.storage, this.key, () => this.#read().entries);
  }

  /**
   * Убирает только точно совпадающую версию. Это НЕ проверяет облако: вызывающая сторона
   * обязана сначала получить подтверждение провайдера и сверить именно это содержимое.
   * Таймаут или неизвестный ответ не является подтверждением.
   */
  acknowledgeConfirmed(envelope) {
    // Забираем именно значения собственных data-descriptor до ожидания. Нельзя
    // проверять descriptor, а затем читать поля через Proxy/getter повторно.
    const expected = object(envelope, ENVELOPE_KEYS, ['keyCapsule']);
    validateEnvelope(expected);
    return exclusive(this.storage, this.key, () => {
      const state = this.#read();
      const index = state.entries.findIndex(item => item.versionId === expected.versionId);
      if (index < 0) return false;
      if (!sameEnvelope(state.entries[index], expected))
        throw new Error('Подтверждённая версия не совпадает с очередью');
      state.entries.splice(index, 1);
      this.#write(state);
      return true;
    });
  }
}
