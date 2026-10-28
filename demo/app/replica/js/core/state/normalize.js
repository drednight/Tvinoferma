// @ts-check
// js/core/state/normalize.js
// Сборка целого состояния из state.json: миграции, нормализация разделов и связи.

import { SCHEMA_VERSION, migrateState } from '../migrations.js';
import { migrateMarathon } from '../../modules/marathons/model.js';
import { characterIdFor } from '../ids.js';
import { sweepPartyIds } from '../../modules/parties/membership.js';
import { normalizePlannerEntry } from '../../modules/dashboard/planner.js';
import { normalizeFinance } from '../../modules/finance/model.js';
import { normalizeCharacter } from './character.js';
import { normalizeParty, normalizeArchivedParty } from './party.js';
import { mergeSettings } from './settings.js';

export function normalizeState(raw) {
  // 0. Единые миграции схемы state.json (js/core/migrations.js)
  /** @type {any} */
  const input = migrateState(raw).state;

  // 1. Базовая структура
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: input?.savedAt || null,
    parties: [],
    characters: Array.isArray(input?.characters) ? input.characters.map(normalizeCharacter) : [],
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
    finance: normalizeFinance(input?.finance),
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

  // 2. Нормализация ПАРТИЙ с гарантией поля ORDER: партия без номера получает его по
  // позиции в массиве, иначе визуальный порядок после загрузки старого файла был бы случайным
  if (Array.isArray(input?.parties)) {
    const tempParties = input.parties.map(normalizeParty).filter(p => p && p.name); // Убираем пустые/битые записи

    tempParties.forEach((party, index) => {
      if (typeof party.order !== 'number' || isNaN(party.order)) party.order = index + 1;
    });
    // Сортируем по полю order перед тем как положить в стейт: renderPartiesGrid получает
    // уже отсортированный список, и порядок на экране совпадает с сохранённым
    normalized.parties = tempParties.sort((a, b) => a.order - b.order);
  }
  if (Array.isArray(input?.archivedParties)) {
    normalized.archivedParties = input.archivedParties
      .map(normalizeArchivedParty)
      .filter(p => p.name)
      .sort((a, b) => a.order - b.order);
  }

  // 3. Ссылки персонажей на несуществующие партии (удалённые, потерянные при импорте) убираем
  sweepPartyIds(
    [...normalized.characters, ...normalized.archivedCharacters],
    [...normalized.parties, ...normalized.archivedParties]
  );

  return normalized;
}
