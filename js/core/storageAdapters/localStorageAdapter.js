// js/core/storageAdapters/localStorageAdapter.js

const STORAGE_KEY = 'tvinoferma_state_v1';
const BACKUP_PREFIX = 'tvinoferma_backup_';

export const localStorageAdapter = {
  /**
   * Сохраняет состояние в LocalStorage
   */
  async saveState(data) {
    try {
      const jsonContent = JSON.stringify(data);
      localStorage.setItem(STORAGE_KEY, jsonContent);
      return true;
    } catch (error) {
      console.error('[LOCALSTORAGE ADAPTER] Save failed:', error);
      // Обработка ошибки переполнения квоты
      if (error.name === 'QuotaExceededError') {
        alert('Ошибка: Хранилище браузера переполнено! Очистите старые данные.');
      }
      throw error;
    }
  },

  /**
   * Загружает состояние из LocalStorage
   */
  async loadState() {
    try {
      const jsonString = localStorage.getItem(STORAGE_KEY);
      if (!jsonString) return null;
      
      return JSON.parse(jsonString);
    } catch (error) {
      console.error('[LOCALSTORAGE ADAPTER] Load failed:', error);
      return null;
    }
  },

  /**
   * Имитация пути к данным (так как его нет в браузере)
   */
  async getDataDir() {
    return 'Browser LocalStorage (virtual)';
  },

  /**
   * Создание бэкапа (сохранение отдельной записи с таймстампом)
   */
  async createBackup() {
    const currentData = await this.loadState();
    if (!currentData) throw new Error('No data to backup');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupKey = `${BACKUP_PREFIX}${timestamp}`;
    
    localStorage.setItem(backupKey, JSON.stringify(currentData));
    return backupKey; // Возвращаем ключ вместо имени файла
  },

  /**
   * Список бэкапов
   */
  async listBackups() {
    const keys = Object.keys(localStorage);
    return keys
      .filter(key => key.startsWith(BACKUP_PREFIX))
      .sort()
      .reverse();
  },

  /**
   * Восстановление из бэкапа
   */
  async restoreBackup(backupKey) {
    const dataJson = localStorage.getItem(backupKey);
    if (!dataJson) throw new Error('Backup not found');

    // Заменяем основной стейт данными из бэкапа
    localStorage.setItem(STORAGE_KEY, dataJson);
    return true;
  },

  /**
   * Удаление бэкапа
   */
  async deleteBackup(backupKey) {
    localStorage.removeItem(backupKey);
    return true;
  }
};