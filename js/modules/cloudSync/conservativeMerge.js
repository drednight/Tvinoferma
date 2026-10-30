// @ts-check
// Узкая трёхсторонняя модель без I/O. Вызывающий обязан доказать общий предок,
// повторно проверить облако и локальный файл и создать backup перед записью.
// Отсутствие и удаление не угадываются. Снимки могут содержать личные примечания:
// ни значения, ни исходные ошибки нельзя помещать в журнал.
import { object } from './exportSchema.js';
import { comparePublicSnapshots, publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { mergeRecord } from './mergeRecord.js';
import { reviewSnapshotDependencies } from './reviewDependencies.js';

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

// Без явного протокола удаления не считаем исчезновение ключей или элементов
// массива обычной правкой. Массив допускает только добавление в конец; изменения
// его прежних элементов остаются для отдельного согласования.
function retains(base, next) {
  if (Array.isArray(base)) {
    return Array.isArray(next) && base.length <= next.length && base.every((item, index) => equal(item, next[index]));
  }
  if (plain(base)) {
    return plain(next) && Object.keys(base).every(key => Object.hasOwn(next, key) && retains(base[key], next[key]));
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
function records(snapshot, section) {
  return new Map(snapshot.sections[section].records.map(record => [record.id, record]));
}
function noRemovedValues(before, after) {
  for (const section of SECTIONS) {
    const a = records(before, section);
    const b = records(after, section);
    if ([...a].some(([id, record]) => !b.has(id) || !retains(record.fields, b.get(id).fields))) return false;
  }
  return (
    retains(before.sections.finance.settings, after.sections.finance.settings) &&
    retains(before.sections.preferences.values, after.sections.preferences.values)
  );
}

/**
 * Строгая проверка одного перехода: прежние sync-ID и порядок сохраняются,
 * новые записи допустимы только в конце. Нет разрешения на удаление или запись.
 * @param {any} previous
 * @param {any} next
 */
export function conservativeTransition(previous, next) {
  const beforeIds = publicSnapshotIdentityTypes(previous);
  const afterIds = publicSnapshotIdentityTypes(next);
  comparePublicSnapshots({ local: previous, cloud: next });
  if (!retainsIds(beforeIds, afterIds)) return false;
  if (
    !equal(previous.sections.preferences.selections, next.sections.preferences.selections) ||
    SECTIONS.some(section => !appendedOrders(previous.sections[section].order, next.sections[section].order))
  )
    return false;
  return noRemovedValues(previous, next);
}

function mergeFields(base, local, cloud, conflicts, section, id = null) {
  const answer = mergeRecord({
    base: { deleted: false, fields: base },
    local: { deleted: false, fields: local },
    remote: { deleted: false, fields: cloud }
  });
  for (const conflict of answer.conflicts) {
    if (conflicts.length >= MAX_CONFLICTS) throw invalid();
    // Только описания, без значений. Даже ID/пути не следует журналировать.
    conflicts.push({ section, ...(id ? { id } : {}), path: [...conflict.path], reason: conflict.reason });
  }
  return answer.record?.fields || null;
}

/**
 * Объединяет существующие записи и ограниченные добавления в конец порядка,
 * без исчезновений и одновременных несовместимых правок. Шаблоны марафонов
 * с локальными вложенными ID пока не поддерживаются.
 * @param {{base:any,local:any,cloud:any}} options
 */
export function planConservativePublicMerge(options) {
  const input = object(options, ['base', 'local', 'cloud']);
  const base = structuredClone(input.base);
  const local = structuredClone(input.local);
  const cloud = structuredClone(input.cloud);
  // Проверка сравнения также сверяет типы уже существующих sync-ID.
  comparePublicSnapshots({ local: base, cloud: local });
  comparePublicSnapshots({ local: base, cloud });
  if (!conservativeTransition(base, local) || !conservativeTransition(base, cloud))
    return Object.freeze({ status: 'structure_or_deletion_unsupported' });
  const merged = structuredClone(local);
  const chosen = [];
  const settings = [];
  const conflicts = [];
  let unsupported = false;
  for (const section of SECTIONS) {
    const baseRecords = records(base, section);
    const localRecords = records(local, section);
    const cloudRecords = records(cloud, section);
    const order = mergeFields(
      { value: base.sections[section].order },
      { value: local.sections[section].order },
      { value: cloud.sections[section].order },
      conflicts,
      section
    );
    if (order) merged.sections[section].order = order.value;
    for (const target of merged.sections[section].records) {
      const original = baseRecords.get(target.id);
      const here = localRecords.get(target.id);
      const there = cloudRecords.get(target.id);
      if (!original) {
        // The same new sync-ID may only be accepted automatically if its entire
        // record is identical. Otherwise neither creation wins by timestamp.
        if (there && !equal(here, there)) {
          if (conflicts.length >= MAX_CONFLICTS) throw invalid();
          conflicts.push({ section, id: target.id, path: [], reason: 'concurrent-create' });
        }
        continue;
      }
      if (!here || !there || original.type !== here.type || original.type !== there.type) throw invalid();
      const before = {
        fields: original.fields,
        ...(Object.hasOwn(original, 'archived') ? { archived: original.archived } : {})
      };
      const current = { fields: here.fields, ...(Object.hasOwn(here, 'archived') ? { archived: here.archived } : {}) };
      const incoming = {
        fields: there.fields,
        ...(Object.hasOwn(there, 'archived') ? { archived: there.archived } : {})
      };
      const result = mergeFields(before, current, incoming, conflicts, section, target.id);
      if (!result) continue;
      target.fields = result.fields;
      if (Object.hasOwn(target, 'archived')) target.archived = result.archived;
      if (!equal(target, here)) {
        if (section === 'marathons' && target.type === 'marathonTemplate') unsupported = true;
        chosen.push({ section, id: target.id });
      }
    }
    for (const [id, incoming] of cloudRecords) {
      if (localRecords.has(id)) continue;
      if (baseRecords.has(id)) throw invalid();
      if (section === 'marathons' && incoming.type === 'marathonTemplate') unsupported = true;
      merged.sections[section].records.push(structuredClone(incoming));
      chosen.push({ section, id });
    }
  }
  const finance = mergeFields(
    base.sections.finance.settings,
    local.sections.finance.settings,
    cloud.sections.finance.settings,
    conflicts,
    'finance'
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
      group
    );
    if (!result) continue;
    merged.sections.preferences.values[group] = result;
    if (!equal(result, local.sections.preferences.values[group])) settings.push(group);
  }
  if (conflicts.length) return Object.freeze({ status: 'conflicts', conflicts: Object.freeze(conflicts) });
  if (unsupported) return Object.freeze({ status: 'incoming_section_unsupported' });
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
