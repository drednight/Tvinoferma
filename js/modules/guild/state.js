// js/modules/guild/state.js
// Флаг скрытой страницы и кэш сводки кланового сайта.
//
// Флаг живёт в settings.guild.enabled и выключен у всех. Его переключает только
// пасхалка в разделе промокодов — в настройках страницы нет намеренно.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { normalizeGuildData } from './core.js';

/** Раздел настроек клана; создаётся при первом обращении. */
function guildSettings() {
  state.settings = state.settings || {};
  return state.settings.guild || {};
}

/** Включена ли скрытая страница кланового сайта. */
export function guildEnabled() {
  return guildSettings().enabled === true;
}

/** Переключает страницу. Возвращает новое состояние. */
export async function toggleGuild() {
  const next = !guildEnabled();
  state.settings.guild = { ...guildSettings(), enabled: next };
  await persist();
  return next;
}

/** Кэш сводки со страницы профиля. */
export function readGuildData() {
  return normalizeGuildData(guildSettings());
}

/**
 * Запоминает сводку. `syncedAt` ставим здесь, чтобы не зависеть от часов окна браузера.
 * Раздел переписываем целиком: в нём только флаг и кэш, старые поля вроде `lastAutoAt`
 * от прежней схемы обновления не должны в нём копиться.
 */
export async function writeGuildData(data) {
  const { enabled } = guildSettings();
  state.settings.guild = {
    ...normalizeGuildData(data),
    syncedAt: Date.now(),
    ...(enabled !== undefined ? { enabled } : {})
  };
  await persist();
}
