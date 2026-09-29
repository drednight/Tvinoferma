// js/storage.js

import { serializeState } from './state.js';
// Импортируем адаптеры из правильной папки /storageAdapters/
import { tauriAdapter } from './storageAdapters/tauriAdapter.js';
import { localStorageAdapter } from './storageAdapters/localStorageAdapter.js';

/**
 * Выбирает подходящий адаптер в зависимости от окружения.
 * Если мы внутри Tauri — используем файловую систему.
 * Если в браузере (dev mode) — используем LocalStorage.
 */
export function getAdapter() {
  // Проверка наличия глобальных объектов Tauri
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
    return tauriAdapter;
  }
  return localStorageAdapter;
}

/**
 * Сохраняет текущее состояние в хранилище.
 * ВАЖНО: Не вызывает автоматический рендеринг UI!
 * Это критически важно для работы чекбоксов в таблице марафонов.
 */
export async function persist() {
  const adapter = getAdapter();
  if (!adapter) {
    console.warn('[STORAGE] No adapter found, skipping save.');
    return;
  }

  try {
    const data = serializeState();
    await adapter.saveState(data);
    console.log('[STORAGE] State saved successfully.');
  } catch (error) {
    console.error('[STORAGE] Failed to save state:', error);
    throw error; // Пробрасываем ошибку выше, чтобы обработчик клика мог сделать откат
  }
}

/**
 * Принудительное сохранение с немедленным обновлением всех разделов.
 * Используется при импорте/экспорте/смене таба/создании сущностей.
 */
export async function forceRenderAndPersist() {
  await persist();
  
  // Динамические импорты, чтобы избежать циклических зависимостей при старте
  
  // 1. Персонажи
  const { renderCharacters } = await import('./characters.js');
  
  // 2. Пати (ИСПРАВЛЕНО: теперь импортируем из index.js внутри папки parties)
  const { renderParties } = await import('./parties/index.js'); 
  
  // 3. Марафоны
  const { renderMarathons } = await import('./marathon.js');
  
  renderCharacters();
  renderParties();
  renderMarathons();
}

/**
 * Мгновенное сохранение (без ожидания debounce, если он есть).
 */
export async function saveNow() {
  const adapter = getAdapter();
  if (!adapter) return;
  await adapter.saveState(serializeState());
}

/**
 * Загрузка данных из хранилища.
 */
export async function loadData() {
  const adapter = getAdapter();
  if (!adapter) return null;
  return await adapter.loadState();
}