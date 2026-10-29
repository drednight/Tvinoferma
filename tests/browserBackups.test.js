import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { localStorageAdapter as adapter } from '../js/core/storageAdapters/localStorageAdapter.js';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('tvinoferma_state_v1', '{"characters":[]}');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('браузерные резервные копии', () => {
  it('отличает отсутствующее состояние от повреждённого, пустого и необъектного', async () => {
    localStorage.removeItem('tvinoferma_state_v1');
    await expect(adapter.loadState()).resolves.toBeNull();
    for (const raw of ['', '{broken', 'null', '[]', '1', '"text"']) {
      localStorage.setItem('tvinoferma_state_v1', raw);
      await expect(adapter.loadState()).rejects.toThrow('Сохранённые данные браузера');
      expect(localStorage.getItem('tvinoferma_state_v1')).toBe(raw);
    }
  });

  it('проверяет обычное сохранение и сообщает о неизвестном исходе, если строка не совпала', async () => {
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      return set.call(this, key, key === 'tvinoferma_state_v1' ? '{"unexpected":true}' : value);
    });
    await expect(adapter.saveState({ characters: ['новые'] })).rejects.toThrow('TF_STATE_WRITE_UNCERTAIN:');
    expect(localStorage.getItem('tvinoferma_state_v1')).toBe('{"unexpected":true}');
  });

  it('ошибка сериализации до записи не объявляется неопределённой', async () => {
    const data = {};
    data.circular = data;
    await expect(adapter.saveState(data)).rejects.not.toThrow('TF_STATE_WRITE_UNCERTAIN:');
    expect(localStorage.getItem('tvinoferma_state_v1')).toBe('{"characters":[]}');
  });

  it('учитывают maxCount и не трогают состояние или чужие ключи', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T19:00:00Z'));
    localStorage.setItem('other-data', 'не трогать');
    let latest;
    for (let i = 0; i < 15; i++) {
      latest = await adapter.createBackup({ maxCount: 3 });
      vi.advanceTimersByTime(1);
    }
    const list = await adapter.listBackups();
    expect(list).toHaveLength(3);
    expect(list[0]).toBe(latest);
    expect(localStorage.getItem('other-data')).toBe('не трогать');
    expect(await adapter.loadState()).toEqual({ characters: [] });
  });

  it('две копии в одну миллисекунду не перезаписывают друг друга', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T19:00:00Z'));
    const a = await adapter.createBackup();
    localStorage.setItem('tvinoferma_state_v1', '{"characters":[1]}');
    const b = await adapter.createBackup();
    expect(a).not.toBe(b);
    expect(await adapter.listBackups()).toEqual([b, a]);
    expect(JSON.parse(localStorage.getItem(a))).toEqual({ characters: [] });
  });

  it('ротация в ту же миллисекунду всегда сохраняет самую новую копию', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T19:00:00Z'));
    for (let i = 0; i < 15; i++) {
      const key = await adapter.createBackup({ maxCount: 3 });
      expect((await adapter.listBackups())[0]).toBe(key);
      expect(localStorage.getItem(key)).not.toBeNull();
    }
    expect(await adapter.listBackups()).toHaveLength(3);
  });

  it('по умолчанию хранится не более 10 копий', async () => {
    for (let i = 0; i < 12; i++) await adapter.createBackup();
    expect(await adapter.listBackups()).toHaveLength(10);
  });

  it('не удаляет предыдущие копии, если новая не сохранилась', async () => {
    const key = await adapter.createBackup({ maxCount: 1 });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota', 'QuotaExceededError');
    });
    await expect(adapter.createBackup({ maxCount: 1 })).rejects.toThrow();
    expect(await adapter.listBackups()).toEqual([key]);
  });

  it('минимум одна копия, повреждённое значение лимита возвращает безопасное значение', async () => {
    await adapter.createBackup({ maxCount: 0 });
    await adapter.createBackup({ maxCount: 0 });
    expect(await adapter.listBackups()).toHaveLength(1);
    for (let i = 0; i < 12; i++) await adapter.createBackup({ maxCount: NaN });
    expect(await adapter.listBackups()).toHaveLength(10);
  });

  it('копирует точные байты строки и защищает новую копию от ротации при переводе часов назад', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T19:00:00Z'));
    localStorage.setItem('tvinoferma_state_v1', '{ "characters": [], "a": 2 }');
    const first = await adapter.createBackup({ maxCount: 1 });
    expect(localStorage.getItem(first)).toBe('{ "characters": [], "a": 2 }');
    vi.setSystemTime(new Date('2025-10-07T19:00:00Z'));
    localStorage.setItem('tvinoferma_state_v1', '{"characters":[1]}');
    const newest = await adapter.createBackup({ maxCount: 1 });
    expect(localStorage.getItem(newest)).toBe('{"characters":[1]}');
    expect(await adapter.listBackups()).toEqual([newest]);
  });

  it('сначала проверяет новую копию, а при ошибке не вращает предыдущие', async () => {
    const old = await adapter.createBackup({ maxCount: 1 });
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      return set.call(this, key, key.startsWith('tvinoferma_backup_') ? 'truncated' : value);
    });
    await expect(adapter.createBackup({ maxCount: 1 })).rejects.toThrow('проверить');
    expect(localStorage.getItem(old)).toBe('{"characters":[]}');
    expect(await adapter.listBackups()).toEqual([old]);
  });

  it('останавливает копирование, если текущая запись изменилась во время проверки', async () => {
    const old = await adapter.createBackup({ maxCount: 1 });
    const get = Storage.prototype.getItem;
    let stateReads = 0;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (key) {
      if (key === 'tvinoferma_state_v1' && ++stateReads === 2) return '{"characters":["changed"]}';
      return get.call(this, key);
    });
    await expect(adapter.createBackup({ maxCount: 1 })).rejects.toThrow('данные изменились');
    expect(localStorage.getItem(old)).toBe('{"characters":[]}');
    expect(await adapter.listBackups()).toEqual([old]);
  });

  it('перед восстановлением сохраняет текущие данные и не удаляет старые копии', async () => {
    localStorage.setItem('tvinoferma_state_v1', '{ "characters": ["в копии"] }');
    const selected = await adapter.createBackup();
    for (let i = 0; i < 12; i++) await adapter.createBackup({ maxCount: 99 });
    const before = await adapter.listBackups();
    localStorage.setItem('tvinoferma_state_v1', '{ "characters": ["текущие"] }');
    await adapter.restoreBackup(selected);
    expect(localStorage.getItem('tvinoferma_state_v1')).toBe('{ "characters": ["в копии"] }');
    const after = await adapter.listBackups();
    expect(after).toHaveLength(before.length + 1);
    expect(after).toEqual(expect.arrayContaining(before));
    const pre = after.find(key => !before.includes(key));
    expect(localStorage.getItem(pre)).toBe('{ "characters": ["текущие"] }');
  });

  it('не заменяет состояние, если обязательную копию перед восстановлением создать нельзя', async () => {
    const selected = await adapter.createBackup();
    localStorage.setItem('tvinoferma_state_v1', '{"characters":["новые"]}');
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.startsWith('tvinoferma_backup_')) throw new DOMException('Quota', 'QuotaExceededError');
      return set.call(this, key, value);
    });
    await expect(adapter.restoreBackup(selected)).rejects.toThrow();
    expect(localStorage.getItem('tvinoferma_state_v1')).toBe('{"characters":["новые"]}');
    expect(await adapter.listBackups()).toEqual([selected]);
  });

  it('сообщает о неизвестном исходе, если запись после восстановления не подтверждена', async () => {
    const selected = await adapter.createBackup();
    const previous = '{"characters":["старые данные"]}';
    localStorage.setItem('tvinoferma_state_v1', previous);
    const before = await adapter.listBackups();
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      return set.call(this, key, key === 'tvinoferma_state_v1' ? '{"unexpected":true}' : value);
    });
    await expect(adapter.restoreBackup(selected)).rejects.toThrow('подтверждение не получено');
    const all = await adapter.listBackups();
    expect(all).toHaveLength(before.length + 1);
    expect(localStorage.getItem(all.find(key => !before.includes(key)))).toBe(previous);
    expect(localStorage.getItem(selected)).toBe('{"characters":[]}');
  });

  it('считает исход неизвестным, если ошибка возникла после фактической записи состояния', async () => {
    const selected = await adapter.createBackup();
    const previous = '{"characters":["текущие"]}';
    localStorage.setItem('tvinoferma_state_v1', previous);
    const before = await adapter.listBackups();
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      const result = set.call(this, key, value);
      if (key === 'tvinoferma_state_v1') throw new Error('Ошибка после записи');
      return result;
    });
    await expect(adapter.restoreBackup(selected)).rejects.toThrow('TF_STATE_WRITE_UNCERTAIN:');
    const all = await adapter.listBackups();
    expect(localStorage.getItem(all.find(key => !before.includes(key)))).toBe(previous);
    expect(localStorage.getItem('tvinoferma_state_v1')).toBe('{"characters":[]}');
  });

  it('отклоняет повреждённые копии и чужие ключи без изменения состояния', async () => {
    for (const [key, raw] of [
      ['tvinoferma_backup_invalid', '{'],
      ['tvinoferma_backup_array', '[]'],
      ['tvinoferma_backup_null', 'null']
    ]) {
      localStorage.setItem(key, raw);
      await expect(adapter.restoreBackup(key)).rejects.toThrow();
      expect(localStorage.getItem('tvinoferma_state_v1')).toBe('{"characters":[]}');
    }
    localStorage.setItem('other-data', '{"private":true}');
    await expect(adapter.restoreBackup('other-data')).rejects.toThrow();
    await expect(adapter.deleteBackup('other-data')).rejects.toThrow();
    expect(localStorage.getItem('other-data')).toBe('{"private":true}');
  });

  it('разрешает восстановить отсутствующее состояние и сохраняет повреждённое перед заменой', async () => {
    const selected = await adapter.createBackup();
    localStorage.setItem('tvinoferma_state_v1', '{broken');
    const before = await adapter.listBackups();
    await adapter.restoreBackup(selected);
    const after = await adapter.listBackups();
    const preserved = after.find(key => !before.includes(key));
    expect(localStorage.getItem(preserved)).toBe('{broken');
    expect(localStorage.getItem('tvinoferma_state_v1')).toBe('{"characters":[]}');
    localStorage.removeItem('tvinoferma_state_v1');
    await adapter.restoreBackup(selected);
    expect(localStorage.getItem('tvinoferma_state_v1')).toBe('{"characters":[]}');
    expect(await adapter.listBackups()).toHaveLength(after.length);
  });

  it('не создаёт обычную копию из повреждённого или неподходящего текущего состояния', async () => {
    for (const raw of ['{broken', '[]', 'null', '"text"']) {
      localStorage.setItem('tvinoferma_state_v1', raw);
      await expect(adapter.createBackup()).rejects.toThrow();
      expect(await adapter.listBackups()).toEqual([]);
    }
  });
});
