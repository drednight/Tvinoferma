// @ts-check
// Guarded запись одного локального кандидата. Не является межпроцессной блокировкой,
// атомарной транзакцией с vault или защитой от согласованного отката. Снимки и
// свидетельства могут содержать секреты: не показывать и не журналировать.
import { preparationCheck } from './preparationDiagnostics.js';
import { state } from '../../core/state.js';
import { vaultStatus } from '../../core/secrets.js';
import {
  abortGuardedMigration,
  assertStateWriteAvailable,
  beginGuardedMigration,
  commitGuardedMigration,
  forgetLoadedState,
  haltAfterPartialStateChange,
  loadData
} from '../../core/storage.js';
import { isSyncId, validateJsonSnapshot } from './envelope.js';
import { object } from './exportSchema.js';

let active = false;
function invalid() {
  return new Error('Не удалось подготовить безопасную запись данных синхронизации');
}
function result(status, extra = {}) {
  return Object.freeze({ status, ...extra });
}
export function currentCloudStateSnapshot() {
  const { ui: _ui, ...persisted } = state;
  preparationCheck('snapshot', () => {
    try {
      validateJsonSnapshot(persisted);
    } catch (error) {
      // Повторная проверка только известных разделов, без чтения getter/динамических ключей.
      for (const section of [
        'characters',
        'archivedCharacters',
        'parties',
        'archivedParties',
        'marathons',
        'marathonTemplates',
        'plannerEntries',
        'finance',
        'settings'
      ]) {
        const descriptor = Object.getOwnPropertyDescriptor(persisted, section);
        if (descriptor && 'value' in descriptor)
          preparationCheck(section, () => validateJsonSnapshot({ value: descriptor.value }));
      }
      throw error;
    }
  });
  return JSON.parse(JSON.stringify(persisted));
}
function currentWitness() {
  return JSON.stringify(currentCloudStateSnapshot());
}
function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((v, i) => sameJson(v, right[i]))
    );
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  );
}

// saveNow здесь не вызывается: до сравнения он мог бы затереть файл другого
// процесса. Уже поставленные сохранения дожидаются в loadData. При vault в файле
// намеренно null вместо контактов; prepareForDisk проверяет vault отдельно.
// savedAt создаётся при каждой сериализации и не меняет state в памяти.
export function cloudSnapshotMatchesDisk(snapshot, disk) {
  if (!disk || typeof disk !== 'object' || Array.isArray(disk)) return false;
  try {
    validateJsonSnapshot(disk);
    const expected = structuredClone(snapshot);
    expected.savedAt = disk.savedAt;
    if (vaultStatus().ready && state.settings?.security?.useVault !== false) {
      expected.secretsInVault = true;
      expected.characters = expected.characters.map(character => ({ ...character, contacts: null }));
      expected.archivedCharacters = expected.archivedCharacters.map(character => ({ ...character, contacts: null }));
    }
    return sameJson(expected, disk);
  } catch {
    return false;
  }
}

// Identity-only режим не заменяет массивы/объекты приложения: устанавливает только
// ранее отсутствовавшие syncId на прежние сущности. Любое другое изменение отклоняется.
function identityAssignments(before, after, path = [], result = []) {
  if (before === after) return result;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') throw invalid();
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) throw invalid();
    before.forEach((item, index) => identityAssignments(item, after[index], [...path, index], result));
    return result;
  }
  const oldKeys = Object.keys(before);
  const newKeys = Object.keys(after);
  for (const key of oldKeys) {
    if (!Object.hasOwn(after, key)) throw invalid();
    identityAssignments(before[key], after[key], [...path, key], result);
  }
  for (const key of newKeys.filter(key => !Object.hasOwn(before, key))) {
    if (key !== 'syncId' || !isSyncId(after[key])) throw invalid();
    result.push({ path, syncId: after[key] });
  }
  return result;
}

/**
 * Внутренний одноразовый механизм: caller проверяет источник кандидата и смысл
 * подтверждения. Никаких действий до commit; перед записью сравнивает память,
 * диск и создаёт точный backup. Прямое использование не проверяет облачную историю.
 * @param {{original:any,candidate:any,backupLabel:string,selectedCount:number,identityOnly?:boolean}} options
 */
