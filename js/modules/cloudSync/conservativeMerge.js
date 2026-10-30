// @ts-check
// Узкая трёхсторонняя модель без I/O. Вызывающий обязан доказать общий предок,
// повторно проверить облако и локальный файл и создать backup перед записью.
// Отсутствие и удаление не угадываются. Снимки могут содержать личные примечания:
// ни значения, ни исходные ошибки нельзя помещать в журнал.
import { array, object } from './exportSchema.js';
import { isSyncId } from './envelope.js';
import { comparePublicSnapshots, publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { mergeRecord } from './mergeRecord.js';
import { reviewSnapshotDependencies } from './reviewDependencies.js';
import { parseConservativeMergeChoices } from './conservativeMergeChoices.js';
import { STATS_HISTORY_LIMIT } from '../characters/statsHistory.js';
import {
  checkedPartyArchiveTransition,
  partyArchiveOrderTransition,
  preparePartyArchiveGroups,
  mergedPartyArchiveOrder
} from './partyArchiveMerge.js';

const SECTIONS = ['characters', 'parties', 'marathons', 'planner', 'finance'];
const MAX_CONFLICTS = 1000;

function invalid() {
  return new Error('Не удалось безопасно сравнить изменения с общей основой');
}
function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function equal(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => equal(item, right[index]))
    );
  }
  if (!plain(left) || !plain(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
}

// Recognize only the application's bounded newest-first history advance, not
// arbitrary erasure or timestamp-based matching. Some exact, unambiguous old
// prefix must survive; the new head must not masquerade as an old entry.
function cappedStatsAdvance(base, next) {
  if (!base.length || base.length > STATS_HISTORY_LIMIT || next.length !== STATS_HISTORY_LIMIT) return false;
  let matches = 0;
  for (let added = 1; added < next.length; added++) {
    const kept = next.length - added;
    if (kept >= base.length) continue;
    const prefix = base.slice(0, kept);
    if (
      prefix.every((entry, index) => equal(entry, next[added + index])) &&
      prefix.every(entry => base.filter(old => equal(entry, old)).length === 1) &&
      next.slice(0, added).every(entry => !base.some(old => equal(entry, old)))
    )
      matches++;
  }
  return matches === 1;
}

// Без отдельного протокола удаления не считаем исчезновение ключей или элементов
// массива обычной правкой, кроме явно перечисленных копируемых значений ниже.
// Нельзя незаметно заменить или удалить старую sync-сущность;
// анонимные объекты должны совпадать. Для заданий марафона отдельное объединение
// ниже использует sync-ID, прочие массивы остаются единым конфликтующим полем.
function retains(base, next, path = [], recordType = null) {
  // These are copied values, NOT sync entities or an entity's identity/order.
  // A full authenticated snapshot may replace them, including clearing a list
  // or a per-date status. mergeRecord still detects delete-versus-edit and
  // conflicting arrays; final materialization validates the business schema.
  const valueField =
    (recordType === 'marathonTemplate' && path.length === 1 && ['tasks', 'bonuses'].includes(path[0])) ||
    (recordType === 'character' && path.length === 1 && path[0] === 'tags') ||
    (recordType === 'plannerEntry' && path.length === 1 && path[0] === 'statusByDate') ||
    (recordType === 'preferences' &&
      path.length === 2 &&
      path[0] === 'navigation' &&
      ['hidden', 'order'].includes(path[1]));
  if (valueField) return Array.isArray(base) ? Array.isArray(next) : plain(base) && plain(next);
  if (Array.isArray(base)) {
    if (!Array.isArray(next) || base.length > next.length) return false;
    if (recordType === 'character' && path.length === 1 && ['coinHistory', 'statsHistory'].includes(path[0])) {
      // Истории в приложении добавляют новые записи сверху. Старые записи
      // должны остаться точной подпоследовательностью, включая повторы; только
      // у характеристик допустим проверяемый сдвиг при штатном лимите 10.
      let index = 0;
      for (const entry of next) if (index < base.length && equal(entry, base[index])) index++;
      return index === base.length || (path[0] === 'statsHistory' && cappedStatsAdvance(base, next));
    }
    // Форма и повторяющийся якорь не доказывают идентичность. Разрешаем только
    // явно известные поля связи из схемы; неизвестные объекты сравниваем целиком.
    const marathonItems =
      recordType === 'marathon' &&
      ((path.length === 1 && ['tasks', 'bonuses'].includes(path[0])) ||
        (path.length === 3 && path[0] === 'tasks' && path[2] === 'rewards'));
    const partyLinks = recordType === 'party' && path.length === 1 && path[0] === 'memberLinks';
    const siteQuests =
      recordType === 'character' && path.length === 2 && path[0] === 'marathonData' && path[1] === 'quests';
    const anchorOf = item => {
      if (!plain(item)) return null;
      const key = marathonItems ? 'id' : partyLinks ? 'characterId' : siteQuests ? 'title' : null;
      if (!key || !Object.hasOwn(item, key)) return null;
      if (siteQuests ? typeof item[key] !== 'string' || !item[key].trim() : !isSyncId(item[key])) return null;
      return { key, fingerprint: JSON.stringify([key, item[key]]) };
    };
    const counts = new Map();
    for (const item of base) {
      const anchor = anchorOf(item);
      if (anchor) counts.set(anchor.fingerprint, (counts.get(anchor.fingerprint) || 0) + 1);
    }
    return base.every((item, index) => {
      const following = next[index];
      if (!plain(item) || !plain(following)) return equal(item, following);
      const anchor = anchorOf(item);
      if (!anchor || counts.get(anchor.fingerprint) !== 1) return equal(item, following);
      // Название задания сайта — только ограниченное сопоставление прогресса,
      // а не разрешение подменять его описание или цель.
      if (siteQuests && (!equal(item.description, following.description) || !equal(item.total, following.total)))
        return false;
      return (
        Object.hasOwn(following, anchor.key) &&
        equal(item[anchor.key], following[anchor.key]) &&
        retains(item, following, [...path, index], recordType)
      );
    });
  }
  if (plain(base)) {
    return (
      plain(next) &&
      Object.keys(base).every(
        key => Object.hasOwn(next, key) && retains(base[key], next[key], [...path, key], recordType)
      )
    );
  }
  return true;
}
function retainsIds(left, right) {
  return [...left].every(([id, type]) => right.get(id) === type);
}
function appendedOrders(base, next) {
  if (Array.isArray(base))
    return Array.isArray(next) && base.length <= next.length && base.every((value, index) => equal(value, next[index]));
  return (
    plain(base) &&
    plain(next) &&
    Object.keys(base).every(key => Object.hasOwn(next, key) && appendedOrders(base[key], next[key]))
  );
}
// A character moving between active/archive keeps the SAME identity. Only the
// residents' relative order is retained; transfers and new characters must be
// appended, exactly like archiveCharacters/restoreCharacter. No ID may vanish.
function characterOrderTransition(previous, next) {
  const after = records(next, 'characters');
  return ['active', 'archived'].every(bucket => {
    const archived = bucket === 'archived';
    const staying = previous.sections.characters.order[bucket].filter(id => after.get(id)?.archived === archived);
    return appendedOrders(staying, next.sections.characters.order[bucket]);
  });
}
function mergeCharacterOrder(base, local, cloud, merged, conflicts) {
  const targets = records(merged, 'characters');
  const result = {};
  for (const bucket of ['active', 'archived']) {
    const archived = bucket === 'archived';
    const filter = snapshot =>
      snapshot.sections.characters.order[bucket].filter(id => targets.get(id)?.archived === archived);
    // Membership comes from the merged record, never from a missing order ID.
    const order = mergeAppendedOrder(filter(base), filter(local), filter(cloud), conflicts, 'characters', [bucket]);
    if (!order) return null;
    result[bucket] = order;
  }
  return result;
}
// Both inputs have already passed appendedOrders: preserve the existing order
// and each side's new relative order. A shared prefix is unambiguous; further
// overlapping additions may impose contradictory ordering and must be reviewed.
function mergeAppendedOrder(base, local, cloud, conflicts, section, path = []) {
  if (Array.isArray(base)) {
    if (equal(local, cloud)) return structuredClone(local);
    if (equal(base, local)) return structuredClone(cloud);
    if (equal(base, cloud)) return structuredClone(local);
    const left = local.slice(base.length);
    const right = cloud.slice(base.length);
    let common = 0;
    while (common < left.length && common < right.length && left[common] === right[common]) common++;
    const rest = new Set(left.slice(common));
    if (right.slice(common).some(id => rest.has(id))) {
      if (conflicts.length >= MAX_CONFLICTS) throw invalid();
      conflicts.push({ section, path, reason: 'concurrent-order' });
      return null;
    }
    return [...base, ...left, ...right.slice(common)];
  }
  const result = {};
  for (const key of Object.keys(base)) {
    const merged = mergeAppendedOrder(base[key], local[key], cloud[key], conflicts, section, [...path, key]);
    if (!merged) return null;
    result[key] = merged;
  }
  return result;
}
function records(snapshot, section) {
  return new Map(snapshot.sections[section].records.map(record => [record.id, record]));
}
function noRemovedValues(before, after) {
  for (const section of SECTIONS) {
    const a = records(before, section);
    const b = records(after, section);
    if ([...a].some(([id, record]) => !b.has(id) || !retains(record.fields, b.get(id).fields, [], record.type)))
      return false;
  }
  return (
    retains(before.sections.finance.settings, after.sections.finance.settings) &&
    retains(before.sections.preferences.values, after.sections.preferences.values, [], 'preferences')
  );
}

/**
 * Строгая проверка одного перехода: прежние sync-ID сохраняются. Персонаж может
 * перейти между активными и архивными без перестановки оставшихся. Для пати
 * проверяются точные связанные изменения состава, роли и порядка; переносы и
 * новые записи допустимы только в конце. Копируемые значения могут заменяться;
 * нет разрешения на удаление sync-сущностей или запись state.
 * @param {any} previous
 * @param {any} next
 */
export function conservativeTransition(previous, next) {
  const beforeIds = publicSnapshotIdentityTypes(previous);
  const afterIds = publicSnapshotIdentityTypes(next);
  comparePublicSnapshots({ local: previous, cloud: next });
  if (!retainsIds(beforeIds, afterIds)) return false;
  const partyTransition = checkedPartyArchiveTransition(previous, next);
  if (!partyTransition) return false;
  if (
    !equal(previous.sections.preferences.selections, next.sections.preferences.selections) ||
    SECTIONS.some(section =>
      section === 'characters'
        ? !characterOrderTransition(previous, next)
        : section === 'parties' && partyTransition.moved.length
          ? !partyArchiveOrderTransition(previous, next)
          : !appendedOrders(previous.sections[section].order, next.sections[section].order)
    )
  )
    return false;
  return noRemovedValues(previous, partyTransition.snapshot);
}

function setConflictValue(root, path, side) {
  if (!path.length) throw invalid();
  let target = root;
  for (const key of path.slice(0, -1)) {
    if (!plain(target) || !Object.hasOwn(target, key)) throw invalid();
    target = target[key];
  }
  if (!plain(target)) throw invalid();
  const key = path.at(-1);
  if (side.present) target[key] = structuredClone(side.value);
  else delete target[key];
}
function choiceUsesCloud(choices, section, id) {
  if (section === 'preferences') return choices.cloudSettings.includes(id);
  if (section === 'finance' && !id) return choices.cloudFinanceSettings;
  return choices.cloudRecords.some(row => row.section === section && row.id === id);
}
function mergeFields(base, local, cloud, conflicts, section, id = null, choices = null, prefix = []) {
  const wrap = fields => ({ deleted: false, fields });
  const answer = mergeRecord({ base: wrap(base), local: wrap(local), remote: wrap(cloud) });
  if (answer.conflicts.length && choices) {
    const left = structuredClone(local);
    const right = structuredClone(cloud);
    const useCloud = choiceUsesCloud(choices, section, id);
    for (const conflict of answer.conflicts)
      setConflictValue(useCloud ? left : right, conflict.path, useCloud ? conflict.remote : conflict.local);
    // Re-run the same three-way merger; independent changes must survive and
    // an unexpected residual ambiguity must still stop the operation.
    const resolved = mergeRecord({ base: wrap(base), local: wrap(left), remote: wrap(right) });
    if (resolved.conflicts.length || !resolved.record) throw invalid();
    return resolved.record.fields;
  }
  for (const conflict of answer.conflicts) {
    if (conflicts.length >= MAX_CONFLICTS) throw invalid();
    // Только описания, без значений. Даже ID/пути не следует журналировать.
    conflicts.push({ section, ...(id ? { id } : {}), path: [...prefix, ...conflict.path], reason: conflict.reason });
  }
  return answer.record?.fields || null;
}

// Marathon tasks, rewards and bonuses have their own stable sync IDs. Merge
// their fields by identity so an edit to one task never replaces a different
// task's independent edit. Other arrays remain atomic and are not zipped.
function mergeNestedEntities(base, local, cloud, conflicts, section, parentId, choices, path, withRewards = false) {
  const byId = rows => new Map(rows.map(row => [row.id, row]));
  const before = byId(base);
  const here = byId(local);
  const there = byId(cloud);
  const ids = mergeAppendedOrder(
    base.map(row => row.id),
    local.map(row => row.id),
    cloud.map(row => row.id),
    conflicts,
    section,
    [...path, 'order']
  );
  if (!ids) return null;
  const result = [];
  let blocked = false;
  for (const id of ids) {
    const original = before.get(id);
    const current = here.get(id);
    const incoming = there.get(id);
    if (!original) {
      if (current && incoming && !equal(current, incoming)) {
        if (!choices) {
          if (conflicts.length >= MAX_CONFLICTS) throw invalid();
          conflicts.push({ section, id: parentId, path: [...path, id], reason: 'concurrent-create' });
          blocked = true;
          continue;
        }
        result.push(structuredClone(choiceUsesCloud(choices, section, parentId) ? incoming : current));
      } else result.push(structuredClone(current || incoming));
      continue;
    }
    if (!current || !incoming) throw invalid();
    const a = structuredClone(original);
    const b = structuredClone(current);
    const c = structuredClone(incoming);
    if (withRewards) {
      const rewards = mergeNestedEntities(a.rewards, b.rewards, c.rewards, conflicts, section, parentId, choices, [
        ...path,
        id,
        'rewards'
      ]);
      if (!rewards) {
        blocked = true;
        continue;
      }
      a.rewards = structuredClone(rewards);
      b.rewards = structuredClone(rewards);
      c.rewards = structuredClone(rewards);
    }
    const merged = mergeFields(a, b, c, conflicts, section, parentId, choices, [...path, id]);
    if (merged) result.push(merged);
    else blocked = true;
  }
  return blocked ? null : result;
}

/**
 * Объединяет существующие записи и ограниченные добавления в конец порядка,
 * без исчезновений sync-сущностей. Копируемые значения шаблона и известные
 * списки без ID заменяются целиком; несовместимые правки требуют выбора.
 * @param {{base:any,local:any,cloud:any,resolution?:any}} options
 */
function planWithoutPlannerDeletions(options) {
  const input = object(options, ['base', 'local', 'cloud'], ['resolution']);
  const choices = input.resolution ? parseConservativeMergeChoices(input.resolution) : null;
  const base = structuredClone(input.base);
  const local = structuredClone(input.local);
  const cloud = structuredClone(input.cloud);
  // Проверка сравнения также сверяет типы уже существующих sync-ID.
  comparePublicSnapshots({ local: base, cloud: local });
  comparePublicSnapshots({ local: base, cloud });
  if (!conservativeTransition(base, local) || !conservativeTransition(base, cloud))
    return Object.freeze({ status: 'structure_or_deletion_unsupported' });
  const partyGroups = preparePartyArchiveGroups(base, local, cloud, choices);
  if (!partyGroups) return Object.freeze({ status: 'structure_or_deletion_unsupported' });
  if (partyGroups.conflicts.length > MAX_CONFLICTS) throw invalid();
  const merged = structuredClone(local);
  const chosen = [];
  const settings = [];
  const conflicts = [...partyGroups.conflicts];
  for (const section of SECTIONS) {
    const baseRecords = records(base, section);
    const localRecords = records(local, section);
    const cloudRecords = records(cloud, section);
    const order =
      section === 'characters' || (section === 'parties' && partyGroups.changed)
        ? null
        : mergeAppendedOrder(
            base.sections[section].order,
            local.sections[section].order,
            cloud.sections[section].order,
            conflicts,
            section
          );
    if (order) merged.sections[section].order = order;
    for (const target of merged.sections[section].records) {
      const original = baseRecords.get(target.id);
      const here = localRecords.get(target.id);
      const there = cloudRecords.get(target.id);
      if (!original) {
        // The same new sync-ID may only be accepted automatically if its entire
        // record is identical. Otherwise neither creation wins by timestamp.
        if (there && !equal(here, there)) {
          if (choices) {
            if (choiceUsesCloud(choices, section, target.id)) {
              Object.assign(target, structuredClone(there));
              chosen.push({ section, id: target.id });
            }
          } else {
            if (conflicts.length >= MAX_CONFLICTS) throw invalid();
            conflicts.push({ section, id: target.id, path: [], reason: 'concurrent-create' });
          }
        }
        continue;
      }
      if (!here || !there || original.type !== here.type || original.type !== there.type) throw invalid();
      const before = {
        fields: structuredClone(original.fields),
        ...(Object.hasOwn(original, 'archived') ? { archived: original.archived } : {})
      };
      const current = {
        fields: structuredClone(here.fields),
        ...(Object.hasOwn(here, 'archived') ? { archived: here.archived } : {})
      };
      const incoming = {
        fields: structuredClone(there.fields),
        ...(Object.hasOwn(there, 'archived') ? { archived: there.archived } : {})
      };
      if (target.type === 'marathon') {
        const tasks = mergeNestedEntities(
          before.fields.tasks,
          current.fields.tasks,
          incoming.fields.tasks,
          conflicts,
          section,
          target.id,
          choices,
          ['fields', 'tasks'],
          true
        );
        const bonuses = mergeNestedEntities(
          before.fields.bonuses,
          current.fields.bonuses,
          incoming.fields.bonuses,
          conflicts,
          section,
          target.id,
          choices,
          ['fields', 'bonuses']
        );
        if (!tasks || !bonuses) continue;
        for (const item of [before, current, incoming]) {
          item.fields.tasks = structuredClone(tasks);
          item.fields.bonuses = structuredClone(bonuses);
        }
      }
      const result = mergeFields(before, current, incoming, conflicts, section, target.id, choices);
      if (!result) continue;
      target.fields = result.fields;
      if (Object.hasOwn(target, 'archived')) target.archived = result.archived;
      if (!equal(target, here)) {
        chosen.push({ section, id: target.id });
      }
    }
    for (const [id, incoming] of cloudRecords) {
      if (localRecords.has(id)) continue;
      if (baseRecords.has(id)) throw invalid();
      // Новый шаблон не заменяет локальные вложенные задания: их ID создаются
      // отдельно при материализации. Вложенные значения не получают sync-ID.
      merged.sections[section].records.push(structuredClone(incoming));
      chosen.push({ section, id });
    }
    if (section === 'characters') {
      const characterOrder = mergeCharacterOrder(base, local, cloud, merged, conflicts);
      if (characterOrder) merged.sections.characters.order = characterOrder;
    }
  }
  if (partyGroups.changed) {
    partyGroups.apply(merged);
    merged.sections.parties.order = mergedPartyArchiveOrder(input.local, input.cloud, merged);
    chosen.length = 0;
    for (const section of SECTIONS) {
      const original = records(input.local, section);
      for (const record of merged.sections[section].records)
        if (!equal(original.get(record.id), record)) chosen.push({ section, id: record.id });
    }
  }
  const finance = mergeFields(
    base.sections.finance.settings,
    local.sections.finance.settings,
    cloud.sections.finance.settings,
    conflicts,
    'finance',
    null,
    choices
  );
  if (finance) merged.sections.finance.settings = finance;
  const includeFinanceSettings = !!finance && !equal(finance, local.sections.finance.settings);
  for (const group of local.sections.preferences.selections) {
    const result = mergeFields(
      base.sections.preferences.values[group],
      local.sections.preferences.values[group],
      cloud.sections.preferences.values[group],
      conflicts,
      'preferences',
      group,
      choices
    );
    if (!result) continue;
    merged.sections.preferences.values[group] = result;
    if (!equal(result, local.sections.preferences.values[group])) settings.push(group);
  }
  if (conflicts.length) return Object.freeze({ status: 'conflicts', conflicts: Object.freeze(conflicts) });
  publicSnapshotIdentityTypes(merged);
  if (reviewSnapshotDependencies(merged).issues.length) return Object.freeze({ status: 'dependencies_unresolved' });
  // Вызывающий получает независимые копии; модель не удостоверяет историю и не пишет state.
  return Object.freeze({
    status: 'prepared',
    selectedCount: chosen.length + settings.length + (includeFinanceSettings ? 1 : 0),
    snapshot: () => structuredClone(merged),
    selectedRecords: () => structuredClone(chosen),
    selectedSettings: () => [...settings],
    includeFinanceSettings
  });
}

function plannerTombstones(value) {
  const ids = array(value, id => {
    if (!isSyncId(id)) throw invalid();
    return id;
  });
  if (ids.length > 10_000 || new Set(ids).size !== ids.length) throw invalid();
  return new Set(ids);
}
function withoutPlannerRecords(snapshot, deleted) {
  const result = structuredClone(snapshot);
  result.sections.planner.records = result.sections.planner.records.filter(record => !deleted.has(record.id));
  result.sections.planner.order = result.sections.planner.order.filter(id => !deleted.has(id));
  return result;
}

/** Only the caller's authenticated cumulative v3 tombstones may relax a transition.
 * Absence, legacy markers, non-planner removals and guild entries remain blocked.
 * @param {any} previous @param {any} next @param {string[]} tombstones
 */
export function conservativePlannerTransition(previous, next, tombstones) {
  comparePublicSnapshots({ local: previous, cloud: next });
  const declared = plannerTombstones(tombstones);
  const after = new Set(next.sections.planner.records.map(record => record.id));
  if ([...declared].some(id => after.has(id))) return false;
  const removed = new Set();
  for (const record of previous.sections.planner.records) {
    if (after.has(record.id)) continue;
    if (!declared.has(record.id) || record.fields.source.kind !== 'manual') return false;
    removed.add(record.id);
  }
  return conservativeTransition(withoutPlannerRecords(previous, removed), next);
}

/**
 * A destructive cloud choice is required for EVERY marked record still present
 * locally, even if its fields did not change. Unchecked means keep the local
 * record and stop adoption, never resurrect its tombstoned identity in a child.
 * An explicit plannerCopies choice instead preserves the LOCAL fields under a
 * fresh, collision-checked ID while still removing the tombstoned old identity.
 * The model itself does not authenticate cloudPlannerTombstones or do any I/O.
 * @param {{base:any,local:any,cloud:any,resolution?:any,cloudPlannerTombstones?:string[]}} options
 */
export function planConservativePublicMerge(options) {
  const input = object(options, ['base', 'local', 'cloud'], ['resolution', 'cloudPlannerTombstones']);
  const declared = plannerTombstones(input.cloudPlannerTombstones || []);
  const choices = input.resolution ? parseConservativeMergeChoices(input.resolution) : null;
  if (!declared.size && choices?.plannerCopies) throw invalid();
  if (!declared.size)
    return planWithoutPlannerDeletions({
      base: input.base,
      local: input.local,
      cloud: input.cloud,
      ...(input.resolution ? { resolution: input.resolution } : {})
    });
  comparePublicSnapshots({ local: input.base, cloud: input.local });
  comparePublicSnapshots({ local: input.base, cloud: input.cloud });
  if (!conservativePlannerTransition(input.base, input.cloud, [...declared]))
    return Object.freeze({ status: 'structure_or_deletion_unsupported' });
  const baseRecords = records(input.base, 'planner');
  const localRecords = records(input.local, 'planner');
  const removals = [];
  for (const id of declared) {
    const local = localRecords.get(id);
    if (!local) continue;
    if (!baseRecords.has(id) || local.fields.source.kind !== 'manual')
      return Object.freeze({ status: 'deleted_identity_resurrection' });
    removals.push(id);
  }
  const copies = choices?.plannerCopies || [];
  const occupied = new Set([
    ...declared,
    ...publicSnapshotIdentityTypes(input.base).keys(),
    ...publicSnapshotIdentityTypes(input.local).keys(),
    ...publicSnapshotIdentityTypes(input.cloud).keys()
  ]);
  if (copies.some(row => !removals.includes(row.id) || occupied.has(row.newId))) throw invalid();
  const copied = new Set(copies.map(row => row.id));
  const plan = planWithoutPlannerDeletions({
    base: withoutPlannerRecords(input.base, declared),
    local: withoutPlannerRecords(input.local, declared),
    cloud: input.cloud,
    ...(choices ? { resolution: choices } : {})
  });
  if (!['prepared', 'conflicts'].includes(plan.status)) return plan;
  const deletionConflicts = removals.map(id => ({
    section: 'planner',
    id,
    path: ['deletion'],
    reason: 'cloud-planner-deletion'
  }));
  if (!choices && deletionConflicts.length) {
    const conflicts = [...(plan.status === 'conflicts' ? plan.conflicts : []), ...deletionConflicts];
    if (conflicts.length > MAX_CONFLICTS) throw invalid();
    return Object.freeze({ status: 'conflicts', conflicts: Object.freeze(conflicts) });
  }
  if (choices && removals.some(id => !choiceUsesCloud(choices, 'planner', id) && !copied.has(id)))
    return Object.freeze({ status: 'deletion_not_accepted' });
  if (plan.status !== 'prepared') return plan;
  const merged = plan.snapshot();
  const selected = plan.selectedRecords();
  for (const { id, newId } of copies) {
    merged.sections.planner.records.push({ ...structuredClone(localRecords.get(id)), id: newId });
    merged.sections.planner.order.push(newId);
    selected.push({ section: 'planner', id: newId });
  }
  publicSnapshotIdentityTypes(merged);
  if (reviewSnapshotDependencies(merged).issues.length) return Object.freeze({ status: 'dependencies_unresolved' });
  return Object.freeze({
    ...plan,
    snapshot: () => structuredClone(merged),
    selectedRecords: () => structuredClone(selected),
    selectedCount: plan.selectedCount + removals.length + copies.length,
    selectedPlannerDeletions: () => [...removals]
  });
}
