import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { localStorageAdapter as adapter } from '../js/core/storageAdapters/localStorageAdapter.js';

beforeEach(() => { localStorage.clear(); localStorage.setItem('tvinoferma_state_v1', '{"characters":[]}'); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('браузерные резервные копии', () => {
  it('учитывают maxCount и не трогают состояние или чужие ключи', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T19:00:00Z'));
    localStorage.setItem('other-data', 'не трогать');
    let latest;
    for (let i = 0; i < 15; i++) { latest = await adapter.createBackup({ maxCount: 3 }); vi.advanceTimersByTime(1); }
    const list = await adapter.listBackups(); expect(list).toHaveLength(3); expect(list[0]).toBe(latest);
    expect(localStorage.getItem('other-data')).toBe('не трогать'); expect(await adapter.loadState()).toEqual({ characters: [] });
  });

  it('две копии в одну миллисекунду не перезаписывают друг друга', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T19:00:00Z'));
    const a = await adapter.createBackup(); localStorage.setItem('tvinoferma_state_v1', '{"characters":[1]}'); const b = await adapter.createBackup();
    expect(a).not.toBe(b); expect(await adapter.listBackups()).toEqual([b, a]); expect(JSON.parse(localStorage.getItem(a))).toEqual({ characters: [] });
  });

  it('ротация в ту же миллисекунду всегда сохраняет самую новую копию', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T19:00:00Z'));
    for (let i = 0; i < 15; i++) {
      const key = await adapter.createBackup({ maxCount: 3 });
      expect((await adapter.listBackups())[0]).toBe(key); expect(localStorage.getItem(key)).not.toBeNull();
    }
    expect(await adapter.listBackups()).toHaveLength(3);
  });

  it('по умолчанию хранится не более 10 копий', async () => {
    for (let i = 0; i < 12; i++) await adapter.createBackup(); expect(await adapter.listBackups()).toHaveLength(10);
  });

  it('не удаляет предыдущие копии, если новая не сохранилась', async () => {
    const key = await adapter.createBackup({ maxCount: 1 });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    await expect(adapter.createBackup({ maxCount: 1 })).rejects.toThrow(); expect(await adapter.listBackups()).toEqual([key]);
  });

  it('минимум одна копия, повреждённое значение лимита возвращает безопасное значение', async () => {
    await adapter.createBackup({ maxCount: 0 }); await adapter.createBackup({ maxCount: 0 }); expect(await adapter.listBackups()).toHaveLength(1);
    for (let i = 0; i < 12; i++) await adapter.createBackup({ maxCount: NaN }); expect(await adapter.listBackups()).toHaveLength(10);
  });
});
