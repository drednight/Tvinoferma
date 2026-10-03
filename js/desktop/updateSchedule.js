// js/desktop/updateSchedule.js
// Расписание автопроверки обновлений (issue #83). Чистые функции без Tauri и DOM: легко тестировать.
//
// Режимы (settings.updates.mode):
//   startup — один раз при запуске приложения
//   daily   — каждый день в 00:00 (по местному времени); если приложение было закрыто, проверка при запуске
//   weekly  — каждый понедельник в 00:00; если приложение было закрыто, проверка при запуске
//   never   — автопроверка выключена (кнопка «Проверить обновления» работает всегда)

export const UPDATE_MODES = ['startup', 'daily', 'weekly', 'never'];

export const UPDATE_MODE_LABEL = {
  startup: 'при запуске программы',
  daily: 'ежедневно в 00:00',
  weekly: 'еженедельно (понедельник, 00:00)',
  never: 'не проверять автоматически'
};

export const isScheduledMode = (mode) => mode === 'daily' || mode === 'weekly';

/**
 * Режим из настроек. Старые данные хранят только флаг checkOnStartup:
 * false → «не проверять», иначе → «при запуске».
 */
export function resolveUpdateMode(settings) {
  const u = settings?.updates || {};
  if (UPDATE_MODES.includes(u.mode)) return u.mode;
  return u.checkOnStartup === false ? 'never' : 'startup';
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
  if (mode === 'never') return 'Автопроверка выключена';
  if (mode === 'startup') return 'Следующая проверка: при следующем запуске';
  const d = nextBoundary(mode, now);
  return `Следующая проверка: ${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}
