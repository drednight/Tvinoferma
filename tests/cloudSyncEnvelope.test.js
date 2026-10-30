import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecipheriv, webcrypto } from 'node:crypto';
import {
  decryptSnapshot,
  encryptSnapshot,
  generateRecoveryKey,
  generateSyncId,
  validateEnvelope
} from '../js/modules/cloudSync/envelope.js';

const cryptoSource = webcrypto;
const datasetId = '0047c59d-3d1f-4a87-bc64-523f75c73366';
const versionId = '12968be1-74cf-4791-a553-c78f621aabf2';
const snapshot = {
  records: [
    { id: 'char-1', nick: 'Звеномир', notes: 'Проверка 🔐' },
    { id: 'char-2', active: false, count: 5 }
  ],
  metadata: { missing: null, labels: ['один', 'два'] }
};
let recoveryKey;
const encrypt = (value = snapshot, extra = {}) =>
  encryptSnapshot({ snapshot: value, recoveryKey, datasetId, versionId, cryptoSource, ...extra });
const decrypt = (envelope, extra = {}) =>
  decryptSnapshot({ envelope, recoveryKey, expectedDatasetId: datasetId, cryptoSource, ...extra });

beforeEach(() => {
  recoveryKey = generateRecoveryKey(cryptoSource);
});

