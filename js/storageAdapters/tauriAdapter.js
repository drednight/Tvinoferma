// js/storageAdapters/tauriAdapter.js

import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
// Импортируем только существующие экспорты из plugin-fs v2
import { 
  exists, 
  mkdir, 
  readTextFile, 
  writeTextFile, 
  remove, // Заменяет removeFile
  readDir,
  copyFile // Если нужно для бэкапов
} from '@tauri-apps/plugin-fs';

let cachedDataDir = null;

/**
 * Получает путь к папке данных приложения (кэшируется)
 */
async function getDataDirPath() {
  if (cachedDataDir) return cachedDataDir;
  
  const baseDir = await appDataDir();
  // Создаем подпапку "tvinoferma_data" внутри стандартной директории данных
  const targetDir = await join(baseDir, 'tvinoferma_data'); 
  
  try {
    const dirExists = await exists(targetDir);
    if (!dirExists) {
      await mkdir(targetDir, { recursive: true });
    }
  } catch (e) {
    console.error('Failed to create data directory:', e);
  }

  cachedDataDir = targetDir;
  return targetDir;
}

export const tauriAdapter = {
  /**
   * Сохраняет состояние в файл state.json
   */
  async saveState(data) {
    const dir = await getDataDirPath();
    const filePath = await join(dir, 'state.json');
    
    try {
      const jsonContent = JSON.stringify(data, null, 2);
      // writeTextFile принимает путь и контент
      await writeTextFile(filePath, jsonContent);
      return true;
    } catch (error) {
      console.error('[TAURI ADAPTER] Save failed:', error);
      throw error;
    }
  },

  /**
   * Загружает состояние из файла state.json
   */
  async loadState() {
    const dir = await getDataDirPath();
    const filePath = await join(dir, 'state.json');

    try {
      const fileExists = await exists(filePath);
      if (!fileExists) {
        return null; // Файл еще не создан
      }

      // readTextFile сразу возвращает строку
      const jsonString = await readTextFile(filePath);
      
      return JSON.parse(jsonString);
    } catch (error) {
      console.error('[TAURI ADAPTER] Load failed:', error);
      return null;
    }
  },

  /**
   * Возвращает абсолютный путь к папке данных (для отображения в UI)
   */
  async getDataDir() {
    return await getDataDirPath();
  },

  /**
   * Создает резервную копию текущего состояния
   */
  async createBackup() {
    const dir = await getDataDirPath();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}.json`;
    const backupPath = await join(dir, backupName);
    
    // Читаем текущее состояние
    const currentData = await this.loadState();
    if (!currentData) {
      throw new Error('No data to backup');
    }

    // Пишем в новый файл
    await writeTextFile(backupPath, JSON.stringify(currentData, null, 2));
    return backupName;
  },

  /**
   * Список всех существующих бэкапов
   */
  async listBackups() {
    const dir = await getDataDirPath();
    try {
      // readDir возвращает массив объектов DirEntry
      const entries = await readDir(dir);
      
      return entries
        .filter(entry => entry.isFile && entry.name.startsWith('backup-') && entry.name.endsWith('.json'))
        .map(entry => entry.name)
        .sort()
        .reverse(); // Самые новые сверху
    } catch (e) {
      console.error('Failed to list backups', e);
      return [];
    }
  },

  /**
   * Восстановление данных из бэкапа
   */
  async restoreBackup(filename) {
    const dir = await getDataDirPath();
    const sourcePath = await join(dir, filename);
    const destPath = await join(dir, 'state.json');

    const fileExists = await exists(sourcePath);
    if (!fileExists) {
      throw new Error(`Backup file ${filename} not found`);
    }

    // Копируем содержимое бэкапа в основной файл
    // Используем readTextFile + writeTextFile вместо copyFile для простоты обработки ошибок
    const content = await readTextFile(sourcePath);
    await writeTextFile(destPath, content);
    
    return true;
  },

  /**
   * Удаление конкретного бэкапа
   */
  async deleteBackup(filename) {
    const dir = await getDataDirPath();
    const pathToDelete = await join(dir, filename);
    
    try {
      // remove удаляет файлы и директории
      await remove(pathToDelete);
      return true;
    } catch (e) {
      console.error('Failed to delete backup', e);
      throw e;
    }
  }
};