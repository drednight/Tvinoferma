// @ts-check
import { DEFAULT_SETTINGS } from './constants.js';
import { migrateMarathon } from '../modules/marathons/model.js';
import { SCHEMA_VERSION, migrateState } from './migrations.js';
import { DEFAULT_STATS } from '../modules/characters/stateManager.js';
import { characterIdFor } from './ids.js';
import { roundCoins, normalizeCoinHistory } from './coins.js';
import { normalizePartyIds, resolveMainPartyId, sweepPartyIds } from '../modules/parties/membership.js';

/** Максимальная длина примечания к персонажу (символов). */
export const NOTES_MAX_LENGTH = 5000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export const state = {
  schemaVersion: SCHEMA_VERSION,
  savedAt: null,
  parties: [],
  characters: [],
  marathons: [],
  marathonTemplates: [],
  settings: clone(DEFAULT_SETTINGS),
  ui: {
    activeTab: 'characters',
    filters: {
      search: '',
      class: '',
      party: ''
    },
    expandedCharacterId: null,
    revealedContacts: {},
    authCheck: {},
    selection: new Set(),
    selectionMode: false
  }
};

export function serializeState() {
  const { ui, ...rest } = state;
  return {
    ...rest,
    savedAt: new Date().toISOString()
  };
}

function normalizeStats(input = {}) {
  const stats = {};
  Object.keys({ ...DEFAULT_STATS, ...(input || {}) }).forEach(key => {
    stats[key] = Number(input?.[key]) || 0;
  });
  return stats;
}

