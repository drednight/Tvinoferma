// @ts-check
// Изолированный предварительный план для ОДНОЙ сущности. Не читает state, сеть или диск,
// ничего не сохраняет и не удостоверяет общую историю, схему, ссылки и актуальность версий.
// До интеграции необходимы их проверка, резервная копия, транзакционная запись и учёт
// невыбранных изменений на уровне происхождения полей. Не передавать секреты в UI/логи.
import { mergeRecord } from './mergeRecord.js';
import { validateJsonSnapshot } from './envelope.js';
import { array, boolean, object, text } from './exportSchema.js';

const MISSING = Symbol('missing');
// Дополнительный предел для трёх записей и списка выбора: не разворачивать огромные графы в памяти.
const MAX_REVIEW_UNITS = 8 * 1024 * 1024;

function checkBudget(root) {
  let units = 0;
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    units += 16 + (typeof value === 'string' ? value.length : 0);
    if (units > MAX_REVIEW_UNITS) throw new Error('Сравнение записи слишком большое');
    if (!value || typeof value !== 'object') continue;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        throw new Error('Некорректные данные сравнения');
      units += key.length;
      if (units > MAX_REVIEW_UNITS) throw new Error('Сравнение записи слишком большое');
      stack.push(descriptor.value);
    }
  }
}

