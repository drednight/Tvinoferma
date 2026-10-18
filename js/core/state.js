// @ts-check
// js/core/state.js
// Общее состояние приложения и его сохранение.
//
// Нормализация вынесена по файлам (js/core/state/*.js): здесь остались сам объект
// состояния и сохранение. Публичный путь `core/state.js` не меняется — импорты не трогаем.

import { DEFAULT_SETTINGS } from './constants.js';
import { SCHEMA_VERSION } from './migrations.js';
import { defaultFinance } from '../modules/finance/model.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

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
  // Раздел «Учёт»: реестр движений денег, комиссионный магазин, голд и долги
  finance: defaultFinance(),
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

// Нормализация — чистые функции, переиспользуются по всему приложению
export { normalizeState } from './state/normalize.js';
export { normalizeCharacter, normalizeTags, NOTES_MAX_LENGTH } from './state/character.js';
export { normalizePartyColor, normalizeParty, normalizeArchivedParty } from './state/party.js';
export { mergeSettings } from './state/settings.js';