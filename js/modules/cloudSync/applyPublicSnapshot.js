// @ts-check
// Преобразование выбранных публичных записей в локальный кандидат. Этот модуль
// не сохраняет state и не доверяет облаку: вызывающий обязан проверить историю,
// повторно сверить состояние и создать резервную копию перед записью. Контакты,
// пути, входы и статусы текущего ПК остаются локальными. Не журналировать значения.
import { characterIdFor } from '../../core/ids.js';
import { normalizeState, normalizeCharacter } from '../../core/state.js';
import { CLAN_ENTRY_PREFIX } from '../guild/core.js';
import { generateSyncId, isSyncId, validateJsonSnapshot } from './envelope.js';
import { object, array } from './exportSchema.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { comparePublicSnapshots, publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { reviewSnapshotDependencies } from './reviewDependencies.js';

const SECTIONS = ['characters', 'parties', 'marathons', 'planner', 'finance'];
const GROUPS = ['appearance', 'navigation', 'planner', 'eventReminders'];

function invalid() {
  return new Error('Не удалось подготовить выбранные изменения: проверьте данные и связанные записи');
}
function clone(value) {
  return structuredClone(value);
}
function rows(snapshot, section) {
  return snapshot.sections[section].records;
}
function samePublic(a, b) {
  const comparison = comparePublicSnapshots({ local: a, cloud: b });
  return comparison.entries.length === 0 && comparison.uncomparedSettings.length === 0;
}
function commonValuePrefix(before, after) {
  let count = 0;
  while (count < before.length && count < after.length && sameValue(before[count], after[count])) count++;
  return count;
}
function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameValue(value, b[index]))
    );
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}
function orderedIds(records, local, cloud, accepts) {
  const available = new Set(records.filter(accepts).map(record => record.id));
  const result = [];
  const placed = new Set();
  for (const id of [...local, ...cloud, ...available]) {
    if (available.has(id) && !placed.has(id)) {
      placed.add(id);
      result.push(id);
    }
  }
  if (result.length !== available.size) throw invalid();
  return result;
}
function setOrders(target, local, cloud) {
  for (const section of ['characters', 'parties']) {
    const records = rows(target, section);
    target.sections[section].order = {
      active: orderedIds(
        records,
        local.sections[section].order.active,
        cloud.sections[section].order.active,
        r => !r.archived
      ),
      archived: orderedIds(
        records,
        local.sections[section].order.archived,
        cloud.sections[section].order.archived,
        r => r.archived
      )
    };
  }
  const marathons = rows(target, 'marathons');
  target.sections.marathons.order = {
    marathons: orderedIds(
      marathons,
      local.sections.marathons.order.marathons,
      cloud.sections.marathons.order.marathons,
      r => r.type !== 'marathonTemplate'
    ),
    templates: orderedIds(
      marathons,
      local.sections.marathons.order.templates,
      cloud.sections.marathons.order.templates,
      r => r.type === 'marathonTemplate'
    )
  };
  target.sections.planner.order = orderedIds(
    rows(target, 'planner'),
    local.sections.planner.order,
    cloud.sections.planner.order,
    () => true
  );
  const finance = rows(target, 'finance');
  target.sections.finance.order = Object.fromEntries(
    [
      ['operations', 'financeOperation'],
      ['shopItems', 'financeShopItem'],
      ['loans', 'financeLoan']
    ].map(([key, type]) => [
      key,
      orderedIds(finance, local.sections.finance.order[key], cloud.sections.finance.order[key], r => r.type === type)
    ])
  );
  // Нормализатор при загрузке всегда сортирует пати по order, а операции и
  // магазин по дате. Это следствие выбранных полей, не выбор версии по времени.
  const partyById = new Map(rows(target, 'parties').map(record => [record.id, record]));
  for (const kind of ['active', 'archived']) {
    target.sections.parties.order[kind].sort((a, b) => partyById.get(a).fields.order - partyById.get(b).fields.order);
  }
  const financeById = new Map(finance.map(record => [record.id, record]));
  for (const kind of ['operations', 'shopItems']) {
    target.sections.finance.order[kind].sort((a, b) => {
      const x = financeById.get(a).fields.date;
      const y = financeById.get(b).fields.date;
      return x < y ? 1 : x > y ? -1 : 0;
    });
  }
}

