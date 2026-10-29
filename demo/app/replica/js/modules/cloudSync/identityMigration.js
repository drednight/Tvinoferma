// @ts-check
// Подготовка отдельных устойчивых идентификаторов в ЛОКАЛЬНОЙ копии state.json.
// Функция намеренно не сохраняет результат и не включает облако. Перед первым экспортом
// вызывающая сторона обязана создать резервную копию и атомарно сохранить именно этот план;
// до подтверждённого сохранения использовать назначенные идентификаторы нельзя.

import { generateSyncId, isSyncId, validateJsonSnapshot } from './envelope.js';

const MAX_GENERATION_ATTEMPTS = 16;

function invalid() {
  // Имена, локальные id и содержимое пользовательских записей не попадают в сообщение.
  return new Error(
    'Не удалось подготовить идентификаторы синхронизации: данные неполны или идентификаторы повторяются'
  );
}

function array(value) {
  if (!Array.isArray(value)) throw invalid();
  return value;
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 512) throw invalid();
  return value;
}

function groupsOf(state) {
  const characters = [...array(state.characters), ...array(state.archivedCharacters)];
  const parties = [...array(state.parties), ...array(state.archivedParties)];
  const marathons = array(state.marathons);
  const marathonTemplates = array(state.marathonTemplates);
  const plannerEntries = array(state.plannerEntries);
  if (!state.finance || typeof state.finance !== 'object' || Array.isArray(state.finance)) throw invalid();
  const operations = array(state.finance.operations);
  const shopItems = array(state.finance.shopItems);
  const loans = array(state.finance.loans);
  const payments = loans.flatMap(loan => array(record(loan).payments));
  // Задания и награды идентифицируются в пределах своего марафона/задания.
  // У шаблонов вложенные записи остаются значениями: при создании марафона копия
  // получает новые локальные и sync-ID, а не становится той же сущностью.
  const groups = [
    { name: 'characters', entries: characters, foldLocalId: true },
    { name: 'parties', entries: parties },
    { name: 'marathons', entries: marathons },
    { name: 'marathonTemplates', entries: marathonTemplates },
    { name: 'plannerEntries', entries: plannerEntries },
    { name: 'financeOperations', entries: operations },
    { name: 'financeShopItems', entries: shopItems },
    { name: 'financeLoans', entries: loans },
    { name: 'financePayments', entries: payments },
    { name: 'marathonTasks', entries: [] },
    { name: 'marathonRewards', entries: [] },
    { name: 'marathonBonuses', entries: [] }
  ];
  for (const value of marathons) {
    const marathon = record(value);
    if (marathon.kind === 'series') continue;
    const tasks = array(marathon.tasks);
    groups.push({ name: 'marathonTasks', entries: tasks });
    groups.push({ name: 'marathonBonuses', entries: array(marathon.bonuses) });
    for (const task of tasks) groups.push({ name: 'marathonRewards', entries: array(record(task).rewards) });
  }
  return groups;
}

/**
 * План назначения syncId, не изменяющий входной объект. На входе — нормализованный
 * снимок без ui. Ошибка, повреждение или повтор идентификаторов не приводят к записи
 * и не исправляются перегенерацией. Одинаковые локальные id разных типов допустимы.
 * @param {{ snapshot?: any, cryptoSource?: Crypto }} [options]
 */
export function planSyncIdentities({ snapshot, cryptoSource } = {}) {
  validateJsonSnapshot(snapshot);
  let planned;
  try {
    planned = structuredClone(snapshot);
  } catch {
    throw invalid();
  }
  const groups = groupsOf(planned);
  const used = new Set();
  const allLocalIds = new Set();
  const seenEntities = new WeakSet();
  const pending = [];
  const assigned = {};
  for (const group of groups) {
    const localIds = new Set();
    assigned[group.name] = 0;
    for (const value of group.entries) {
      const entity = record(value);
      if (seenEntities.has(entity)) throw invalid();
      seenEntities.add(entity);
      const localId = group.foldLocalId ? entity.id.toLowerCase() : entity.id;
      if (localIds.has(localId)) throw invalid();
      localIds.add(localId);
      allLocalIds.add(entity.id.toLowerCase());
      if (Object.hasOwn(entity, 'syncId')) {
        if (!isSyncId(entity.syncId) || used.has(entity.syncId)) throw invalid();
        used.add(entity.syncId);
      } else {
        pending.push({ entity, group: group.name });
      }
    }
  }
  // sync-ID не должен совпадать с локальным ID любой сущности: пространства имён
  // независимы, в том числе если старый локальный ID тоже выглядит как UUID.
  if ([...used].some(id => allLocalIds.has(id.toLowerCase()))) throw invalid();
  for (const { entity, group } of pending) {
    let id = null;
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const candidate = generateSyncId(cryptoSource);
      // Не используем локальный ID ни одной сущности, даже другой категории.
      if (!used.has(candidate) && !allLocalIds.has(candidate.toLowerCase())) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error('Не удалось создать уникальный идентификатор синхронизации');
    entity.syncId = id;
    used.add(id);
    assigned[group]++;
  }
  return { snapshot: planned, changed: pending.length > 0, assigned };
}
