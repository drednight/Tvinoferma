import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { decryptSnapshot, generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { EncryptedOutbox } from '../js/modules/cloudSync/encryptedOutbox.js';

const cryptoSource = webcrypto;
const datasetId = '50c0182a-8bc4-4b82-a98c-c71f76d04471';
const deviceId = '2eb22942-b230-4d47-b9e8-507905695b2d';
let recoveryKey;
let storage;
let outbox;

// Та же атомарная замена строки, что в Web Storage; позволяет тестировать сбои.
function memoryStorage() {
  const records = new Map();
  return {
    failRead: false,
    failWrite: false,
    failAfterWrite: false,
    failReadback: false,
    corruptReadback: false,
    readbackBad: false,
    readbackCorrupt: false,
    writes: 0,
    getItem(key) {
      if (this.failRead || this.readbackBad) throw new Error('internal storage path or secret');
      if (this.readbackCorrupt) return 'unexpected value';
      return records.get(key) ?? null;
    },
    setItem(key, value) {
      this.writes++;
      if (this.failWrite) throw new Error('internal storage path or secret');
      records.set(key, String(value));
      if (this.failReadback) this.readbackBad = true;
      if (this.corruptReadback) this.readbackCorrupt = true;
      if (this.failAfterWrite) throw new Error('unknown write outcome');
    },
    raw() {
      return [...records.values()];
    }
  };
}
const create = (opts = {}) => new EncryptedOutbox({ storage, datasetId, deviceId, cryptoSource, ...opts });
const put = (
  snapshot = { nick: 'Звеномир', note: 'Секрет в тестовом примере' },
  versionId = generateSyncId(cryptoSource)
) => outbox.enqueueSnapshot({ snapshot, recoveryKey, versionId });

beforeEach(() => {
  recoveryKey = generateRecoveryKey(cryptoSource);
  storage = memoryStorage();
  outbox = create();
});

describe('подготовительная зашифрованная очередь', () => {
  it('пустая очередь ничего не создаёт в локальном хранилище', async () => {
    expect(await outbox.list()).toEqual([]);
    expect(storage.raw()).toEqual([]);
  });

  it('сохраняет только зашифрованный снимок и переживает повторное создание очереди', async () => {
    const snapshot = { nick: 'Звеномир', note: 'Секрет в тестовом примере' };
    const { versionId } = await put(snapshot);
    const raw = storage.raw().join('');
    expect(raw).not.toContain('Звеномир');
    expect(raw).not.toContain(snapshot.note);
    expect(raw).not.toContain(recoveryKey);
    const restarted = create();
    const [envelope] = await restarted.list();
    expect(envelope.versionId).toBe(versionId);
    expect(await decryptSnapshot({ envelope, recoveryKey, expectedDatasetId: datasetId, cryptoSource })).toEqual(
      snapshot
    );
  });

  it('не позволяет подменить хранилище или ключ, пока ожидается шифрование', async () => {
    const first = put({ value: 'оригинал' });
    const other = memoryStorage();
    expect(Object.isFrozen(outbox)).toBe(true);
    expect(() => {
      outbox.storage = other;
    }).toThrow();
    expect(() => {
      outbox.key = 'other-slot';
    }).toThrow();
    expect(() => {
      outbox.datasetId = generateSyncId(cryptoSource);
    }).toThrow();
    await first;
    expect(storage.raw()).toHaveLength(1);
    expect(other.raw()).toEqual([]);
    expect(await outbox.list()).toHaveLength(1);
  });

  it('выстраивает параллельные вызовы в порядке вызовов и фиксирует вход при постановке', async () => {
    const value = { number: 1 };
    const id1 = generateSyncId(cryptoSource),
      id2 = generateSyncId(cryptoSource),
      id3 = generateSyncId(cryptoSource);
    const first = put(value, id1);
    value.number = 999;
    const second = create().enqueueSnapshot({ snapshot: { number: 2 }, recoveryKey, versionId: id2 });
    const third = put({ number: 3 }, id3);
    await Promise.all([first, second, third]);
    const list = await outbox.list();
    expect(list.map(item => item.versionId)).toEqual([id1, id2, id3]);
    expect(
      await decryptSnapshot({ envelope: list[0], recoveryKey, expectedDatasetId: datasetId, cryptoSource })
    ).toEqual({ number: 1 });
  });

  it('не повторяет запись после отказа до setItem, хотя тестовое хранилище сохранило старую очередь', async () => {
    await put({ value: 'первая версия' });
    const before = storage.raw();
    storage.failWrite = true;
    let error;
    try {
      await put({ value: 'вторая версия' });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('Исход записи очереди неизвестен');
    expect(String(error)).not.toContain('internal storage');
    storage.failWrite = false;
    expect(storage.raw()).toEqual(before); // известно только тестовой заглушке, не коду очереди
    await expect(create().list()).rejects.toThrow('Исход записи очереди неизвестен');
    await expect(put({ value: 'вторая версия' })).rejects.toThrow('Исход записи очереди неизвестен');
    expect(storage.writes).toBe(2);
  });

  it('после ошибки сразу после setItem не пытается повторить или продолжить отправку', async () => {
    const id = generateSyncId(cryptoSource);
    storage.failAfterWrite = true;
    await expect(put({ value: 'неопределённый результат' }, id)).rejects.toThrow('Исход записи очереди неизвестен');
    storage.failAfterWrite = false;
    const [saved] = JSON.parse(storage.raw()[0]).entries; // только тест видит внутренности заглушки
    expect(saved.versionId).toBe(id);
    expect(await decryptSnapshot({ envelope: saved, recoveryKey, expectedDatasetId: datasetId, cryptoSource })).toEqual(
      {
        value: 'неопределённый результат'
      }
    );
    await expect(create().list()).rejects.toThrow('Исход записи очереди неизвестен');
    await expect(put({ value: 'повтор' }, id)).rejects.toThrow('Исход записи очереди неизвестен');
    await expect(outbox.acknowledgeConfirmed(saved)).rejects.toThrow('Исход записи очереди неизвестен');
    expect(storage.writes).toBe(1);
  });

  it.each(['failReadback', 'corruptReadback'])(
    'блокирует очередь при неудачной проверке сразу после setItem: %s',
    async flag => {
      await put({ value: 'прежняя версия' });
      storage[flag] = true;
      await expect(put({ value: 'новая версия' })).rejects.toThrow('Исход записи очереди неизвестен');
      storage[flag] = false;
      storage.readbackBad = false;
      storage.readbackCorrupt = false;
      expect(JSON.parse(storage.raw()[0]).entries).toHaveLength(2); // тест знает, что заглушка уже записала
      await expect(outbox.list()).rejects.toThrow('Исход записи очереди неизвестен');
      await expect(
        create().enqueueSnapshot({ snapshot: {}, recoveryKey, versionId: generateSyncId(cryptoSource) })
      ).rejects.toThrow('Исход записи очереди неизвестен');
      expect(storage.writes).toBe(2);
    }
  );

  it('останавливает уже запланированные записи после неизвестного исхода', async () => {
    storage.failAfterWrite = true;
    const pending = [put({ value: 1 }), put({ value: 2 }), put({ value: 3 })];
    const results = await Promise.allSettled(pending);
    expect(results.map(item => item.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(
      results.every(item => item.status === 'rejected' && /Исход записи очереди неизвестен/.test(String(item.reason)))
    ).toBe(true);
    expect(storage.writes).toBe(1);
    expect(JSON.parse(storage.raw()[0]).entries).toHaveLength(1);
  });

  it('не повторяет удаление подтверждённого элемента после неясной записи очереди', async () => {
    await put();
    const [saved] = await outbox.list();
    storage.failAfterWrite = true;
    await expect(outbox.acknowledgeConfirmed(saved)).rejects.toThrow('Исход записи очереди неизвестен');
    storage.failAfterWrite = false;
    expect(JSON.parse(storage.raw()[0]).entries).toEqual([]); // только тест знает результат заглушки
    await expect(create().acknowledgeConfirmed(saved)).rejects.toThrow('Исход записи очереди неизвестен');
    await expect(create().list()).rejects.toThrow('Исход записи очереди неизвестен');
    expect(storage.writes).toBe(2);
  });

  it('ошибку чтения не подменяет пустой очередью и не переходит на память', async () => {
    await put();
    const before = storage.raw();
    storage.failRead = true;
    await expect(outbox.list()).rejects.toThrow('Не удалось прочитать очередь');
    await expect(put()).rejects.toThrow('Не удалось прочитать очередь');
    storage.failRead = false;
    expect(storage.raw()).toEqual(before);
  });

  it('повреждённую очередь не очищает и не перезаписывает', async () => {
    await put();
    const key = 'tf-cloud-sync-outbox:' + deviceId;
    storage.setItem(key, '{broken');
    await expect(outbox.list()).rejects.toThrow('повреждена');
    await expect(put()).rejects.toThrow('повреждена');
    expect(storage.getItem(key)).toBe('{broken');
  });

  it('не перезаписывает неоднозначный JSON очереди с повторным ключом или форматированием', async () => {
    await put();
    const key = 'tf-cloud-sync-outbox:' + deviceId;
    const original = storage.raw()[0];
    const duplicate = original.replace('"version":1', '"version":1,"version":1');
    const escapedDuplicate = original.replace('"format":', '"format":"tvinoferma-encrypted-outbox","\\u0066ormat":');
    const formatted = JSON.stringify(JSON.parse(original), null, 2);
    for (const raw of [duplicate, escapedDuplicate, formatted]) {
      expect(JSON.parse(raw)).toEqual(JSON.parse(original));
      storage.setItem(key, raw); // повреждение моделируется извне, не очередью
      const writes = storage.writes;
      await expect(outbox.list()).rejects.toThrow('повреждена');
      await expect(put()).rejects.toThrow('повреждена');
      expect(storage.getItem(key)).toBe(raw);
      expect(storage.writes).toBe(writes);
    }
  });

  it('не перезаписывает очередь другого набора, даже если у него тот же ПК', async () => {
    await put();
    const before = storage.raw();
    const other = create({ datasetId: generateSyncId(cryptoSource) });
    await expect(other.list()).rejects.toThrow('другому набору');
    await expect(
      other.enqueueSnapshot({ snapshot: { a: 2 }, recoveryKey, versionId: generateSyncId(cryptoSource) })
    ).rejects.toThrow('другому набору');
    expect(storage.raw()).toEqual(before);
  });

  it('снимает с очереди только точно совпавший подтверждённый конверт', async () => {
    await put({ value: 1 });
    await put({ value: 2 });
    const [first, second] = await outbox.list();
    const iv = Buffer.from(first.iv, 'base64url');
    iv[0] ^= 1;
    await expect(outbox.acknowledgeConfirmed({ ...first, iv: iv.toString('base64url') })).rejects.toThrow(
      'не совпадает'
    );
    expect(await outbox.list()).toHaveLength(2);
    expect(await outbox.acknowledgeConfirmed(first)).toBe(true);
    expect((await outbox.list()).map(item => item.versionId)).toEqual([second.versionId]);
    expect(await outbox.acknowledgeConfirmed(first)).toBe(false);
  });

  it('проверяет и копирует одни и те же data-descriptor при подтверждении, без чтения через Proxy', async () => {
    await put({ value: 1 });
    await put({ value: 2 });
    const [first, second] = await outbox.list();
    const get = vi.fn((_target, key) => second[key]);
    const proxy = new Proxy(first, { get });
    expect(await outbox.acknowledgeConfirmed(proxy)).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect((await outbox.list()).map(item => item.versionId)).toEqual([second.versionId]);
  });

  it('не позволяет повторно поставить другой конверт с тем же id версии', async () => {
    const id = generateSyncId(cryptoSource);
    await put({ value: 1 }, id);
    const before = storage.raw();
    await expect(put({ value: 2 }, id)).rejects.toThrow('уже находится в очереди');
    expect(storage.raw()).toEqual(before);
  });

  it('не принимает нешифруемые данные или ключ и ничего не сохраняет открытым текстом', async () => {
    await expect(
      outbox.enqueueSnapshot({
        snapshot: { data: () => 'secret' },
        recoveryKey,
        versionId: generateSyncId(cryptoSource)
      })
    ).rejects.toThrow();
    await expect(
      outbox.enqueueSnapshot({
        snapshot: { data: 'secret' },
        recoveryKey: 'пароль',
        versionId: generateSyncId(cryptoSource)
      })
    ).rejects.toThrow('Некорректный ключ');
    expect(storage.raw()).toEqual([]);
  });

  it('не удаляет данные при переполнении очереди', async () => {
    for (let i = 0; i < 100; i++) await put({ number: i });
    const before = storage.raw();
    await expect(put({ number: 101 })).rejects.toThrow('заполнена');
    expect(storage.raw()).toEqual(before);
    expect(await outbox.list()).toHaveLength(100);
  });

  it('не выполняет сетевые вызовы и не использует localStorage по умолчанию', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    await put();
    expect(fetch).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(() => new EncryptedOutbox({ deviceId, datasetId })).toThrow('Не удалось открыть очередь');
    vi.restoreAllMocks();
  });
});
