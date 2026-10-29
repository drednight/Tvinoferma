// @ts-check
// js/core/storageAdapters/localStorageAdapter.js

import { uncertainStateWriteError } from '../stateWriteOutcome.js';
import { createStateReadWitness } from './stateReadWitness.js';
import { createBackupReviewStore, describeBrowserBackup } from './backupReview.js';

const readWitness = createStateReadWitness();
const backupReviews = createBackupReviewStore();
const STORAGE_KEY = 'tvinoferma_state_v1';
const BACKUP_PREFIX = 'tvinoferma_backup_';

function backupKeys() {
  return Object.keys(localStorage)
    .filter(key => key.startsWith(BACKUP_PREFIX))
    .sort()
    .reverse();
}

function validBackupKey(key) {
  return typeof key === 'string' && key.startsWith(BACKUP_PREFIX) && key.length > BACKUP_PREFIX.length;
}

// Сохранение и проверка происходят без await. Это исключает вмешательство другого
// кода в том же JS-контексте, но НЕ является блокировкой другой вкладки или процесса.
function backupRaw(raw, { maxCount = 10, rotate = true } = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseKey = `${BACKUP_PREFIX}${timestamp}`;
  const existing = Object.keys(localStorage).filter(key => key === baseKey || key.startsWith(`${baseKey}-`));
  const sequence = existing.reduce((max, key) => {
    const suffix = key.slice(baseKey.length + 1);
    const match = /^(\d+)(?:-[0-9a-f]{32})?$/.exec(suffix);
    const value = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(value)) throw new Error('Не удалось создать имя резервной копии');
    return Math.max(max, value);
  }, 0);
  if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Не удалось создать имя резервной копии');
  let nonce;
  try {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    nonce = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw new Error('Не удалось создать имя резервной копии');
  }
  // Случайный суффикс снижает риск совпадения имён в разных вкладках. Сам по
  // себе он не является межвкладочной блокировкой или гарантией от гонок ротации.
  const next = existing.length ? sequence + 1 : 0;
  const backupKey = `${baseKey}-${String(next).padStart(6, '0')}-${nonce}`;
  if (localStorage.getItem(backupKey) !== null) throw new Error('Не удалось создать уникальную резервную копию');
  localStorage.setItem(backupKey, raw);
  if (localStorage.getItem(backupKey) !== raw || localStorage.getItem(STORAGE_KEY) !== raw) {
    // Ошибочную запись не считаем копией и стараемся убрать её без ротации прежних.
    try {
      localStorage.removeItem(backupKey);
    } catch {
      // Хранилище может оказаться недоступным; старые копии не трогаем.
    }
    throw new Error('Не удалось проверить резервную копию или данные изменились');
  }
  if (rotate) {
    const limit = Number.isFinite(Number(maxCount)) ? Math.max(1, Math.floor(Number(maxCount))) : 10;
    // Проверенная копия защищена от ротации при совпадении времени или переводе часов.
    backupKeys()
      .filter(key => key !== backupKey)
      .slice(limit - 1)
      .forEach(key => localStorage.removeItem(key));
  }
  return backupKey;
}