function forbidLostChildren(before, after) {
  if (!before || before.type !== 'marathon') return;
  const nextTasks = new Map(after.fields.tasks.map(task => [task.id, task]));
  for (const task of before.fields.tasks) {
    const next = nextTasks.get(task.id);
    if (!next) throw new Error('Для удаления задания марафона требуется отдельное подтверждение истории');
    const rewards = new Set(next.rewards.map(reward => reward.id));
    if (task.rewards.some(reward => !rewards.has(reward.id)))
      throw new Error('Для удаления награды марафона требуется отдельное подтверждение истории');
  }
  const bonuses = new Set(after.fields.bonuses.map(bonus => bonus.id));
  if (before.fields.bonuses.some(bonus => !bonuses.has(bonus.id)))
    throw new Error('Для удаления бонуса марафона требуется отдельное подтверждение истории');
}

function projection(local, cloud, selected, settingsGroups, financeSettings) {
  const target = clone(local);
  const seen = new Set();
  const remoteBySection = new Map(
    SECTIONS.map(section => [section, new Map(rows(cloud, section).map(record => [record.id, record]))])
  );
  const indexBySection = new Map(
    SECTIONS.map(section => [section, new Map(rows(target, section).map((record, index) => [record.id, index]))])
  );
  for (const choice of selected) {
    const item = object(choice, ['section', 'id']);
    if (!SECTIONS.includes(item.section) || !isSyncId(item.id)) throw invalid();
    const key = `${item.section}:${item.id}`;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    const incoming = remoteBySection.get(item.section).get(item.id);
    if (!incoming) throw invalid(); // отсутствие записи не является удалением
    const index = indexBySection.get(item.section).get(item.id);
    if (index !== undefined) {
      const prior = rows(target, item.section)[index];
      if (prior.type !== incoming.type) throw invalid();
      forbidLostChildren(prior, incoming);
      rows(target, item.section)[index] = clone(incoming);
    } else rows(target, item.section).push(clone(incoming));
  }
  const selectedGroups = new Set();
  for (const group of settingsGroups) {
    if (!GROUPS.includes(group) || selectedGroups.has(group) || !cloud.sections.preferences.selections.includes(group))
      throw invalid();
    selectedGroups.add(group);
    target.sections.preferences.values[group] = clone(cloud.sections.preferences.values[group]);
  }
  if (financeSettings) target.sections.finance.settings = clone(cloud.sections.finance.settings);
  setOrders(target, local, cloud);
  publicSnapshotIdentityTypes(target);
  if (reviewSnapshotDependencies(target).issues.length)
    throw new Error('Выбранные изменения требуют связанных записей');
  return target;
}

function collectLocalIds(value, result) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) collectLocalIds(child, result);
    return;
  }
  if (typeof value.id === 'string') result.add(value.id.toLowerCase());
  if (typeof value.syncId === 'string') result.add(value.syncId.toLowerCase());
  for (const child of Object.values(value)) collectLocalIds(child, result);
}
function identityPool(snapshot, target, cryptoSource) {
  const used = new Set();
  collectLocalIds(snapshot, used);
  for (const id of publicSnapshotIdentityTypes(target).keys()) used.add(id.toLowerCase());
  return prefix => {
    for (let n = 0; n < 16; n++) {
      const id = `${prefix}-${generateSyncId(cryptoSource)}`;
      if (!used.has(id.toLowerCase())) {
        used.add(id.toLowerCase());
        return id;
      }
    }
    throw invalid();
  };
}
function mappedDictionary(input, keyMap, valueMap) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [resolve(keyMap, key), valueMap(value)]));
}
function resolve(map, id, nullable = false) {
  if (nullable && id === null) return null;
  const value = map.get(id);
  if (!value) throw invalid();
  return value;
}
function existingMap(values) {
  return new Map(values.map(item => [item.syncId, item]));
}
function indexTarget(target) {
  return new Map(SECTIONS.flatMap(section => rows(target, section).map(record => [record.id, record])));
}
function listFor(map, ids) {
  return ids.map(id => {
    const value = map.get(id);
    if (!value) throw invalid();
    return value;
  });
}

