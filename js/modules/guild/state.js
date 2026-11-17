// js/modules/guild/state.js
// Флаг скрытой страницы и кэш сводки кланового сайта.
//
// Флаг живёт в settings.guild.enabled и выключен у всех. Его переключает только
// пасхалка в разделе промокодов — в настройках страницы нет намеренно.

import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { normalizeGuildData } from './core.js';
import { normalizePendingPollVotes } from './pollVoteQueue.js';

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
  const { enabled, pendingResponses, pendingPollVotes, leaderOverrides } = guildSettings();
  state.settings.guild = {
    ...normalizeGuildData({ ...data, leaderOverrides: leaderOverrides || [] }),
    pendingResponses: pendingResponses || [],
    pendingPollVotes: pendingPollVotes || [],
    syncedAt: Date.now(),
    ...(enabled !== undefined ? { enabled } : {})
  };
  await persist();
}

/** Durable local intentions; never advance syncedAt or write them into the verified report. */
export function readPendingResponses() {
  return guildSettings().pendingResponses || [];
}
export async function writePendingResponses(pendingResponses) {
  state.settings.guild = { ...guildSettings(), pendingResponses };
  await persist();
}

/** Локальный выбор в опросах: показывается сразу, отправка — отложенный фоновый шаг. */
export function readPendingPollVotes() {
  return normalizePendingPollVotes(guildSettings().pendingPollVotes);
}
export async function writePendingPollVotes(pollVotes) {
  state.settings.guild = { ...guildSettings(), pendingPollVotes };
  await persist();
}

/** Display-only local leader choice; never changes the clan website or game leadership. */
export async function setGuildLeaderOverride(partyName, nick) {
  const current = readGuildData();
  const matches = current.parties.filter(party => party.name === partyName);
  if (matches.length !== 1 || (nick && !matches[0].members.some(member => member.nick === nick)))
    throw new Error('Пати или участник изменились. Обновите список.');
  const leaderOverrides = current.leaderOverrides.filter(row => row.party !== partyName);
  if (nick) leaderOverrides.push({ party: partyName, nick });
  const previous = state.settings.guild;
  state.settings.guild = { ...previous, leaderOverrides };
  try {
    await persist();
  } catch (error) {
    state.settings.guild = previous;
    throw error;
  }
}
