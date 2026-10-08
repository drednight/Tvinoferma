// @ts-check
import { DEFAULT_SETTINGS } from './constants.js';
import { migrateMarathon } from '../modules/marathons/model.js';
import { SCHEMA_VERSION, migrateState } from './migrations.js';
import { DEFAULT_STATS } from '../modules/characters/stateManager.js';
import { characterIdFor } from './ids.js';
import { roundCoins, normalizeCoinHistory } from './coins.js';
import { normalizeGameCenters } from '../modules/launcher/gameCenters.js';
import { normalizePartyIds, resolveMainPartyId, sweepPartyIds } from '../modules/parties/membership.js';
import { normalizePlannerEntry } from '../modules/dashboard/planner.js';

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
  archivedParties: [],
  archivedCharacters: [],
  marathons: [],
  marathonTemplates: [],
  plannerEntries: [],
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

function normalizeGcIds(list) {
  const ids = (Array.isArray(list) ? list : []).map(v => String(v || '').trim()).filter(Boolean);
  return [...new Set(ids)];
}

function normalizeGcAccounts(map) {
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
function normalizePartyOrder(map) {
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
      gcNick: String(input.launch?.gcNick || '').trim(),   // ник в GameCenter (для показа); токен входа лежит в хранилище ОС
      gcAccount: input.launch?.gcAccount === true,         // вход этого аккаунта запомнен (см. launcher_capture_account)
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

function normalizeArchivedParty(input = {}) {
  const party = normalizeParty(input);
  return {
    ...party,
    memberLinks: Array.isArray(input.memberLinks)
      ? input.memberLinks.filter(link => link && link.characterId).map(link => ({
        characterId: String(link.characterId),
        isMain: link.isMain === true,
        order: link.order !== null && link.order !== undefined && Number.isFinite(Number(link.order))
          ? Number(link.order)
          : null
      }))
      : []
  };
}

function normalizeLauncherSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS.launcher, ...(input || {}) };
  merged.gameCenters = normalizeGameCenters(merged.gameCenters);
  const preferred = String(merged.preferredGcId || '');
  merged.preferredGcId = merged.gameCenters.some(g => g.id === preferred) ? preferred : '';
  // Пауза между запусками окон: число секунд от 0 до 120, иначе умолчание
  /** @type {any} */
  const rawDelay = merged.delaySec;
  const delay = Number(rawDelay);
  merged.delaySec = rawDelay !== '' && rawDelay !== null && rawDelay !== undefined && Number.isFinite(delay)
    ? Math.min(120, Math.max(0, delay))
    : DEFAULT_SETTINGS.launcher.delaySec;
  merged.layoutDir = String(merged.layoutDir ?? '').trim();
  merged.layoutTemplate = String(merged.layoutTemplate ?? '').trim();
  return merged;
}

/**
 * Настройки уведомлений. Отдельная обработка нужна из-за вложенного списка ивентов:
 * обычное поверхностное слияние затирало бы умолчания ивентов, которых нет в старом state.json,
 * и напоминание о них молча не работало бы.
 * Валидность «минут до начала» проверяет `eventNotificationSettings` при чтении.
 */
function normalizeNotificationSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS.notifications, ...(input || {}) };
  /** @type {Record<string, { enabled: boolean, leadMinutes: number }>} */
  const events = {};
  for (const [id, def] of Object.entries(DEFAULT_SETTINGS.notifications.events || {})) {
    const raw = input?.events?.[id] || {};
    const minutes = Number(raw.leadMinutes);
    events[id] = {
      enabled: raw.enabled !== false,
      leadMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : def.leadMinutes
    };
  }
  // Приведение типа: набор ивентов задаётся расписанием (recurringEvents.js), поэтому в типе
  // перечислены конкретные ключи, а объект собирается циклом
  merged.events = /** @type {typeof DEFAULT_SETTINGS.notifications.events} */ (events);
  return merged;
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
    notifications: normalizeNotificationSettings(input.notifications),
    browser: { ...DEFAULT_SETTINGS.browser, ...(input.browser || {}) },
    launcher: normalizeLauncherSettings(input.launcher),
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
    archivedCharacters: Array.isArray(input?.archivedCharacters)
      ? input.archivedCharacters.map(normalizeCharacter)
      : [],
    archivedParties: Array.isArray(input?.archivedParties)
      ? input.archivedParties.map(normalizeArchivedParty).filter(p => p.name)
      : [],
    // Марафоны приводятся к схеме v2 (старые records/stages конвертируются автоматически)
    marathons: Array.isArray(input?.marathons)
      ? input.marathons.map(m => migrateMarathon(m, input.characters || [])).filter(Boolean)
      : [],
    marathonTemplates: Array.isArray(input?.marathonTemplates) ? input.marathonTemplates : [],
    plannerEntries: Array.isArray(input?.plannerEntries)
      ? input.plannerEntries.map(normalizePlannerEntry).filter(entry => entry.title)
      : [],
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
  normalized.archivedCharacters.forEach(c => {
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
  if (Array.isArray(input?.archivedParties)) {
    normalized.archivedParties = input.archivedParties
      .map(normalizeArchivedParty)
      .filter(p => p.name)
      .sort((a, b) => a.order - b.order);
  }

  // 3. Ссылки персонажей на несуществующие партии (удалённые, потерянные при импорте) убираем
  const allParties = [...normalized.parties, ...normalized.archivedParties];
  sweepPartyIds([...normalized.characters, ...normalized.archivedCharacters], allParties);

  return normalized;
}