export function stageGuardedCloudStateWrite(options) {
  const input = object(options, ['original', 'candidate', 'backupLabel', 'selectedCount'], ['identityOnly']);
  if (
    typeof input.backupLabel !== 'string' ||
    !/^pre-cloud-[a-z-]{1,40}$/.test(input.backupLabel) ||
    !Number.isSafeInteger(input.selectedCount) ||
    input.selectedCount < 0 ||
    (input.identityOnly !== undefined && typeof input.identityOnly !== 'boolean')
  )
    throw invalid();
  validateJsonSnapshot(input.original);
  validateJsonSnapshot(input.candidate);
  if (
    Object.hasOwn(input.original, 'ui') ||
    Object.hasOwn(input.candidate, 'ui') ||
    Object.keys(input.original).length !== Object.keys(input.candidate).length ||
    Object.keys(input.original).some(key => !Object.hasOwn(input.candidate, key))
  )
    throw invalid();
  assertStateWriteAvailable();
  let original = structuredClone(input.original);
  let candidate = structuredClone(input.candidate);
  let witness = JSON.stringify(original);
  let candidateWitness = JSON.stringify(candidate);
  if (currentWitness() !== witness) throw invalid();
  const assignments = input.identityOnly ? identityAssignments(original, candidate) : null;
  if (assignments && assignments.length !== input.selectedCount) throw invalid();
  const count = input.selectedCount;
  let phase = 'ready';
  const clear = () => {
    original = null;
    witness = null;
    candidate = null;
    candidateWitness = null;
    phase = 'closed';
  };
  function unchanged(expected) {
    try {
      return currentWitness() === expected;
    } catch {
      return false;
    }
  }
  return Object.freeze({
    selectedCount: count,
    cancel() {
      if (phase === 'running') return result('in_progress');
      if (phase !== 'ready') return result('closed');
      clear();
      return result('cancelled');
    },
    /** @param {{confirmed:boolean}} confirmation */
    async commit(confirmation) {
      const answer = object(confirmation, ['confirmed']);
      if (typeof answer.confirmed !== 'boolean') throw invalid();
      if (phase !== 'ready') return result(phase === 'running' ? 'in_progress' : 'closed');
      if (!answer.confirmed) return result('confirmation_required');
      if (active) return result('busy');
      phase = 'running';
      active = true;
      let loaded = null;
      let backup = null;
      let mutationStarted = false;
      try {
        try {
          assertStateWriteAvailable();
        } catch {
          return result('storage_blocked');
        }
        if (!unchanged(witness)) return result('state_changed');
        try {
          loaded = await loadData();
        } catch {
          return result('storage_blocked');
        }
        if (!unchanged(witness)) return result('state_changed');
        if (!cloudSnapshotMatchesDisk(original, loaded)) return result('disk_changed_or_unsaved');
        try {
          backup = await beginGuardedMigration(loaded, input.backupLabel);
          loaded = null;
        } catch {
          return result('backup_unconfirmed_restart');
        }
        if (!unchanged(witness)) {
          abortGuardedMigration();
          return result('state_changed_after_backup_restart', { backup });
        }
        mutationStarted = true;
        if (assignments) {
          for (const entry of assignments) {
            let entity = state;
            for (const key of entry.path) entity = entity[key];
            entity.syncId = entry.syncId;
          }
        } else Object.assign(state, candidate);
        try {
          await commitGuardedMigration();
        } catch {
          haltAfterPartialStateChange();
          return result('write_unconfirmed_restart', { backup });
        }
        if (!unchanged(candidateWitness)) {
          haltAfterPartialStateChange();
          return result('state_changed_during_write_restart', { backup });
        }
        return result('applied', { backup, selectedCount: count });
      } catch {
        if (mutationStarted) {
          haltAfterPartialStateChange();
          return result('write_unconfirmed_restart', backup ? { backup } : {});
        }
        if (backup) {
          abortGuardedMigration();
          return result('state_changed_after_backup_restart', { backup });
        }
        return result('storage_blocked');
      } finally {
        if (loaded) forgetLoadedState(loaded);
        clear();
        active = false;
      }
    }
  });
}
