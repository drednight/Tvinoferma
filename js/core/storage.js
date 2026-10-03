// @ts-check
// js/core/storage.js

import { serializeState } from './state.js';
import { tauriAdapter } from './storageAdapters/tauriAdapter.js';
import { localStorageAdapter } from './storageAdapters/localStorageAdapter.js';
import { prepareForDisk } from './secrets.js';

export const isTauri = () => {
  const w = /** @type {any} */ (window);
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__);
};

/**
 * Выбирает подходящий адаптер в зависимости от окружения.
 * Внутри Tauri — файл через Rust, в браузере (dev mode) — LocalStorage.
 */
export function getAdapter() {
  return isTauri() ? tauriAdapter : localStorageAdapter;
}

// Записи выстраиваются в очередь: параллельные persist() из фоновых скриптов
// не перемешиваются, а несколько вызовов подряд схлопываются в одну запись.
let writeChain = Promise.resolve();
let pending = null;

async function writeNow() {
  const data = await prepareForDisk(serializeState());
  await getAdapter().saveState(data);
}

/**
 * Сохраняет текущее состояние в хранилище.
 * ВАЖНО: Не вызывает автоматический рендеринг UI!
 * Это критически важно для работы чекбоксов в таблице марафонов.
 */
export function persist() {
  if (pending) return pending;
  pending = writeChain = writeChain
    .catch(() => {})
    .then(() => {
      pending = null;
      return writeNow();
    })
    .catch((error) => {
      console.error('[STORAGE] Failed to save state:', error);
      throw error; // Пробрасываем ошибку выше, чтобы обработчик клика мог сделать откат
    });
  return pending;
}

/**
 * Принудительное сохранение с немедленным обновлением всех разделов.
 * Используется при импорте/экспорте/смене таба/создании сущностей.
 */
export async function forceRenderAndPersist() {
  await persist();

  // Динамические импорты, чтобы избежать циклических зависимостей при старте
  const { renderCharacters } = await import('../modules/characters/list.js');
  const { renderParties } = await import('../modules/parties/index.js');
  const { renderMarathons } = await import('../modules/marathons/page.js');

  renderCharacters();
  renderParties();
  renderMarathons();
}

/** Мгновенное сохранение (дожидается очереди записей). */
export async function saveNow() {
  await persist();
}

/** Загрузка данных из хранилища. */
export async function loadData() {
  return await getAdapter().loadState();
}

/** Резервная копия с учётом настроек ротации. */
export async function createBackup(label) {
  const { state } = await import('./state.js');
  return getAdapter().createBackup({ maxCount: state.settings?.backups?.maxCount ?? 10, label });
}
