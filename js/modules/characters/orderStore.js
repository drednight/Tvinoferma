// js/modules/characters/orderStore.js
// Хранение настроек списка «Персонажи»: свой порядок карточек, сохранённые порядки
// под своими именами и выбранные режимы группировки и сортировки. Хранится в localStorage
// (как выбор во входе): это настройки вида, а не данные персонажей, поэтому схема
// state.json не меняется.

import { GROUP_NONE, ORDER_NICK } from './grouping.js';

const ORDER_KEY = 'tvinoferma-characters-order-v1';
const PREFS_KEY = 'tvinoferma-characters-view-v1';
const PRESETS_KEY = 'tvinoferma-characters-orders-v1';

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

/* ---------------------------------------------------------------------------
   Сохранённые порядки под своими именами
   ---------------------------------------------------------------------------
   Свой порядок один и «живой»: перетаскивание карточек пишет в него. Порядков,
   между которыми переключаются туда-сюда, может быть много — например, «Для рейда»
   и «Для передачи». Хранятся рядом, но не вместо: выбранный порядок всегда
   копируется в `ORDER_KEY`, поэтому перетаскивание работает одинаково при любом
   выборе, а сохранённый порядок остаётся нетронутым снимком.
   --------------------------------------------------------------------------- */

/** Префикс значения в списке порядка: `preset:<id>`. */
export const PRESET_PREFIX = 'preset:';

const newPresetId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Сохранённые порядки: `[{ id, name, ids }]`, по порядку создания.
 * @returns {Array<{ id: string, name: string, ids: string[] }>}
 */
export function listOrderPresets() {
  const value = read(PRESETS_KEY, []);
  if (!Array.isArray(value)) return [];
  return value
    .filter(p => p && typeof p === 'object' && p.id && p.name)
    .map(p => ({ id: String(p.id), name: String(p.name), ids: Array.isArray(p.ids) ? p.ids.filter(x => typeof x === 'string') : [] }));
}

/** Значение для `<option>`; пустое — такого порядка больше нет. */
export function presetValue(id) {
  return `${PRESET_PREFIX}${id}`;
}

/** Порядок по значению из списка; `null`, если это не сохранённый порядок. */
export function presetIdFromValue(value) {
  const raw = String(value || '');
  return raw.startsWith(PRESET_PREFIX) ? raw.slice(PRESET_PREFIX.length) : null;
}

/**
 * Сохраняет порядок под именем.
 *
 * Если имя уже занято, старый порядок заменяется, а не появляется второй: два порядка
 * с одинаковым именем в списке выглядели бы как ошибка, и человек не смог бы понять,
 * какой из них выбрал.
 *
 * @param {string} name
 * @param {string[]} ids
 * @returns {{ id: string, name: string, ids: string[], replaced: boolean }}
 */
export function saveOrderPreset(name, ids) {
  const clean = String(name || '').trim().slice(0, 40);
  const presets = listOrderPresets();
  const list = [...new Set((ids || []).filter(id => typeof id === 'string'))];
  if (!clean) throw new Error('Пустое имя');
  if (!list.length) throw new Error('Порядок пустой');
  const same = presets.find(p => p.name.toLowerCase() === clean.toLowerCase());
  const item = { id: same?.id || newPresetId(), name: clean, ids: list };
  write(PRESETS_KEY, [...presets.filter(p => p.id !== item.id), item]);
  return { ...item, replaced: !!same };
}

/**
 * Удаляет сохранённый порядок.
 * @returns {boolean} был ли он вообще
 */
export function deleteOrderPreset(id) {
  const presets = listOrderPresets();
  const next = presets.filter(p => p.id !== id);
  if (next.length === presets.length) return false;
  write(PRESETS_KEY, next);
  return true;
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

/** Есть ли что сохранять под именем: пустой «свой порядок» сохранять не о чем. */
export function canSaveOrder() {
  return getManualOrder().length > 0;
}
