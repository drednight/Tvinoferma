// @ts-check
// Проверенная локальная основа для первичной подготовки. Ничего не отправляет.
// Не является межпроцессной транзакцией или резервной копией vault: другой процесс
// может изменить файл после проверки. Значения и исходные ошибки не журналировать.
import {
  abortGuardedMigration,
  assertStateWriteAvailable,
  beginGuardedMigration,
  finishGuardedBackup,
  forgetLoadedState,
  loadData
} from '../../core/storage.js';
import { object } from './exportSchema.js';
import { currentCloudStateSnapshot, cloudSnapshotMatchesDisk } from './guardedStateWrite.js';
import { requireResolvedSelectiveApply } from './pendingSelectiveApply.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { parseCloudModifiedTime } from './providers/modifiedTime.js';

function result(status, extra = {}) {
  return Object.freeze({ status, ...extra });
}

/**
 * Только сохранённое состояние с подготовленными sync-ID. Возвращённые снимки
 * остаются внутри механизма синхронизации; backup содержит state, но не vault.
 * При изменении памяти во время копирования обычная запись блокируется до проверки.
 * @param {{settingsSelections?:string[]}} [options]
 */
export async function captureInitialCloudBaseline(options = {}) {
  const input = object(options, [], ['settingsSelections']);
  if (input.settingsSelections !== undefined && !Array.isArray(input.settingsSelections))
    throw new Error('Не удалось подготовить локальную основу синхронизации');
  let original;
  let publicSnapshot;
  let witness;
  let loaded = null;
  let backup = null;
  let copying = false;
  try {
    try {
      assertStateWriteAvailable();
      original = currentCloudStateSnapshot();
      requireResolvedSelectiveApply(original.settings);
      publicSnapshot = buildPublicSnapshot(original, { settingsSelections: input.settingsSelections || [] });
      witness = JSON.stringify(original);
    } catch {
      return result('data_unprepared');
    }
    try {
      loaded = await loadData();
    } catch {
      return result('storage_blocked');
    }
    if (JSON.stringify(currentCloudStateSnapshot()) !== witness) return result('state_changed');
    if (!cloudSnapshotMatchesDisk(original, loaded)) return result('disk_changed_or_unsaved');
    const localSavedAt = parseCloudModifiedTime(loaded.savedAt);
    copying = true;
    try {
      backup = await beginGuardedMigration(loaded, 'pre-cloud-baseline');
      loaded = null;
    } catch {
      return result('backup_unconfirmed_restart');
    }
    if (JSON.stringify(currentCloudStateSnapshot()) !== witness) {
      abortGuardedMigration();
      copying = false;
      return result('state_changed_after_backup_restart', { backup });
    }
    finishGuardedBackup();
    copying = false;
    let closed = false;
    return Object.freeze({
      status: 'ready',
      backup,
      localSavedAt,
      // Снимок не содержит структурированных контактов/паролей или путей, но
      // произвольные заметки пользователь может заполнить секретами вручную.
      getPublicSnapshot() {
        if (closed || !publicSnapshot) throw new Error('Локальная основа уже закрыта');
        return structuredClone(publicSnapshot);
      },
      async stillCurrentAndSaved() {
        if (closed) return false;
        let latest = null;
        try {
          assertStateWriteAvailable();
          if (JSON.stringify(currentCloudStateSnapshot()) !== witness) return false;
          latest = await loadData();
          return (
            !closed &&
            JSON.stringify(currentCloudStateSnapshot()) === witness &&
            cloudSnapshotMatchesDisk(original, latest)
          );
        } catch {
          return false;
        } finally {
          if (latest) forgetLoadedState(latest);
        }
      },
      close() {
        closed = true;
        original = null;
        witness = null;
        publicSnapshot = null;
      }
    });
  } catch {
    if (copying) {
      abortGuardedMigration();
      return result('state_changed_after_backup_restart', backup ? { backup } : {});
    }
    return result('storage_blocked');
  } finally {
    if (loaded) forgetLoadedState(loaded);
  }
}
