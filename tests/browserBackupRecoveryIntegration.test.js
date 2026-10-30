import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

it('после повреждённой загрузки блокирует пустое состояние и сохраняет исходные байты при восстановлении', async () => {
  const { localStorageAdapter } = await import('../js/core/storageAdapters/localStorageAdapter.js');
  const { loadData, persist, restoreStoredBackup } = await import('../js/core/storage.js');
  const key = 'tvinoferma_state_v1';
  localStorage.setItem(key, '{"characters":["из копии"]}');
  const selected = await localStorageAdapter.createBackup();
  const before = await localStorageAdapter.listBackups();
  localStorage.setItem(key, '{broken');
  await expect(loadData()).rejects.toThrow('повреждены');
  await expect(persist()).rejects.toThrow('Запись остановлена');
  expect(localStorage.getItem(key)).toBe('{broken');
  await restoreStoredBackup(selected);
  const all = await localStorageAdapter.listBackups();
  expect(localStorage.getItem(all.find(name => !before.includes(name)))).toBe('{broken');
  expect(localStorage.getItem(key)).toBe('{"characters":["из копии"]}');
  await expect(persist()).rejects.toThrow('Запись остановлена');
});

it('не повторяет обычное браузерное сохранение, если ошибка произошла после записи', async () => {
  const { persist } = await import('../js/core/storage.js');
  const key = 'tvinoferma_state_v1';
  const realSet = Storage.prototype.setItem;
  let writes = 0;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (name, value) {
    const result = realSet.call(this, name, value);
    if (name === key) {
      writes++;
      throw new Error('Ошибка после записи');
    }
    return result;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const notified = vi.fn();
  window.addEventListener('tf-storage-uncertain', notified);
  try {
    await expect(persist()).rejects.toThrow('TF_STATE_WRITE_UNCERTAIN:');
    const saved = localStorage.getItem(key);
    expect(saved).not.toBeNull();
    await expect(persist()).rejects.toThrow('Запись остановлена');
    expect(localStorage.getItem(key)).toBe(saved);
    expect(writes).toBe(1);
    expect(notified).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener('tf-storage-uncertain', notified);
  }
});

it('останавливает автоматическую запись после неподтверждённого браузерного восстановления', async () => {
  const { localStorageAdapter } = await import('../js/core/storageAdapters/localStorageAdapter.js');
  const { persist, restoreStoredBackup } = await import('../js/core/storage.js');
  const key = 'tvinoferma_state_v1';
  localStorage.setItem(key, '{"characters":["в копии"]}');
  const selected = await localStorageAdapter.createBackup();
  const previous = '{"characters":["текущие"]}';
  localStorage.setItem(key, previous);
  const before = await localStorageAdapter.listBackups();
  const realSet = Storage.prototype.setItem;
  let stateWrites = 0;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (name, value) {
    if (name === key) {
      stateWrites++;
      realSet.call(this, name, value);
      throw new Error('Ошибка после записи');
    }
    return realSet.call(this, name, value);
  });
  const notified = vi.fn();
  window.addEventListener('tf-storage-uncertain', notified);
  try {
    await expect(restoreStoredBackup(selected)).rejects.toThrow('TF_STATE_WRITE_UNCERTAIN:');
    const all = await localStorageAdapter.listBackups();
    expect(localStorage.getItem(all.find(name => !before.includes(name)))).toBe(previous);
    expect(localStorage.getItem(key)).toBe('{"characters":["в копии"]}');
    await expect(persist()).rejects.toThrow('Запись остановлена');
    expect(stateWrites).toBe(1);
    expect(notified).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener('tf-storage-uncertain', notified);
  }
});
