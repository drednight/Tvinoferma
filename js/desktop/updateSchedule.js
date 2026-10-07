// js/desktop/updateSchedule.js
// Расписание автопроверки обновлений (issue #83). Чистые функции без Tauri и DOM: легко тестировать.
//
// Режимы (settings.updates.mode):
//   startup — один раз при запуске приложения
//   daily   — каждый день в 00:00 (по московскому времени); если приложение было закрыто, проверка при запуске
//   weekly  — каждый понедельник в 00:00; если приложение было закрыто, проверка при запуске
// При запуске проверка обязательна для всех режимов; старый never читается как startup.

import { mskStamp } from '../core/msk.js';

export const UPDATE_MODES = ['startup', 'daily', 'weekly'];

export const UPDATE_MODE_LABEL = {
  startup: 'только при запуске программы',
  daily: 'при запуске и ежедневно в 00:00',
  weekly: 'при запуске и еженедельно (понедельник, 00:00)'
};

export const isScheduledMode = (mode) => mode === 'daily' || mode === 'weekly';

/**
 * Режим из настроек. Старые данные хранят только флаг checkOnStartup:
 * Флаг checkOnStartup больше не отключает обязательную проверку при запуске.
 */
export function resolveUpdateMode(settings) {
  const u = settings?.updates || {};
  if (UPDATE_MODES.includes(u.mode)) return u.mode;
  return 'startup';
}

/** Последняя плановая граница не позже now: сегодняшняя полночь или понедельник 00:00. */
export function lastBoundary(mode, now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (mode === 'weekly') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** Ближайшая плановая граница строго после now. */
export function nextBoundary(mode, now = new Date()) {
  const d = lastBoundary(mode, now);
  d.setDate(d.getDate() + (mode === 'weekly' ? 7 : 1));
  return d;
}

/** Пора ли проверять: для daily/weekly — если с последней границы проверки не было. */
export function isCheckDue(mode, lastCheckedAt, now = new Date()) {
  if (!isScheduledMode(mode)) return false;
  if (!lastCheckedAt) return true;
  const last = new Date(lastCheckedAt);
  if (Number.isNaN(last.getTime())) return true;
  return last < lastBoundary(mode, now);
}

/** Строка «Следующая проверка: …» для настроек. */
export function nextCheckText(mode, now = new Date()) {
  if (!isScheduledMode(mode)) return 'Следующая проверка: при следующем запуске';
  const d = nextBoundary(mode, now);
  // Время следующей проверки — по Москве: пользователь сверяет его с игровым расписанием
  return `Следующая проверка: ${mskStamp(d)}`;
}
