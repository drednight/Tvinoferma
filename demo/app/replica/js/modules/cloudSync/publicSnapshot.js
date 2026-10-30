// @ts-check
// Подготовленный набор без контактов и паролей. Не читает облако и ничего не сохраняет.
// Перед экспортом все идентификаторы должны быть назначены И сохранены с резервной копией.
import { SCHEMA_VERSION } from '../../core/migrations.js';
import { isSyncId, validateJsonSnapshot } from './envelope.js';
import { array, invalidExport, object } from './exportSchema.js';
import { exportCharacter } from './characterExport.js';
import { exportParty } from './partyExport.js';
import { exportPlannerEntry } from './plannerExport.js';
import { exportMarathon } from './marathonExport.js';
import { exportMarathonTemplate } from './templateExport.js';
import { exportFinance } from './financeExport.js';
import { exportPortableSettings } from './settingsExport.js';

const ROOT_FIELDS = [
  'schemaVersion',
  'savedAt',
  'characters',
  'archivedCharacters',
  'parties',
  'archivedParties',
  'marathons',
  'marathonTemplates',
  'plannerEntries',
  'finance',
  'settings'
];

function rows(value) {
  return array(value, row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalidExport();
    if (typeof row.id !== 'string' || !row.id.trim() || !isSyncId(row.syncId)) throw invalidExport();
    return row;
  });
}

function mapping(entries, fold = false) {
  const result = new Map();
  const seen = new Set();
  for (const row of entries) {
    const key = fold ? row.id.toLowerCase() : row.id;
    if (seen.has(key)) throw invalidExport();
    seen.add(key);
    result.set(row.id, row.syncId);
  }
  return result;
}

/**
 * Сравнивать готовые наборы можно без доступа к локальным путям, входам и секретам.
 * Невыбранные группы настроек отсутствуют, а не обозначают удаление.
 * @param {any} snapshot нормализованное состояние без ui, с уже сохранёнными syncId
 * @param {{ settingsSelections?: string[] }} [options]
 */
export function buildPublicSnapshot(snapshot, options = {}) {
  // Проверка до чтения значений предотвращает вызов getter'ов даже во вложенных разделах.
  validateJsonSnapshot(snapshot);
  const root = object(snapshot, ROOT_FIELDS);
  if (root.schemaVersion !== SCHEMA_VERSION) throw invalidExport();
  const opts = object(options, [], ['settingsSelections']);
  const characters = rows(root.characters);
  const archivedCharacters = rows(root.archivedCharacters);
  const parties = rows(root.parties);
  const archivedParties = rows(root.archivedParties);
  const marathons = rows(root.marathons);
  const templates = rows(root.marathonTemplates);
  const plannerEntries = rows(root.plannerEntries);
  const characterSyncIds = mapping([...characters, ...archivedCharacters], true);
  const partySyncIds = mapping([...parties, ...archivedParties]);
  const marathonSyncIds = mapping(marathons);
  const templateSyncIds = mapping(templates);
  mapping(plannerEntries);

  const characterRecords = [
    ...characters.map(row => exportCharacter(row, { syncId: row.syncId, partySyncIds })),
    ...archivedCharacters.map(row => exportCharacter(row, { syncId: row.syncId, partySyncIds, archived: true }))
  ];
  const partyRecords = [
    ...parties.map(row => exportParty(row, { syncId: row.syncId, characterSyncIds })),
    ...archivedParties.map(row => exportParty(row, { syncId: row.syncId, characterSyncIds, archived: true }))
  ];
  const marathonRecords = [
    ...marathons.map(row =>
      exportMarathon(row, { syncId: row.syncId, characterSyncIds, marathonSyncIds, templateSyncIds })
    ),
    ...templates.map(row => exportMarathonTemplate(row, { syncId: row.syncId }))
  ];
  const plannerRecords = plannerEntries.map(row => exportPlannerEntry(row, { syncId: row.syncId }));
  const finance = exportFinance(root.finance);
  const preferences = exportPortableSettings(root.settings, {
    selections: Object.hasOwn(opts, 'settingsSelections') ? opts.settingsSelections : []
  });

  const allIds = new Set();
  function register(id) {
    if (!isSyncId(id) || allIds.has(id)) throw invalidExport();
    allIds.add(id);
  }
  for (const row of [...characterRecords, ...partyRecords, ...marathonRecords, ...plannerRecords, ...finance.records]) {
    register(row.id);
    // Задания, награды и бонусы марафона — самостоятельные сущности, в отличие от шаблона.
    if (row.type === 'marathon') {
      for (const task of row.fields.tasks) {
        register(task.id);
        for (const reward of task.rewards) register(reward.id);
      }
      for (const bonus of row.fields.bonuses) register(bonus.id);
    }
  }

  // Пространства локальных и переносимых ID должны оставаться раздельными. Даже
  // повреждённый ранее сохранённый план нельзя тихо принять как новый экспорт.
  const localEntities = [
    ...characters,
    ...archivedCharacters,
    ...parties,
    ...archivedParties,
    ...marathons,
    ...templates,
    ...plannerEntries,
    ...root.finance.operations,
    ...root.finance.shopItems,
    ...root.finance.loans,
    ...root.finance.loans.flatMap(loan => loan.payments)
  ];
  for (const marathon of marathons) {
    if (marathon.kind === 'series') continue;
    localEntities.push(...marathon.tasks, ...marathon.bonuses);
    for (const task of marathon.tasks) localEntities.push(...task.rewards);
  }
  const localIds = new Set(localEntities.map(row => String(row.id).toLowerCase()));
  if ([...allIds].some(id => localIds.has(id.toLowerCase()))) throw invalidExport();

  const result = {
    schemaVersion: 1,
    sections: {
      characters: {
        records: characterRecords,
        order: { active: characters.map(row => row.syncId), archived: archivedCharacters.map(row => row.syncId) }
      },
      parties: {
        records: partyRecords,
        order: { active: parties.map(row => row.syncId), archived: archivedParties.map(row => row.syncId) }
      },
      marathons: {
        records: marathonRecords,
        order: { marathons: marathons.map(row => row.syncId), templates: templates.map(row => row.syncId) }
      },
      planner: { records: plannerRecords, order: plannerEntries.map(row => row.syncId) },
      finance,
      preferences
    }
  };
  validateJsonSnapshot(result);
  return result;
}
