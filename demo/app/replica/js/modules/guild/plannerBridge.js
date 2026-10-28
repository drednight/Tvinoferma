// js/modules/guild/plannerBridge.js
// Отмеченные клановые события попадают в календарь приложения.
//
// Своих записей это не трогает: у клановых свой префикс в id (`guild-<id>`), поэтому
// они узнаются и после перезапуска — поля «источник» у записи календаря нет, а лишние
// поля `normalizePlannerEntry` всё равно отбрасывает при загрузке.
//
// Отметка снимается один раз и навсегда: запись заводится на ответ «Пойду» и убирается,
// как только ответ сменился на «Не пойду» или его больше нет. Повторное обновление сводки
// ничего не дублирует.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { normalizePlannerEntry } from '../dashboard/planner.js';
import { isClanEntry, wantedClanEntries } from './core.js';

/**
 * Список записей календаря после сверки с ответами на сайте. Чистая функция:
 * свои записи возвращает как есть, клановые — добавляет, обновляет и убирает.
 * @param {object[]} current записи календаря
 * @param {object} data сводка клана
 * @param {string} [today] «ГГГГ-ММ-ДД» по Москве, по умолчанию — сегодня
 * @returns {{ entries: object[], changed: boolean }}
 */
export function planClanEntries(current, data, today) {
  const source = Array.isArray(current) ? current : [];
  const wanted = wantedClanEntries(data, today);
  const kept = [];
  let changed = false;

  for (const entry of source) {
    if (!isClanEntry(entry)) {
      kept.push(entry);
      continue;
    }
    const next = wanted.get(entry.id);
    wanted.delete(entry.id);
    if (!next) {
      changed = true;
      continue;
    }
    // Дату и время ведёт сайт. Всё остальное (цвет, статус, длительность) — дело человека:
    // трогаем только расписание, иначе правки календаря затирались бы на каждой синхронизации.
    if (entry.date === next.date && entry.time === next.time) {
      kept.push(entry);
      continue;
    }
    kept.push(normalizePlannerEntry({ ...entry, date: next.date, time: next.time }));
    changed = true;
  }

  for (const entry of wanted.values()) {
    kept.push(normalizePlannerEntry(entry));
    changed = true;
  }

  return { entries: changed ? kept : source, changed };
}

/**
 * Сверяет календарь с ответами на сайте и сохраняет, если что-то изменилось.
 * @returns {Promise<boolean>} изменился ли календарь — тогда пора его перерисовать
 */
export async function syncClanEntries(data) {
  const { entries, changed } = planClanEntries(state.plannerEntries, data);
  if (!changed) return false;
  state.plannerEntries = entries;
  await persist();
  return true;
}
