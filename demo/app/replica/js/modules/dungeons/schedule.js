// js/modules/dungeons/schedule.js
// Циклический календарь данжей (issue #30): ежедневное задание меняется по циклу
// Реликвия → Оружие → Доспех → Реликвия → … (повтор каждые 3 дня).
//
// Опорная дата известна из игры: 2026-10-06 был данж «Оружие» (07.10 — Доспех, 08.10 — Реликвия,
// 09.10 — снова Оружие). Все прочие даты — до и после — считаются от неё по остатку деления,
// поэтому расписание работает на любой день без настроек.
// Раньше опорой было 2026-06-10: с тех пор игра сдвинула цикл на день, и календарь стал опережать игру.
// Если сдвиг повторится — достаточно обновить ANCHOR_DATE.
//
// Модуль без DOM: на вход даты, на выход данные для показа. Поэтому он покрыт тестами.

import { mskAddDays } from '../../core/msk.js';

/** Порядок цикла. Их же ключи проходок (`char.dungeonPasses`). */
export const DUNGEON_CYCLE = ['relic', 'weapon', 'armor'];

export const DUNGEON_NAMES = { weapon: 'Оружие', armor: 'Доспех', relic: 'Реликвия' };

export const DUNGEON_ICONS = { weapon: '⚔️', armor: '🛡️', relic: '💎' };

/** Цвет категории (класс модификатора): Оружие — красный, Доспех — зелёный, Реликвия — синий. */
export const DUNGEON_COLORS = { weapon: 'red', armor: 'green', relic: 'blue' };

/**
 * Опорная дата: в этот день ежедневное задание было «Оружие».
 * Ключ опорного данжа задаёт, где в цикле стоит дата.
 */
export const ANCHOR_DATE = '2026-10-06';
export const ANCHOR_DUNGEON = 'weapon';

/** Разница в днях между датами (без часовых поясов: обе строки «ГГГГ-ММ-ДД»). */
export function daysBetween(dateA, dateB) {
  const a = new Date(`${dateA}T00:00:00`).getTime();
  const b = new Date(`${dateB}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** Сдвиг даты на n дней (n может быть отрицательным). Календарная арифметика без часовых поясов. */
export function shiftDate(date, n) {
  return mskAddDays(date, n);
}

/**
 * Ключ данжа дня. Остаток деления на длину цикла, корректный и для прошедших дат:
 * сдвиг от опорного данжа, а не от первого элемента списка.
 */
export function dungeonForDate(date) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : null;
  if (!d) return null;
  const shift = daysBetween(ANCHOR_DATE, d) + DUNGEON_CYCLE.indexOf(ANCHOR_DUNGEON);
  const idx = ((shift % DUNGEON_CYCLE.length) + DUNGEON_CYCLE.length) % DUNGEON_CYCLE.length;
  return DUNGEON_CYCLE[idx];
}

/** Данж дня с подписями: { key, name, icon, color, date }. */
export function dungeonInfoForDate(date) {
  const key = dungeonForDate(date);
  if (!key) return null;
  return { key, name: DUNGEON_NAMES[key], icon: DUNGEON_ICONS[key], color: DUNGEON_COLORS[key], date };
}

/** Полоса данжей на диапазон дат (включительно): [{ date, key, name, icon, color }]. */
export function dungeonStrip(startDate, endDate) {
  const out = [];
  if (!startDate || !endDate || startDate > endDate) return out;
  for (let d = startDate; d <= endDate; d = shiftDate(d, 1)) {
    out.push(dungeonInfoForDate(d));
  }
  return out;
}

/** Сколько проходок данного типа у персонажей (сумма по выборке). */
export function passesCount(characters, key) {
  return (characters || []).reduce((sum, c) => sum + (Number(c?.dungeonPasses?.[key]) || 0), 0);
}