function applySettings(settings, target, selectedGroups) {
  for (const group of selectedGroups) {
    const value = clone(target.sections.preferences.values[group]);
    if (group === 'appearance') settings.ui.theme = value.theme;
    if (group === 'navigation') settings.ui.sections = value;
    if (group === 'planner') settings.ui.plannerView = value.view;
    if (group === 'eventReminders') settings.notifications.events = value;
  }
}

function materialize(
  localState,
  local,
  target,
  selected,
  selectedGroups,
  financeSettings,
  cryptoSource,
  fullReplacement = false
) {
  const state = clone(localState);
  const choose = new Set(selected.map(item => `${item.section}:${item.id}`));
  const chosen = (section, id) => choose.has(`${section}:${id}`);
  const records = indexTarget(target);
  const allocate = identityPool(state, target, cryptoSource);
  const charsBefore = existingMap([...state.characters, ...state.archivedCharacters]);
  const partiesBefore = existingMap([...state.parties, ...state.archivedParties]);
  const marathonsBefore = existingMap(state.marathons);
  const templatesBefore = existingMap(state.marathonTemplates);
  const localTemplates = new Map(
    rows(local, 'marathons')
      .filter(record => record.type === 'marathonTemplate')
      .map(record => [record.id, record])
  );
  const plannerBefore = existingMap(state.plannerEntries);
  const operationsBefore = existingMap(state.finance.operations);
  const itemsBefore = existingMap(state.finance.shopItems);
  const loansBefore = existingMap(state.finance.loans);
  const paymentsBefore = existingMap(state.finance.loans.flatMap(loan => loan.payments));
  const localIds = new Map();
  const usedCharIds = [...charsBefore.values()].map(char => char.id);
  const nickOwners = new Map();
  for (const record of rows(target, 'characters')) {
    const nick = record.fields.nick.trim().toLocaleLowerCase('ru');
    const selected = chosen('characters', record.id);
    const previous = nickOwners.get(nick);
    if (nick && previous && (selected || previous.selected))
      throw new Error('Персонаж с таким ником уже есть на этом ПК: требуется сопоставление');
    if (!previous) nickOwners.set(nick, { selected });
    else previous.selected ||= selected;
  }

  for (const [id, record] of records) {
    const before =
      record.type === 'character'
        ? charsBefore.get(id)
        : record.type === 'party'
          ? partiesBefore.get(id)
          : ['marathon', 'marathonSeries'].includes(record.type)
            ? marathonsBefore.get(id)
            : record.type === 'marathonTemplate'
              ? templatesBefore.get(id)
              : record.type === 'plannerEntry'
                ? plannerBefore.get(id)
                : record.type === 'financeOperation'
                  ? operationsBefore.get(id)
                  : record.type === 'financeShopItem'
                    ? itemsBefore.get(id)
                    : record.type === 'financeLoan'
                      ? loansBefore.get(id)
                      : paymentsBefore.get(id);
    let localId = before?.id;
    if (!localId && record.type === 'character') {
      localId = characterIdFor(record.fields.nick, usedCharIds);
      usedCharIds.push(localId);
    } else if (!localId && record.type === 'plannerEntry' && record.fields.source.kind === 'guild') {
      localId = CLAN_ENTRY_PREFIX + record.fields.source.eventId;
      if (state.plannerEntries.some(entry => entry.id.toLowerCase() === localId.toLowerCase()))
        throw new Error('Клановое событие уже существует: требуется сопоставление');
    } else if (!localId) localId = allocate('cloud');
    localIds.set(id, localId);
  }

  const parties = new Map();
  for (const record of rows(target, 'parties')) {
    const before = partiesBefore.get(record.id);
    if (before && !chosen('parties', record.id) && Boolean(before.memberLinks) === record.archived) {
      parties.set(record.id, before);
      continue;
    }
    const f = record.fields;
    const value = {
      id: localIds.get(record.id),
      syncId: record.id,
      name: f.name,
      order: f.order,
      color: f.color,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt
    };
    if (record.archived)
      value.memberLinks = f.memberLinks.map(link => ({ ...link, characterId: resolve(localIds, link.characterId) }));
    parties.set(record.id, value);
  }
  state.parties = listFor(parties, target.sections.parties.order.active);
  state.archivedParties = listFor(parties, target.sections.parties.order.archived);

  const chars = new Map();
  for (const record of rows(target, 'characters')) {
    const before = charsBefore.get(record.id);
    if (before && !chosen('characters', record.id)) {
      chars.set(record.id, before);
      continue;
    }
    const fields = clone(record.fields);
    fields.partyIds = fields.partyIds.map(id => resolve(localIds, id));
    fields.mainPartyId = resolve(localIds, fields.mainPartyId, true);
    fields.partyOrder = mappedDictionary(fields.partyOrder, localIds, value => value);
    const local = before || normalizeCharacter({ id: localIds.get(record.id), syncId: record.id, nick: fields.nick });
    chars.set(record.id, { ...local, ...fields, id: localIds.get(record.id), syncId: record.id });
  }
  state.characters = listFor(chars, target.sections.characters.order.active);
  state.archivedCharacters = listFor(chars, target.sections.characters.order.archived);

  const templates = new Map();
  for (const record of rows(target, 'marathons').filter(row => row.type === 'marathonTemplate')) {
    const before = templatesBefore.get(record.id);
    if (before && !chosen('marathons', record.id)) {
      templates.set(record.id, before);
      continue;
    }
    const f = clone(record.fields);
    const prior = localTemplates.get(record.id);
    // Only an exactly unchanged prefix keeps its local IDs. After the first
    // replacement/removal/reorder allocate fresh IDs for the entire suffix;
    // names, positions and repeated values cannot identify copied children.
    // Existing instantiated marathons are independent and never rewritten here.
    const taskPrefix = before && prior ? commonValuePrefix(prior.fields.tasks, f.tasks) : 0;
    const bonusPrefix = before && prior ? commonValuePrefix(prior.fields.bonuses, f.bonuses) : 0;
    const tasks = [
      ...(before ? clone(before.tasks.slice(0, taskPrefix)) : []),
      ...f.tasks.slice(taskPrefix).map(task => ({
        ...task,
        id: allocate('task'),
        rewards: task.rewards.map(reward => ({ ...reward, id: allocate('reward') }))
      }))
    ];
    const bonuses = [
      ...(before ? clone((before.bonuses || []).slice(0, bonusPrefix)) : []),
      ...f.bonuses.slice(bonusPrefix).map(bonus => ({ ...bonus, id: allocate('bonus') }))
    ];
    templates.set(record.id, {
      id: localIds.get(record.id),
      syncId: record.id,
      name: f.name,
      sourceUrl: f.sourceUrl,
      tasks,
      bonuses,
      createdAt: f.createdAt
    });
  }
  state.marathonTemplates = listFor(templates, target.sections.marathons.order.templates);

  const marathons = new Map();
  for (const record of rows(target, 'marathons').filter(row => row.type !== 'marathonTemplate')) {
    const before = marathonsBefore.get(record.id);
    if (before && !chosen('marathons', record.id)) {
      marathons.set(record.id, before);
      continue;
    }
    const f = clone(record.fields);
    f.source.templateId = resolve(localIds, f.source.templateId, true);
    const common = {
      id: localIds.get(record.id),
      syncId: record.id,
      schemaVersion: 2,
      title: f.title,
      description: f.description,
      source: f.source,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt
    };
    if (record.type === 'marathonSeries') {
      marathons.set(record.id, { ...common, kind: 'series', childIds: f.childIds.map(id => resolve(localIds, id)) });
      continue;
    }
    const oldTasks = existingMap(before?.tasks || []);
    const oldBonuses = existingMap(before?.bonuses || []);
    const tasks = f.tasks.map(task => {
      const oldTask = oldTasks.get(task.id);
      const oldRewards = existingMap(oldTask?.rewards || []);
      return {
        ...task,
        id: oldTask?.id || allocate('task'),
        syncId: task.id,
        rewards: task.rewards.map(reward => ({
          ...reward,
          id: oldRewards.get(reward.id)?.id || allocate('reward'),
          syncId: reward.id
        }))
      };
    });
    const taskIds = new Map(tasks.map(task => [task.syncId, task.id]));
    const bonuses = f.bonuses.map(bonus => ({
      ...bonus,
      id: oldBonuses.get(bonus.id)?.id || allocate('bonus'),
      syncId: bonus.id
    }));
    const assignments = mappedDictionary(f.assignments, localIds, value => value.map(id => resolve(taskIds, id)));
    const progress = mappedDictionary(f.progress, localIds, value => mappedDictionary(value, taskIds, item => item));
    const balance = Object.fromEntries(
      ['start', 'end'].map(side => [side, mappedDictionary(f.balance[side], localIds, value => value)])
    );
    const awards = f.awards.map(award => ({
      ...award,
      characterId: resolve(localIds, award.characterId, true),
      taskId: resolve(taskIds, award.taskId, true)
    }));
    marathons.set(record.id, {
      ...common,
      kind: 'single',
      seriesId: resolve(localIds, f.seriesId, true),
      bonuses,
      startDate: f.startDate,
      endDate: f.endDate,
      status: f.status,
      participantIds: f.participantIds.map(id => resolve(localIds, id)),
      assignments,
      tasks,
      progress,
      lastSync: before?.lastSync ?? null,
      balance,
      awards,
      completedAt: f.completedAt
    });
  }
  state.marathons = listFor(marathons, target.sections.marathons.order.marathons);

  const planner = new Map();
  for (const record of rows(target, 'planner')) {
    const before = plannerBefore.get(record.id);
    if (before && !chosen('planner', record.id)) {
      planner.set(record.id, before);
      continue;
    }
    const f = clone(record.fields);
    const source = f.source;
    delete f.source;
    const localId = localIds.get(record.id);
    if (
      (source.kind === 'guild') !== localId.startsWith(CLAN_ENTRY_PREFIX) ||
      (source.kind === 'guild' && localId !== CLAN_ENTRY_PREFIX + source.eventId)
    )
      throw invalid();
    planner.set(record.id, { id: localId, syncId: record.id, ...f });
  }
  state.plannerEntries = listFor(planner, target.sections.planner.order);

  const operations = new Map();
  const items = new Map();
  const payments = new Map();
  const loans = new Map();
  for (const record of rows(target, 'finance')) {
    const f = clone(record.fields);
    const id = localIds.get(record.id);
    if (record.type === 'financeOperation') {
      if (f.ref !== null) f.ref = resolve(localIds, f.ref);
      operations.set(record.id, { id, syncId: record.id, ...f });
    } else if (record.type === 'financeShopItem') items.set(record.id, { id, syncId: record.id, ...f });
    else if (record.type === 'financePayment') {
      delete f.loanId;
      payments.set(record.id, { id, syncId: record.id, ...f });
    }
  }
  for (const record of rows(target, 'finance').filter(row => row.type === 'financeLoan')) {
    const f = clone(record.fields);
    const paymentIds = f.paymentIds;
    delete f.paymentIds;
    f.opId = resolve(localIds, f.opId, true);
    loans.set(record.id, {
      id: localIds.get(record.id),
      syncId: record.id,
      ...f,
      payments: listFor(payments, paymentIds)
    });
  }
  if (fullReplacement || selected.some(item => item.section === 'finance')) {
    state.finance = {
      operations: listFor(operations, target.sections.finance.order.operations),
      shopItems: listFor(items, target.sections.finance.order.shopItems),
      loans: listFor(loans, target.sections.finance.order.loans),
      settings: financeSettings ? clone(target.sections.finance.settings) : state.finance.settings
    };
  } else if (financeSettings) {
    // Настройка без выбранных движений не должна перестраивать местный реестр.
    state.finance.settings = clone(target.sections.finance.settings);
  }
  applySettings(state.settings, target, selectedGroups);
  return state;
}

