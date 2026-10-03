// @ts-check
// js/core/storageAdapters/tauriAdapter.js
// Хранилище desktop-версии: все операции с файлами выполняет Rust (src-tauri/src/commands),
// state.json пишется атомарно, бэкапы создаются/ротируются на стороне Rust.

import { invoke } from '@tauri-apps/api/core';

export const tauriAdapter = {
  async saveState(data) {
    await invoke('save_state', { payload: data });
    return true;
  },

  async loadState() {
    return await invoke('load_state');
  },

  async getDataDir() {
    return await invoke('get_data_dir');
  },

  /** @param {{ maxCount?: number, label?: string }} [opts] */
  async createBackup(opts = {}) {
    return await invoke('create_backup', { maxCount: opts.maxCount ?? null, label: opts.label ?? null });
  },

  /** @returns {Promise<Array<{ name: string, createdAt: number, size: number }>>} */
  async listBackups() {
    return await invoke('list_backups');
  },

  async restoreBackup(fileName) {
    await invoke('restore_backup', { fileName });
    return true;
  },

  async deleteBackup(fileName) {
    await invoke('delete_backup', { fileName });
    return true;
  }
};
