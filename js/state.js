import { DATA_VERSION, DEFAULT_SETTINGS } from './constants.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export const state = {
  version: DATA_VERSION,
  savedAt: null,
  parties: [],
  characters: [],
  marathons: [],
  settings: clone(DEFAULT_SETTINGS),
  ui: {
    activeTab: 'characters',
    filters: {
      search: '',
      class: '',
      party: ''
    },
    expandedCharacterId: null,
    revealedContacts: {}
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
    coinHistory: Array.isArray(input.coinHistory) ? input.coinHistory : [],
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

function normalizeParty(input = {}) {
  return {
    name: String(input.name || '').trim(),
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
  return {
    version: Number(input?.version) || DATA_VERSION,
    savedAt: input?.savedAt || null,
    parties: Array.isArray(input?.parties)
      ? input.parties.map(normalizeParty).filter((p) => p.name)
      : [],
    characters: Array.isArray(input?.characters)
      ? input.characters.map(normalizeCharacter)
      : [],
    marathons: Array.isArray(input?.marathons) ? input.marathons : [],
    settings: mergeSettings(input?.settings),
    ui: {
      activeTab: 'characters',
      filters: { search: '', class: '', party: '' },
      expandedCharacterId: null,
      revealedContacts: {}
    }
  };
}