/**
 * Входящая запись выбирается целиком. Неизвестное отсутствие не удаляет локальную
 * запись; связанные сущности нужно выбрать вместе. Результат содержит локальные
 * секреты и может устареть: до записи обязательны повторная сверка и backup.
 * @param {{localState:any, cloudSnapshot:any, selectedRecords:{section:string,id:string}[],
 * selectedSettings?:string[], includeFinanceSettings?:boolean, selectedPlannerDeletions?:string[], cryptoSource?:Crypto}} options
 * Selected deletions MUST separately be authenticated against cumulative history
 * tombstones by the caller; absence in cloudSnapshot is not that proof.
 */
export function preparePublicSnapshotApply(options) {
  const input = object(
    options,
    ['localState', 'cloudSnapshot', 'selectedRecords'],
    ['selectedSettings', 'includeFinanceSettings', 'selectedPlannerDeletions', 'cryptoSource']
  );
  validateJsonSnapshot(input.localState);
  publicSnapshotIdentityTypes(input.cloudSnapshot);
  const selected = array(input.selectedRecords, value => object(value, ['section', 'id']));
  const settingsGroups = array(input.selectedSettings || [], value => value);
  if (input.includeFinanceSettings !== undefined && typeof input.includeFinanceSettings !== 'boolean') throw invalid();
  const cloud = clone(input.cloudSnapshot);
  const localState = clone(input.localState);
  const local = buildPublicSnapshot(localState, { settingsSelections: cloud.sections.preferences.selections });
  // Проверяет совпадение типов ID на обеих сторонах.
  comparePublicSnapshots({ local, cloud });
  const deletions = array(input.selectedPlannerDeletions || [], id => {
    if (!isSyncId(id)) throw invalid();
    return id;
  });
  const removed = new Set(deletions);
  if (deletions.length > 10_000 || removed.size !== deletions.length) throw invalid();
  for (const id of deletions) {
    const prior = local.sections.planner.records.find(record => record.id === id);
    if (
      !prior ||
      prior.fields.source.kind !== 'manual' ||
      cloud.sections.planner.records.some(record => record.id === id) ||
      selected.some(record => record.id === id)
    )
      throw invalid();
  }
  const target = projection(local, cloud, selected, settingsGroups, input.includeFinanceSettings === true);
  target.sections.planner.records = target.sections.planner.records.filter(record => !removed.has(record.id));
  target.sections.planner.order = target.sections.planner.order.filter(id => !removed.has(id));
  if (reviewSnapshotDependencies(target).issues.length) throw invalid();
  const candidate = materialize(
    localState,
    local,
    target,
    selected,
    settingsGroups,
    input.includeFinanceSettings === true,
    input.cryptoSource
  );
  candidate.plannerEntries = candidate.plannerEntries.filter(record => !removed.has(record.syncId));
  const candidatePublic = buildPublicSnapshot(candidate, { settingsSelections: cloud.sections.preferences.selections });
  if (!samePublic(candidatePublic, target)) throw invalid();
  // После перезапуска нормализатор не должен терять или менять выбранные данные.
  const { ui: _ui, ...normalized } = normalizeState(candidate);
  const normalizedPublic = buildPublicSnapshot(normalized, {
    settingsSelections: cloud.sections.preferences.selections
  });
  if (!samePublic(normalizedPublic, target)) throw new Error('Выбранные данные не проходят проверку после перезапуска');
  return Object.freeze({
    status: 'prepared',
    selectedCount: selected.length + deletions.length,
    candidateState: () => clone(candidate),
    candidatePublicSnapshot: () => clone(target)
  });
}

