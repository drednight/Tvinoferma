import { DATA_VERSION, DEFAULT_SETTINGS } from './constants.js';
import { migrateMarathon } from './marathons/model.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export const state = {
  version: DATA_VERSION,
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
    authCheck: {}
  }
};

export function serializeState() {
  const { ui, ...rest } = state;
  return {
    ...rest,
    savedAt: new Date().toISOString()
  };
}

// js/state.js (фрагмент normalizeCharacter)

function normalizeCharacter(input = {}) {
  return {
    id: input.id || crypto.randomUUID?.() || String(Date.now()),
    nick: String(input.nick || ''),
    class: String(input.class || ''),
    party: input.party === '' ? null : input.party || null,
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
    dungeonPasses: {
      weapon: Number(input.dungeonPasses?.weapon) || 0,
      armor: Number(input.dungeonPasses?.armor) || 0,
      relic: Number(input.dungeonPasses?.relic) || 0
    },
    
    // --- НОВЫЕ СТАТИСТИЧЕСКИЕ ПОЛЯ ---
    stats: {
      hp: Number(input.stats?.hp) || 0,          // Здоровье
      pa: Number(input.stats?.pa) || 0,          // Физ. Защита (PA)
      pz: Number(input.stats?.pz) || 0,          // Маг. Защита (PZ)
      pvePa: Number(input.stats?.pvePa) || 0,    // PvE Физ. Защита
      pvePz: Number(input.stats?.pvePz) || 0,    // PvE Маг. Защита
      physAttack: Number(input.stats?.physAttack) || 0, // Физ. Атака
      magAttack: Number(input.stats?.magAttack) || 0    // Маг. Атака
    },
    // ----------------------------------

    ancientCoins: Number(input.ancientCoins) || 0,
    lastCoinUpdate: input.lastCoinUpdate || null,

    // --- Данные синхронизации с pwonline.ru (раньше терялись при перезапуске) ---
    isLoggedIn: input.isLoggedIn === true,
    lastLoginCheck: input.lastLoginCheck || null,
    marathonData: input.marathonData && typeof input.marathonData === 'object'
      ? input.marathonData
      : null,
    coinHistory: Array.isArray(input.coinHistory) ? input.coinHistory : [],
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
    ui: { ...DEFAULT_SETTINGS.ui, ...(input.ui || {}) }
  };
}

export function normalizeState(input) {
  // 1. Базовая структура
  const normalized = {
    version: Number(input?.version) || DATA_VERSION,
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
      authCheck: {}
    }
  };

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

  return normalized;
}