export const localStorageAdapter = {
  /**
   * Сохраняет состояние в LocalStorage
   */
  async saveState(data) {
    // Serialization fails before any storage write; after setItem is attempted,
    // a failed call or readback cannot be treated as proof of the old value.
    const jsonContent = JSON.stringify(data);
    try {
      localStorage.setItem(STORAGE_KEY, jsonContent);
      if (localStorage.getItem(STORAGE_KEY) !== jsonContent) throw uncertainStateWriteError();
      return true;
    } catch {
      throw uncertainStateWriteError();
    }
  },

  /**
   * Загружает состояние из LocalStorage
   */
  async loadState() {
    let jsonString;
    try {
      jsonString = localStorage.getItem(STORAGE_KEY);
    } catch {
      throw new Error('Не удалось прочитать сохранённые данные браузера');
    }
    if (jsonString === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      throw new Error('Сохранённые данные браузера повреждены');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Сохранённые данные браузера имеют неверный формат');
    }
    readWitness.remember(parsed, jsonString);
    return parsed;
  },

  /**
   * Копия точного загруженного состояния без ротации. Проверка и копирование идут
   * без await в этой вкладке, но другая вкладка или процесс не заблокированы.
   */
  async createMigrationBackup(snapshot) {
    const raw = readWitness.rawFor(snapshot);
    if (localStorage.getItem(STORAGE_KEY) !== raw) {
      throw new Error('Исходные данные изменились; миграция остановлена');
    }
    return backupRaw(raw, { rotate: false });
  },

  /** Заменяем только совпадающее исходное состояние; это не межвкладочный CAS. */
  async saveMigratedState(snapshot, data) {
    const raw = readWitness.rawFor(snapshot);
    const jsonContent = JSON.stringify(data);
    if (localStorage.getItem(STORAGE_KEY) !== raw) {
      throw new Error('Исходные данные изменились; миграция остановлена');
    }
    try {
      localStorage.setItem(STORAGE_KEY, jsonContent);
      if (localStorage.getItem(STORAGE_KEY) !== jsonContent) throw uncertainStateWriteError();
      return true;
    } catch {
      throw uncertainStateWriteError();
    }
  },

  forgetLoadedState(snapshot) {
    readWitness.forget(snapshot);
  },

  /**
   * Имитация пути к данным (так как его нет в браузере)
   */
  async getDataDir() {
    return 'Browser LocalStorage (virtual)';
  },

  /**
   * Создание бэкапа (сохранение отдельной записи с таймстампом)
   */
  async createBackup({ maxCount = 10 } = {}) {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) throw new Error('Нет данных для резервной копии');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Текущие данные повреждены; копия не создана');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Некорректное состояние; копия не создана');
    }
    return backupRaw(raw, { maxCount });
  },

  /**
   * Список бэкапов
   */
  async listBackups() {
    return backupKeys();
  },

  /** Preview only; raw values stay in this adapter's one-use memory witness. */
  async inspectBackup(backupKey) {
    if (!validBackupKey(backupKey)) throw new Error('Некорректное имя резервной копии');
    try {
      const backupRaw = localStorage.getItem(backupKey);
      if (backupRaw === null) throw new Error('missing');
      const parsed = JSON.parse(backupRaw);
      const currentRaw = localStorage.getItem(STORAGE_KEY);
      return backupReviews.remember(backupKey, describeBrowserBackup(parsed, currentRaw), { backupRaw, currentRaw });
    } catch {
      throw new Error('Не удалось проверить выбранную копию; обновите список и попробуйте снова');
    }
  },

  forgetBackupInspection(inspection) {
    backupReviews.forget(inspection);
  },

  /**
   * Восстановление из бэкапа. Проверка не является межвкладочной блокировкой или CAS.
   */
  async restoreBackup(backupKey, inspection) {
    if (!validBackupKey(backupKey)) throw new Error('Некорректное имя резервной копии');
    const reviewed = inspection === undefined ? null : backupReviews.take(backupKey, inspection);
    const dataJson = localStorage.getItem(backupKey);
    if (dataJson === null) throw new Error('Резервная копия не найдена');
    let parsed;
    try {
      parsed = JSON.parse(dataJson);
    } catch {
      throw new Error('Резервная копия повреждена');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Резервная копия не содержит состояние приложения');
    }
    const previous = localStorage.getItem(STORAGE_KEY);
    if (reviewed && (reviewed.backupRaw !== dataJson || reviewed.currentRaw !== previous)) {
      throw new Error('Данные или выбранная копия изменились после просмотра; восстановление остановлено');
    }
    // Сохраняем даже повреждённый текущий файл для ручного восстановления. Если
    // сохранение или проверка копии не удались, исходное состояние не заменяем.
    if (previous !== null) backupRaw(previous, { rotate: false });
    if (localStorage.getItem(backupKey) !== dataJson || localStorage.getItem(STORAGE_KEY) !== previous) {
      throw new Error('Данные изменились; восстановление остановлено');
    }
    // Once the replacement is attempted, neither an exception nor a failed
    // readback is proof that the old value is still present. Stop callers from
    // blindly writing their in-memory state over an uncertain result.
    try {
      localStorage.setItem(STORAGE_KEY, dataJson);
      if (localStorage.getItem(STORAGE_KEY) !== dataJson) throw uncertainStateWriteError();
    } catch {
      throw uncertainStateWriteError();
    }
    return true;
  },

  /**
   * Удаление бэкапа
   */
  async deleteBackup(backupKey) {
    if (!validBackupKey(backupKey)) throw new Error('Некорректное имя резервной копии');
    localStorage.removeItem(backupKey);
    return true;
  }
};
