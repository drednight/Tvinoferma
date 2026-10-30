// @ts-check
// js/core/storageAdapters/tauriAdapter.js
// Хранилище desktop-версии: все операции с файлами выполняет Rust (src-tauri/src/commands),
// state.json заменяется через проверенный временный файл, бэкапы создаются/ротируются в Rust.
// Гарантии файловой системы и восстановление после сбоя Windows требуют отдельной проверки.

import { invoke } from '@tauri-apps/api/core';
import { classifyNativeStateWriteFailure } from '../stateWriteOutcome.js';
import { createStateReadWitness } from './stateReadWitness.js';
import { createBackupReviewStore, readBackupSummary } from './backupReview.js';

const readWitness = createStateReadWitness();
const backupReviews = createBackupReviewStore();

// SHA-256 witnesses identify exact bytes at review time. They are kept only in
// memory and never prove authenticity, freshness, or vault consistency.
function nativeWitness(response) {
  const witnessDescriptor = response && Object.getOwnPropertyDescriptor(response, 'witness');
  const witness = witnessDescriptor && 'value' in witnessDescriptor ? witnessDescriptor.value : null;
  if (!witness || typeof witness !== 'object' || Array.isArray(witness)) throw new Error('invalid');
  const descriptors = Object.getOwnPropertyDescriptors(witness);
  const keys = Reflect.ownKeys(witness);
  if (keys.length !== 2 || !keys.includes('backupSha256') || !keys.includes('currentSha256'))
    throw new Error('invalid');
  const backup = descriptors.backupSha256;
  const current = descriptors.currentSha256;
  if (!backup || !current || !('value' in backup) || !('value' in current)) throw new Error('invalid');
  const valid = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!valid(backup.value) || (current.value !== null && !valid(current.value))) throw new Error('invalid');
  return { backupSha256: backup.value, currentSha256: current.value };
}

export const tauriAdapter = {
  async saveState(data) {
    try {
      const response = await invoke('save_state', { payload: data });
      // Rust Result<(), String> подтверждается только null/undefined.
      if (response !== null && response !== undefined) throw new Error('Некорректный ответ команды');
      return true;
    } catch (error) {
      throw classifyNativeStateWriteFailure(error);
    }
  },

  async loadState() {
    // Raw JSON нужен только для точной проверки при миграции. Он остаётся в памяти
    // адаптера, не отправляется в облако и не выводится в журнал.
    const raw = await invoke('load_state_raw');
    if (raw === null) return null;
    if (typeof raw !== 'string') throw new Error('Не удалось прочитать сохранённые данные');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Сохранённые данные повреждены');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Сохранённые данные имеют неверный формат');
    }
    readWitness.remember(parsed, raw);
    return parsed;
  },

  /** Оба native-вызова сверяют точные байты исходного state в mutex этого процесса. */
  async createMigrationBackup(snapshot, label) {
    const raw = readWitness.rawFor(snapshot);
    const name = await invoke('create_migration_backup', { expectedRaw: raw, label: label ?? null });
    if (typeof name !== 'string' || name.length > 200 || !/^state\.backup-[a-z0-9-]+\.json$/i.test(name)) {
      throw new Error('Не удалось подтвердить резервную копию; миграция остановлена');
    }
    return name;
  },

  async saveMigratedState(snapshot, data) {
    const raw = readWitness.rawFor(snapshot);
    try {
      const response = await invoke('save_state_if_unchanged', { expectedRaw: raw, payload: data });
      // Rust Result<(), String> возвращает null (некоторые среды — undefined).
      // Непредусмотренный ответ не доказывает, что файл не был заменён.
      if (response !== null && response !== undefined) throw new Error('Некорректный ответ команды');
      return true;
    } catch (error) {
      throw classifyNativeStateWriteFailure(error);
    }
  },

  forgetLoadedState(snapshot) {
    readWitness.forget(snapshot);
  },

  async getDataDir() {
    return await invoke('get_data_dir');
  },

  /** @param {{ maxCount?: number, label?: string }} [opts] */
  async createBackup(opts = {}) {
    let name;
    try {
      name = await invoke('create_backup', { maxCount: opts.maxCount ?? null, label: opts.label ?? null });
    } catch {
      // Даже при ошибке IPC копия могла быть создана; подробности могут содержать личные данные.
      throw new Error('Не удалось подтвердить резервную копию; проверьте список копий');
    }
    // Это подтверждение формы ответа, а не гарантия от удаления копии другим процессом.
    if (typeof name !== 'string' || name.length > 200 || !/^state\.backup-[a-z0-9-]+\.json$/i.test(name)) {
      throw new Error('Не удалось подтвердить резервную копию; проверьте список копий');
    }
    return name;
  },

  /** @returns {Promise<Array<{ name: string, createdAt: number, size: number }>>} */
  async listBackups() {
    return await invoke('list_backups');
  },

  async inspectBackup(fileName) {
    try {
      const response = await invoke('inspect_backup', { fileName });
      return backupReviews.remember(fileName, readBackupSummary(response), nativeWitness(response));
    } catch {
      // A response or OS error can contain private data: do not display or log it.
      throw new Error('Не удалось проверить выбранную копию; обновите список и попробуйте снова');
    }
  },

  forgetBackupInspection(inspection) {
    backupReviews.forget(inspection);
  },

  async restoreBackup(fileName, inspection) {
    // A rejected or already consumed review is known to precede the IPC call.
    const witness = inspection === undefined ? undefined : backupReviews.take(fileName, inspection);
    try {
      const args = witness === undefined ? { fileName } : { fileName, witness };
      const response = await invoke('restore_backup', args);
      if (response !== null && response !== undefined) throw new Error('Некорректный ответ команды');
      return true;
    } catch (error) {
      throw classifyNativeStateWriteFailure(error);
    }
  },

  async deleteBackup(fileName) {
    try {
      const response = await invoke('delete_backup', { fileName });
      if (response !== null && response !== undefined) throw new Error('Некорректный ответ команды');
      return true;
    } catch {
      // Потеря ответа не доказывает, что копия осталась. Не раскрываем детали IPC.
      throw new Error('Результат удаления копии не подтверждён. Обновите список и проверьте её наличие.');
    }
  }
};