/** Explicit WHOLE public file replacement. Absence removes records; no merge or tombstones.
 * Contacts/launch/login fields of retained local characters remain local. Caller must
 * authenticate the file, recheck it, ask for replacement consent and commit with backup.
 * @param {{localState:any,cloudSnapshot:any,cryptoSource?:Crypto}} options
 */
export function prepareFullPublicSnapshotReplace(options) {
  const input = object(options, ['localState', 'cloudSnapshot'], ['cryptoSource']);
  validateJsonSnapshot(input.localState);
  publicSnapshotIdentityTypes(input.cloudSnapshot);
  const target = clone(input.cloudSnapshot);
  if (reviewSnapshotDependencies(target).issues.length) throw invalid();
  const local = buildPublicSnapshot(input.localState, { settingsSelections: target.sections.preferences.selections });
  comparePublicSnapshots({ local, cloud: target });
  const selected = SECTIONS.flatMap(section => rows(target, section).map(record => ({ section, id: record.id })));
  const candidate = materialize(
    input.localState,
    local,
    target,
    selected,
    target.sections.preferences.selections,
    true,
    input.cryptoSource,
    true
  );
  const { ui, ...normalized } = normalizeState(candidate);
  if (
    !samePublic(
      buildPublicSnapshot(candidate, { settingsSelections: target.sections.preferences.selections }),
      target
    ) ||
    !samePublic(buildPublicSnapshot(normalized, { settingsSelections: target.sections.preferences.selections }), target)
  )
    throw invalid();
  return Object.freeze({ candidateState: () => clone(candidate) });
}