function plain(value) {
  return value !== MISSING && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equal(left, right) {
  if (left === right) return true;
  if (left === MISSING || right === MISSING) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (plain(left) && plain(right)) {
    const keys = Object.keys(left).sort();
    return (
      keys.length === Object.keys(right).length &&
      keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
  }
  return false;
}

function clone(value) {
  if (value === MISSING || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  // JSON-снимок — дерево, а не граф: общие ссылки должны стать независимыми ветвями.
  return Object.fromEntries(Object.keys(value).map(key => [key, clone(value[key])]));
}

function detached(value) {
  try {
    return structuredClone(value);
  } catch {
    throw new Error('Некорректные данные сравнения');
  }
}

/** @typedef {{path: string[], kind: string, reason?: string, value?: any}} Change */

/** Только метаданные, не значения полей; сами поля могут содержать личные сведения. */
function describe(change) {
  const result = { path: [...change.path], kind: change.kind };
  if (change.reason) return { ...result, reason: change.reason };
  return result;
}

/** @param {Change[]} changes */
function examineValues(base, local, remote, path, changes) {
  // Уже одинаковые или исключительно локальные изменения не предлагаются к применению.
  if (equal(local, remote) || equal(base, remote)) return;
  if (plain(base) && plain(local) && plain(remote)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();
    const read = (value, key) => (Object.hasOwn(value, key) ? value[key] : MISSING);
    for (const key of keys)
      examineValues(read(base, key), read(local, key), read(remote, key), [...path, key], changes);
    return;
  }
  // Отсутствие поля не является подтверждением удаления. Вложенные tombstones ещё не разработаны.
  if (remote === MISSING) {
    changes.push({
      path,
      kind: equal(local, base) ? 'unverified_absence' : 'conflict',
      reason: equal(local, base) ? 'missing-field-history' : 'delete-versus-edit'
    });
  } else if (equal(local, base)) {
    changes.push({ path, kind: base === MISSING ? 'add_field' : 'change_field', value: clone(remote) });
  } else {
    changes.push({ path, kind: 'conflict', reason: local === MISSING ? 'delete-versus-edit' : 'concurrent-edit' });
  }
}

/** @returns {Change[]} */
function examineRecord(base, local, remote) {
  /** @type {Change[]} */
  const changes = [];
  if (base === null) {
    if (local?.deleted || remote?.deleted) return [{ path: [], kind: 'conflict', reason: 'missing-base' }];
    // Нет модели истории и проверки идентичности новой записи: не считаем null доказанным отсутствием.
    if (local === null && remote !== null) return [{ path: [], kind: 'unverified_identity', reason: 'missing-base' }];
    if (local !== null && remote !== null) {
      return equal(local, remote)
        ? [{ path: [], kind: 'unverified_identity', reason: 'missing-base' }]
        : [{ path: [], kind: 'conflict', reason: 'concurrent-create' }];
    }
    return changes;
  }
  // Пропавшие записи после существовавшей базы отклоняются внутри mergeRecord.
  if (base.deleted && (!local.deleted || !remote.deleted))
    return [{ path: [], kind: 'conflict', reason: 'restore-deleted' }];
  if (equal(local, remote) || equal(base, remote)) return changes;
  if (local.deleted || remote.deleted) {
    if (!local.deleted && remote.deleted && equal(base, local))
      return [{ path: [], kind: 'delete_record', value: clone(remote) }];
    return [{ path: [], kind: 'conflict', reason: 'delete-versus-edit' }];
  }
  examineValues(base.fields, local.fields, remote.fields, [], changes);
  return changes;
}

function applyProjectedField(projected, change) {
  const path = change.path;
  let parent = projected.fields;
  for (const key of path.slice(0, -1)) parent = parent[key];
  parent[path[path.length - 1]] = clone(change.value);
}

/**
 * Фиксирует независимые копии трёх состояний одной записи и позволяет выбрать входящие поля.
 * `base`, `local`, `remote` имеют тот же формат, что mergeRecord: null — нет записи;
 * {deleted:true} — метка; {deleted:false,fields:{...}} — живая запись.
 *
 * Контракт вызывающего: идентичность записи, общий предок, полнота и достоверность метки
 * удаления должны быть подтверждены отдельно. Возвращаемая запись — только кандидат в памяти;
 * она НЕ является проверенным импортом, публикацией или разрешением конфликтов.
 * @param {{base: any, local: any, remote: any}} options
 */
export function createSelectiveRecordReview(options) {
  // До любого чтения входа отклоняем getter'ы, циклы, чужие прототипы и опасные ключи.
  validateJsonSnapshot(options);
  checkBudget(options);
  const input = object(options, ['base', 'local', 'remote']);
  // structuredClone отклоняет Proxy; затем отделяем общие ссылки друг от друга, как в JSON.
  const { base, local, remote } = clone(detached(input));
  // Проверяет формат записи и неполную историю, но не доказывает саму историю.
  mergeRecord({ base, local, remote });
  const changes = examineRecord(base, local, remote);
  const byPath = new Map(changes.map(change => [JSON.stringify(change.path), change]));

  return Object.freeze({
    /** Метаданные различий не содержат значений полей. */
    changes() {
      return changes.map(describe);
    },
    /**
     * Незнакомый/повторный путь отклоняется, а не игнорируется. `confirmDeletion` — отдельное
     * подтверждение выбранного удаления; отсутствие поля не превращается в метку удаления.
     * @param {{selected: string[][], confirmDeletion?: boolean}} options
     */
    plan(options) {
      validateJsonSnapshot(options);
      checkBudget(options);
      const requested = detached(object(options, ['selected'], ['confirmDeletion']));
      const selected = array(requested.selected, path => array(path, text));
      const confirmDeletion = Object.hasOwn(requested, 'confirmDeletion') ? boolean(requested.confirmDeletion) : false;
      const selectedKeys = selected.map(path => JSON.stringify(path));
      if (new Set(selectedKeys).size !== selectedKeys.length || selectedKeys.some(key => !byPath.has(key))) {
        throw new Error('Выбор устарел или содержит неизвестное изменение');
      }
      const selectedSet = new Set(selectedKeys);
      const chosen = changes.filter(change => selectedSet.has(JSON.stringify(change.path)));
      const blocked = chosen.filter(change =>
        ['conflict', 'unverified_absence', 'unverified_identity'].includes(change.kind)
      );
      if (blocked.length) {
        return {
          status: 'needs_review',
          record: null,
          applied: [],
          pending: changes.map(describe),
          blocked: blocked.map(describe)
        };
      }
      if (chosen.some(change => change.kind === 'delete_record') && !confirmDeletion) {
        return { status: 'confirm_deletion', record: null, applied: [], pending: changes.map(describe), blocked: [] };
      }
      let record = clone(local);
      if (chosen.length) {
        let projected = clone(base);
        if (chosen.some(change => change.kind === 'delete_record')) {
          projected = clone(remote);
        } else {
          for (const change of chosen) applyProjectedField(projected, change);
        }
        const merged = mergeRecord({ base, local, remote: projected });
        // Не полагаемся только на собственный анализ: неожиданная неоднозначность блокирует план.
        if (merged.conflicts.length) {
          return {
            status: 'needs_review',
            record: null,
            applied: [],
            pending: changes.map(describe),
            blocked: merged.conflicts.map(conflict => ({
              path: [...conflict.path],
              kind: 'conflict',
              reason: conflict.reason
            }))
          };
        }
        record = merged.record;
      }
      return {
        status: 'planned',
        record,
        applied: chosen.map(describe),
        pending: changes.filter(change => !selectedSet.has(JSON.stringify(change.path))).map(describe),
        blocked: []
      };
    }
  });
}
