// js/modules/launcher/runningWindows.js
// Общий кэш запущенных окон игры: один опрос Rust на приложение, а не на каждую карточку.
//
// Зачем: список окон нужен сразу в нескольких местах — кнопке закрытия окна в карточке персонажа,
// блоку «Запущенные окна» на вкладке «Сегодня», окну выбора окон. Список оконённых приходит
// только из Rust (`launcher_running_details`), а разметка карточек строится синхронно, поэтому
// берём последний известный ответ и обновляем его по событию.
//
// Модуль не знает про DOM: подписчики сами решают, что перерисовать.

import { state } from '../../core/state.js';
import { windowRows } from './windowList.js';

/** @type {Array<any>} последние известные строки окон (около 1–10 штук) */
let rows = [];
/** @type {number} когда обновляли (мс с 1970); 0 — ещё ни разу */
let updatedAt = 0;
/** @type {Set<(rows: Array<any>) => void>} */
const listeners = new Set();
/** @type {Promise<Array<any>> | null} обновление уже идёт: параллельные вызовы ждут его */
let inflight = null;

/** Строки последнего опроса (без нового обращения к Rust). */
export function runningWindows() {
  return rows;
}

/** Есть ли окно у персонажа. */
export function windowOfCharacter(charId) {
  if (!charId) return null;
  return rows.find(r => r.known && r.charId === charId) || null;
}

/** Подписка на изменения списка. Возвращает функцию отписки. */
export function onRunningWindows(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach(fn => {
    try {
      fn(rows);
    } catch (e) {
      console.error('[WINDOWS] listener failed:', e);
    }
  });
}

/**
 * Опросить запущенные окна и раздать результат подписчикам.
 * Параллельные вызовы не дублируют запрос к Rust: все ждут один и тот же.
 * Ошибка не блокирует интерфейс: в этом случае остаётся прежний список.
 * @returns {Promise<Array<any>>}
 */
export async function refreshRunningWindows() {
  if (inflight) return inflight;
  inflight = (async () => {
    const { runningClientDetails } = await import('./launch.js');
    try {
      const clients = await runningClientDetails();
      rows = windowRows(clients, state.characters);
      updatedAt = Date.now();
      notify();
    } catch (e) {
      console.warn('[WINDOWS] не удалось получить список окон:', e);
    } finally {
      inflight = null;
    }
    return rows;
  })();
  return inflight;
}

/** Когда последний раз обновляли (мс с 1970; 0 — ни разу). Для подписей в интерфейсе. */
export function runningWindowsUpdatedAt() {
  return updatedAt;
}

/**
 * Список устарел (окна могли открыться или закрыться, пока вкладка была неактивна).
 * @param {number} maxAgeMs
 */
export function runningWindowsStale(maxAgeMs = 30000) {
  return !updatedAt || Date.now() - updatedAt > maxAgeMs;
}
