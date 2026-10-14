// js/modules/eternals/state.js
// Флаг скрытой страницы и кэш сводки кланового сайта.
//
// Флаг живёт в settings.eternals.enabled и выключен у всех. Его переключает только
// пасхалка в разделе промокодов — в настройках страницы нет намеренно.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { normalizeEternalsData } from './core.js';

/** Раздел настроек клана; создаётся при первом обращении. */
function eternalsSettings() {
  state.settings = state.settings || {};
  return state.settings.eternals || {};
}

/** Включена ли скрытая страница кланового сайта. */
export function eternalsEnabled() {
  return eternalsSettings().enabled === true;
}

/** Переключает страницу. Возвращает новое состояние. */
export async function toggleEternals() {
  const next = !eternalsEnabled();
  state.settings.eternals = { ...eternalsSettings(), enabled: next };
  await persist();
  return next;
}

/** Кэш сводки со страницы профиля. */
export function readEternalsData() {
  return normalizeEternalsData(eternalsSettings());
}

/**
 * Запоминает сводку. `syncedAt` ставим здесь, чтобы не зависеть от часов окна браузера.
 * Раздел переписываем целиком: в нём только флаг и кэш, старые поля вроде `lastAutoAt`
 * от прежней схемы обновления не должны в нём копиться.
 */
export async function writeEternalsData(data) {
  const { enabled } = eternalsSettings();
  state.settings.eternals = {
    ...normalizeEternalsData(data),
    syncedAt: Date.now(),
    ...(enabled !== undefined ? { enabled } : {})
  };
  await persist();
}
