// @ts-check
// js/core/state/character.js
// Приведение персонажа к схеме — чистые функции, без доступа к общему состоянию.
//
// Вынесено из state.js: нормализация — это место, где чаще всего ломается загрузка
// (потерянное поле, число вместо строки), и проверять её удобно без поднятия всего
// состояния приложения целиком.

import { STATS_HISTORY_LIMIT } from '../../modules/characters/statsHistory.js';
import { DEFAULT_STATS } from '../../modules/characters/stateManager.js';
import { roundCoins, normalizeCoinHistory } from '../coins.js';
import { normalizePartyIds, resolveMainPartyId } from '../../modules/parties/membership.js';

/** Максимальная длина примечания к персонажу (символов). */
export const NOTES_MAX_LENGTH = 5000;

/** Характеристики приводятся к числам: в state.json могли прийти строки или пустые значения. */
export function normalizeStats(input = {}) {
  const stats = {};
  Object.keys({ ...DEFAULT_STATS, ...(input || {}) }).forEach(key => {
    stats[key] = Number(input?.[key]) || 0;
  });
  return stats;
}

/**
 * История характеристик: список снимков `{ at, stats }`.
 * Чужой мусор в state.json отсекаем, число снимков ограничиваем — иначе файл
 * незаметно разрастался бы при каждом сохранении формы.
 */
export function normalizeStatsHistory(input) {
  const list = Array.isArray(input) ? input : [];
  return list
    .filter(entry => entry && typeof entry === 'object' && entry.stats && typeof entry.stats === 'object')
    .slice(0, STATS_HISTORY_LIMIT)
    .map(entry => ({
      at: typeof entry.at === 'string' ? entry.at : null,
      stats: normalizeStats(entry.stats)
    }));
}

/** Теги: строки без лишних пробелов, без дублей (регистр не важен). */
export function normalizeTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set();
  return list
    .map(t =>
      String(t || '')
        .trim()
        .replace(/\s+/g, ' ')
    )
    .filter(t => {
      const key = t.toLowerCase();
      if (!t || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Список id GameCenter: строки без пустых, без дублей. */
export function normalizeGcIds(list) {
  const ids = (Array.isArray(list) ? list : []).map(v => String(v || '').trim()).filter(Boolean);
  return [...new Set(ids)];
}

/** Запомненный вход по каждому GameCenter: `{ [gcId]: { nick, legacy? } }`. */
export function normalizeGcAccounts(map) {
  /** @type {Record<string, { nick: string, legacy?: true }>} */
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [id, v] of Object.entries(map)) {
    if (!id || !v || typeof v !== 'object') continue;
    out[id] = v.legacy === true ? { nick: String(v.nick || ''), legacy: true } : { nick: String(v.nick || '') };
  }
  return out;
}

/**
 * Порядок персонажа внутри пати: `{ [partyId]: номер }`.
 * Номера — целые от 1; мусор и нули отбрасываются, чтобы порядок не сбивался после импорта.
 */
export function normalizePartyOrder(map) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [partyId, value] of Object.entries(map)) {
    const n = Number(value);
    if (!partyId || !Number.isFinite(n) || n < 1) continue;
    out[partyId] = Math.round(n);
  }
  return out;
}

export function normalizeCharacter(input = {}) {
  return {
    id: input.id ? String(input.id) : null, // пустой id назначается из ника в normalizeState
    nick: String(input.nick || ''),
    favorite: input.favorite === true,
    class: String(input.class || ''),
    partyIds: normalizePartyIds(input.partyIds), // id всех партий; миграция v5 переводит старое поле `party`
    mainPartyId: resolveMainPartyId(input.partyIds, input.mainPartyId), // основная пати (входит в partyIds)
    // Порядок внутри пати (перетаскивание на вкладке «Пати»): { [partyId]: номер }
    partyOrder: normalizePartyOrder(input.partyOrder),
    notes: String(input.notes ?? '').slice(0, NOTES_MAX_LENGTH),
    level: Number(input.level) || 1,
    sky: {
      name: input.sky?.name || null,
      level: input.sky?.level ? Number(input.sky.level) : null
    },
    contacts: {
      email: String(input.contacts?.email || ''),
      password: String(input.contacts?.password || ''),
      recoveryEmail: String(input.contacts?.recoveryEmail || ''),
      phone: String(input.contacts?.phone || '')
    },
    // Запуск игры: у каждого аккаунта свой GameCenter (папка или GameCenter.exe)
    launch: {
      gcPath: String(input.launch?.gcPath || '').trim(),
      gcNick: String(input.launch?.gcNick || '').trim(), // ник в GameCenter (для показа); токен входа лежит в хранилище ОС
      gcAccount: input.launch?.gcAccount === true, // вход этого аккаунта запомнен (см. launcher_capture_account)
      // GameCenter из общего списка (Настройки → Запуск игры): id по порядку, первый — основной
      gcIds: normalizeGcIds(input.launch?.gcIds),
      // Запомненный вход персонажа в каждом из них: { [gcId]: { nick, legacy? } }; токены лежат в хранилище ОС
      gcAccounts: normalizeGcAccounts(input.launch?.gcAccounts)
    },
    dungeonPasses: {
      weapon: Number(input.dungeonPasses?.weapon) || 0,
      armor: Number(input.dungeonPasses?.armor) || 0,
      relic: Number(input.dungeonPasses?.relic) || 0
    },

    // Все характеристики из редактора (раньше сохранялись только 7 из них)
    stats: normalizeStats(input.stats),
    // История характеристик: какие значения были до последнего изменения (characters/statsHistory.js).
    // Без неё в профиле не показать «было → стало», а после перезапуска история просто пропала бы
    statsHistory: normalizeStatsHistory(input.statsHistory),
    tags: normalizeTags(input.tags),

    ancientCoins: roundCoins(Number(input.ancientCoins) || 0),
    lastCoinUpdate: input.lastCoinUpdate || null,
    coinsParserV: Number(input.coinsParserV) || 0, // версия разбора баланса (см. needsCoinRecheck)

    // --- Данные синхронизации с pwonline.ru (раньше терялись при перезапуске) ---
    isLoggedIn: input.isLoggedIn === true,
    lastLoginCheck: input.lastLoginCheck || null,
    lastLoginReason: input.lastLoginReason || null, // почему «оффлайн» (код ошибки), см. authDetails
    marathonData: input.marathonData && typeof input.marathonData === 'object' ? input.marathonData : null,
    // История Древних монет: без записей «+0», не более 10 последних
    coinHistory: normalizeCoinHistory(input.coinHistory),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}