describe('зашифрованный формат для будущей синхронизации', () => {
  it('создаёт случайные ключи и версии без ника, времени и Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    const keys = new Set(Array.from({ length: 20 }, () => generateRecoveryKey(cryptoSource)));
    const ids = new Set(Array.from({ length: 20 }, () => generateSyncId(cryptoSource)));
    expect(keys.size).toBe(20);
    expect(ids.size).toBe(20);
    expect(recoveryKey).toMatch(/^TF1-[A-Za-z0-9_-]{43}$/);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('шифрует и расшифровывает JSON между устройствами, не передавая ключ внутри файла', async () => {
    const envelope = await encrypt();
    expect(validateEnvelope(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain('Звеномир');
    expect(JSON.stringify(envelope)).not.toContain(recoveryKey);
    expect(await decrypt(envelope)).toEqual(snapshot);
    expect(snapshot.records[0].nick).toBe('Звеномир');
  });

  it('каждый файл получает новую случайную nonce даже при одинаковых данных', async () => {
    const a = await encrypt();
    const b = await encrypt();
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await decrypt(a)).toEqual(await decrypt(b));
  });

  it('использует стандартный AES-256-GCM, совместимый с независимой реализацией Node', async () => {
    const envelope = await encrypt();
    const encrypted = Buffer.from(envelope.ciphertext, 'base64url');
    const key = Buffer.from(recoveryKey.slice(4), 'base64url');
    const iv = Buffer.from(envelope.iv, 'base64url');
    const aad = Buffer.from(
      JSON.stringify([envelope.format, envelope.version, envelope.algorithm, datasetId, versionId])
    );
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(encrypted.subarray(-16));
    const text = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8');
    expect(JSON.parse(text)).toEqual(snapshot);
  });

  it('не раскрывает файл с неправильным ключом и не показывает сам ключ в ошибке', async () => {
    const envelope = await encrypt();
    const other = generateRecoveryKey(cryptoSource);
    await expect(decrypt(envelope, { recoveryKey: other })).rejects.toThrow('Не удалось проверить');
    await expect(decrypt(envelope, { recoveryKey: other })).rejects.not.toThrow(other);
  });

  it('отклоняет подмену содержимого, nonce и идентификатора версии', async () => {
    const envelope = await encrypt();
    const changed = Buffer.from(envelope.ciphertext, 'base64url');
    changed[0] ^= 1;
    await expect(decrypt({ ...envelope, ciphertext: changed.toString('base64url') })).rejects.toThrow(
      'Не удалось проверить'
    );
    const iv = Buffer.from(envelope.iv, 'base64url');
    iv[0] ^= 1;
    await expect(decrypt({ ...envelope, iv: iv.toString('base64url') })).rejects.toThrow('Не удалось проверить');
    await expect(decrypt({ ...envelope, versionId: generateSyncId(cryptoSource) })).rejects.toThrow(
      'Не удалось проверить'
    );
  });

  it('не применяет файл другого набора, даже если ключ тот же', async () => {
    const envelope = await encrypt();
    const other = generateSyncId(cryptoSource);
    await expect(decrypt(envelope, { expectedDatasetId: other })).rejects.toThrow('другому набору');
    // Подмена видимого datasetId не проходит аутентификацию.
    await expect(decrypt({ ...envelope, datasetId: other }, { expectedDatasetId: other })).rejects.toThrow(
      'Не удалось проверить'
    );
  });

  it('не принимает подмену набора после начала асинхронной расшифровки', async () => {
    const other = generateSyncId(cryptoSource);
    const foreign = await encrypt({ value: 'другой набор' }, { datasetId: other });
    const changedDuringDecrypt = { ...foreign, datasetId };
    const promise = decrypt(changedDuringDecrypt);
    changedDuringDecrypt.datasetId = other;
    await expect(promise).rejects.toThrow('Не удалось проверить');
  });

  it('не принимает подмену версии после начала асинхронной расшифровки', async () => {
    const other = generateSyncId(cryptoSource);
    const foreign = await encrypt({ value: 'другая версия' }, { versionId: other });
    const changedDuringDecrypt = { ...foreign, versionId };
    const promise = decrypt(changedDuringDecrypt);
    changedDuringDecrypt.versionId = other;
    await expect(promise).rejects.toThrow('Не удалось проверить');
  });

  it('отклоняет неизвестный формат, лишние поля, неверные размеры и некорректный base64', async () => {
    const envelope = await encrypt();
    expect(() => validateEnvelope({ ...envelope, version: 2 })).toThrow('Неподдерживаемый');
    expect(() => validateEnvelope({ ...envelope, algorithm: 'none' })).toThrow('Неподдерживаемый');
    expect(() => validateEnvelope({ ...envelope, secret: recoveryKey })).toThrow('Некорректный');
    expect(() => validateEnvelope({ ...envelope, iv: 'AAAA' })).toThrow('Некорректный');
    expect(() => validateEnvelope({ ...envelope, ciphertext: '%%%invalid%%%' })).toThrow('Некорректные');
    expect(() => validateEnvelope({ ...envelope, ciphertext: 'A' })).toThrow('Некорректные');
    expect(() => validateEnvelope({ ...envelope, datasetId: 'etc/passwd' })).toThrow('Неподдерживаемый');
  });

  it('не исполняет getters в непроверенном внешнем файле', async () => {
    const envelope = await encrypt();
    let getterCalled = false;
    Object.defineProperty(envelope, 'iv', {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return 'unsafe';
      }
    });
    expect(() => validateEnvelope(envelope)).toThrow('Некорректный');
    expect(getterCalled).toBe(false);
  });

  it('не принимает пароль или неканонический ключ вместо случайного ключа восстановления', async () => {
    await expect(encrypt(snapshot, { recoveryKey: 'мой пароль' })).rejects.toThrow('Некорректный ключ');
    await expect(encrypt(snapshot, { recoveryKey: recoveryKey + '=' })).rejects.toThrow('Некорректный ключ');
    await expect(encrypt(snapshot, { recoveryKey: 'TF1-AAAA' })).rejects.toThrow('Некорректный ключ');
  });

  it('не обрезает молча неподдерживаемые значения перед шифрованием', async () => {
    const circular = {};
    circular.self = circular;
    const sparse = [];
    sparse.length = 2;
    sparse[1] = 1;
    const values = [
      { value: undefined },
      { value: NaN },
      { value: Infinity },
      { value: -0 },
      { value: 2n },
      { value: () => 1 },
      { value: new Date() },
      { value: sparse },
      circular,
      JSON.parse('{"__proto__":{"isAdmin":true}}')
    ];
    for (const value of values) await expect(encrypt(value)).rejects.toThrow();
    await expect(encrypt('not an object')).rejects.toThrow('Снимок должен быть объектом');
  });

  it('не вызывает getter во входных данных и не меняет сохранённый снимок', async () => {
    let touched = false;
    const value = {};
    Object.defineProperty(value, 'private', {
      enumerable: true,
      get: () => {
        touched = true;
        return 'пароль';
      }
    });
    await expect(encrypt(value)).rejects.toThrow('неподдерживаемое поле');
    expect(touched).toBe(false);
  });

  it('не имеет сетевых вызовов и не пишет снимок или ключ в localStorage', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const store = vi.spyOn(Storage.prototype, 'setItem');
    const envelope = await encrypt();
    expect(await decrypt(envelope)).toEqual(snapshot);
    expect(fetch).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
