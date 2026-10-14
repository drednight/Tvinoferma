// js/modules/characters/orderStore.js
// Хранение настроек списка «Персонажи»: свой порядок карточек и выбранные режимы
// группировки и сортировки. Хранится в localStorage (как выбор во входе): это настройки вида,
// а не данные персонажей, поэтому схема state.json не меняется.

import { GROUP_NONE, ORDER_NICK } from './grouping.js';

const ORDER_KEY = 'tvinoferma-characters-order-v1';
const PREFS_KEY = 'tvinoferma-characters-view-v1';

function read(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — порядок просто не запомнится */
  }
}

/** Свой порядок: массив id персонажей. Пустой — порядок не задан. */
export function getManualOrder() {
  const value = read(ORDER_KEY, []);
  return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
}

/** @param {string[]} ids */
export function saveManualOrder(ids) {
  write(ORDER_KEY, [...new Set(ids)]);
}

/** Сбрасывает свой порядок: карточки снова идут по нику. */
export function resetManualOrder() {
  try {
    globalThis.localStorage?.removeItem(ORDER_KEY);
  } catch {
    /* ничего не делаем */
  }
}

export function hasManualOrder() {
  return getManualOrder().length > 0;
}

/**
 * Выбранные режимы списка.
 * @returns {{ group: string, order: string }}
 */
export function getViewPrefs() {
  const value = read(PREFS_KEY, {});
  return {
    group: value.group || GROUP_NONE,
    order: value.order || ORDER_NICK
  };
}

/** @param {Partial<{ group: string, order: string }>} patch */
export function saveViewPrefs(patch) {
  write(PREFS_KEY, { ...getViewPrefs(), ...patch });
}