/** Теги: строки без лишних пробелов, без дублей (регистр не важен). */
export function normalizeTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set();
  return list.map(t => String(t || '').trim().replace(/\s+/g, ' ')).filter(t => {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeCharacter(input = {}) {
  return {
    id: input.id ? String(input.id) : null, // пустой id назначается из ника в normalizeState
    nick: String(input.nick || ''),
    class: String(input.class || ''),
    partyIds: normalizePartyIds(input.partyIds), // id всех партий; миграция v5 переводит старое поле `party`
    mainPartyId: resolveMainPartyId(input.partyIds, input.mainPartyId), // основная пати (входит в partyIds)
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
      gcNick: String(input.launch?.gcNick || '').trim(),   // ник в GameCenter (для показа); токен входа лежит в хранилище ОС
      gcAccount: input.launch?.gcAccount === true          // вход этого аккаунта запомнен (см. launcher_capture_account)
    },
    dungeonPasses: {
      weapon: Number(input.dungeonPasses?.weapon) || 0,
      armor: Number(input.dungeonPasses?.armor) || 0,
      relic: Number(input.dungeonPasses?.relic) || 0
    },
    
    // Все характеристики из редактора (раньше сохранялись только 7 из них)
    stats: normalizeStats(input.stats),
    tags: normalizeTags(input.tags),

    ancientCoins: roundCoins(Number(input.ancientCoins) || 0),
    lastCoinUpdate: input.lastCoinUpdate || null,
    coinsParserV: Number(input.coinsParserV) || 0,   // версия разбора баланса (см. needsCoinRecheck)

    // --- Данные синхронизации с pwonline.ru (раньше терялись при перезапуске) ---
    isLoggedIn: input.isLoggedIn === true,
    lastLoginCheck: input.lastLoginCheck || null,
    lastLoginReason: input.lastLoginReason || null,   // почему «оффлайн» (код ошибки), см. authDetails
    marathonData: input.marathonData && typeof input.marathonData === 'object'
      ? input.marathonData
      : null,
    // История Древних монет: без записей «+0», не более 10 последних
    coinHistory: normalizeCoinHistory(input.coinHistory),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

function normalizeParty(input = {}) {
  return {
    id: input.id || crypto.randomUUID?.() || String(Date.now()), // Добавили ID для стабильности
    name: String(input.name || '').trim(),
    order: Number(input.order) || null, // ✅ СОХРАНЯЕМ ПОЛЕ ORDER
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

function mergeSettings(input = {}) {
  return {
    ...clone(DEFAULT_SETTINGS),
    ...input,
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(input.privacy || {}) },
    autosave: { ...DEFAULT_SETTINGS.autosave, ...(input.autosave || {}) },
    backups: { ...DEFAULT_SETTINGS.backups, ...(input.backups || {}) },
    google: {
      ...DEFAULT_SETTINGS.google,
      ...(input.google || {}),
      sheetsFields: {
        ...DEFAULT_SETTINGS.google.sheetsFields,
        ...(input.google?.sheetsFields || {})
      }
    },
    ui: { ...DEFAULT_SETTINGS.ui, ...(input.ui || {}) },
    security: { ...DEFAULT_SETTINGS.security, ...(input.security || {}) },
    scripts: { ...DEFAULT_SETTINGS.scripts, ...(input.scripts || {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(input.notifications || {}) },
    browser: { ...DEFAULT_SETTINGS.browser, ...(input.browser || {}) },
    launcher: { ...DEFAULT_SETTINGS.launcher, ...(input.launcher || {}) },
    tray: { ...DEFAULT_SETTINGS.tray, ...(input.tray || {}) },
    freshness: { ...DEFAULT_SETTINGS.freshness, ...(input.freshness || {}) },
    updates: { ...DEFAULT_SETTINGS.updates, ...(input.updates || {}) }
  };
}

export function normalizeState(raw) {
  // 0. Единые миграции схемы state.json (js/migrations.js)
  /** @type {any} */
  const input = migrateState(raw).state;

  // 1. Базовая структура
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: input?.savedAt || null,
    parties: [],
    characters: Array.isArray(input?.characters)
      ? input.characters.map(normalizeCharacter)
      : [],
    // Марафоны приводятся к схеме v2 (старые records/stages конвертируются автоматически)
    marathons: Array.isArray(input?.marathons)
      ? input.marathons.map(m => migrateMarathon(m, input.characters || [])).filter(Boolean)
      : [],
    marathonTemplates: Array.isArray(input?.marathonTemplates) ? input.marathonTemplates : [],
    settings: mergeSettings(input?.settings),
    ui: {
      activeTab: 'characters',
      filters: { search: '', class: '', party: '' },
      expandedCharacterId: null,
      revealedContacts: {},
      authCheck: {},
      selection: new Set(),
      selectionMode: false
    }
  };

  // 1a. id персонажей: у каждого есть, уникальны, для новых — из ника
  const taken = [];
  normalized.characters.forEach(c => {
    if (!c.id || taken.some(id => id.toLowerCase() === c.id.toLowerCase())) c.id = characterIdFor(c.nick, taken);
    taken.push(c.id);
  });

  // 2. Нормализация ПАРТИЙ с гарантией поля ORDER
  if (Array.isArray(input?.parties)) {
    // Сначала мапим через твою стандартную функцию
    let tempParties = input.parties
      .map(normalizeParty)
      .filter((p) => p && p.name); // Убираем пустые/битые записи

    // ВАЖНО: Если у партии нет поля order или оно не число, 
    // присваиваем ей порядковый номер based on its position in the array.
    // Это критически важно для сохранения порядка при загрузке старых данных.
    tempParties.forEach((party, index) => {
      if (typeof party.order !== 'number' || isNaN(party.order)) {
        party.order = index + 1;
      }
    });

    // Сортируем массив партий по полю order перед тем как положить в стейт.
    // Это гарантирует, что renderPartiesGrid получит уже отсортированный список,
    // и визуальный порядок будет соответствовать сохраненному.
    tempParties.sort((a, b) => a.order - b.order);

    normalized.parties = tempParties;
  }

  // 3. Ссылки персонажей на несуществующие партии (удалённые, потерянные при импорте) убираем
  sweepPartyIds(normalized.characters, normalized.parties);

  return normalized;
}