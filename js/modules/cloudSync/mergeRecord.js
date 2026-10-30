// @ts-check
// Чистое трёхстороннее сравнение ОДНОЙ сущности. Не читает/не применяет state,
// не разрешает конфликты и не доказывает, что base действительно общая версия.
// Документы, ссылки на родителей, миграции, tombstones и проверки подлинности — задача вызывающего движка.
import { validateJsonSnapshot } from './envelope.js';

const MISSING = Symbol('missing');

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function validateRecord(record) {
  if (record === null) return;
  if (!plainObject(record) || typeof record.deleted !== 'boolean') throw new Error('Некорректная запись синхронизации');
  if (record.deleted) {
    if (!exactKeys(record, ['deleted'])) throw new Error('Некорректная метка удаления');
  } else if (!exactKeys(record, ['deleted', 'fields']) || !plainObject(record.fields)) {
    throw new Error('Некорректная запись синхронизации');
  }
}

// Для JSON порядок полей объекта не имеет значения; порядок элементов массива имеет.
function equal(left, right) {
  if (left === right) return true;
  if (left === MISSING || right === MISSING) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (plainObject(left) && plainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && equal(left[key], right[key]))
    );
  }
  return false;
}

function copy(value) {
  if (value === MISSING) return MISSING;
  return JSON.parse(JSON.stringify(value));
}

function conflictSide(value) {
  return value === MISSING ? { present: false } : { present: true, value: copy(value) };
}

function conflict(reason, path, base, local, remote) {
  return {
    reason,
    path,
    base: conflictSide(base),
    local: conflictSide(local),
    remote: conflictSide(remote)
  };
}

function mergeValue(base, local, remote, path, conflicts) {
  if (equal(local, remote)) return copy(local);
  if (equal(local, base)) return copy(remote);
  if (equal(remote, base)) return copy(local);
  // Массивы и замена типов считаются единым значением; слияние по индексам может терять данные.
  if (plainObject(base) && plainObject(local) && plainObject(remote)) {
    const result = {};
    const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();
    for (const key of keys) {
      const read = value => (Object.hasOwn(value, key) ? value[key] : MISSING);
      const next = mergeValue(read(base), read(local), read(remote), [...path, key], conflicts);
      if (next !== MISSING) result[key] = next;
    }
    return result;
  }
  const reason = base !== MISSING && (local === MISSING || remote === MISSING) ? 'delete-versus-edit' : 'field';
  conflicts.push(conflict(reason, path, base, local, remote));
  return MISSING;
}

/**
 * null = этой сущности ещё не было; {deleted:true} = сохранённая метка удаления;
 * {deleted:false, fields:{...}} = живая запись. При конфликте record всегда null.
 * Вызывающий обязан заранее проверить общий базовый документ, полный набор записей и
 * бизнес-схемы всех полей; эта функция не экспортирует/не сохраняет данные и не ведёт лог.
 * @param {{ base?: any, local?: any, remote?: any }} [options]
 */
export function mergeRecord({ base, local, remote } = {}) {
  validateJsonSnapshot({ base, local, remote });
  for (const record of [base, local, remote]) validateRecord(record);
  const conflicts = [];
  const result = record => ({ record: copy(record), conflicts });
  const stop = reason => {
    conflicts.push(
      conflict(
        reason,
        [],
        base === null ? MISSING : base,
        local === null ? MISSING : local,
        remote === null ? MISSING : remote
      )
    );
    return { record: null, conflicts };
  };

  if (base === null) {
    if (local === null && remote === null) return result(null);
    // Метка удаления без истории означает неполную базу; не угадываем её происхождение.
    if (local?.deleted || remote?.deleted) return stop('missing-base');
    if (local === null) return result(remote);
    if (remote === null) return result(local);
    return equal(local, remote) ? result(local) : stop('concurrent-create');
  }
  // Пропавшая запись — не метка удаления. Не считать неполный файл удалением данных.
  if (local === null || remote === null) throw new Error('Неполная история записи синхронизации');
  if (base.deleted && (!local.deleted || !remote.deleted)) return stop('restore-deleted');
  if (equal(local, remote)) return result(local);
  if (equal(local, base)) return result(remote);
  if (equal(remote, base)) return result(local);
  if (local.deleted || remote.deleted) return stop('delete-versus-edit');
  const fields = mergeValue(base.fields, local.fields, remote.fields, [], conflicts);
  if (conflicts.length) return { record: null, conflicts };
  return result({ deleted: false, fields });
}
