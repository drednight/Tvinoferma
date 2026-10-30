import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDecipheriv, createHash, createHmac, hkdfSync, scryptSync, webcrypto } from 'node:crypto';
import {
  createKeyBundle,
  fingerprintKeyBundle,
  openKeyBundle,
  prepareKeyLossRestart,
  rewrapKeyBundle,
  rewrapKeyBundleFromDataKey
} from '../js/modules/cloudSync/keyBundle.js';
import { decryptSnapshot, encryptSnapshot, generateSyncId } from '../js/modules/cloudSync/envelope.js';

const primarySecret = 'Длинная фраза для синхронизации 73';
const backupSecret = 'Другой независимый резервный секрет 81';
const newPrimary = 'Новая фраза для восстановления 52';
const cryptoSource = webcrypto;
const id = () => generateSyncId(cryptoSource);
const main = (secret = primarySecret, kind = 'password') => ({ kind, secret });
const customBackup = (secret = backupSecret) => ({ kind: 'custom', secret });
const generatedBackup = () => ({ kind: 'generated' });
const open = (result, role, secret) =>
  openKeyBundle({
    bundle: result.bundle,
    expectedDatasetId: result.bundle.datasetId,
    expectedPin: result.pin,
    role,
    secret,
    cryptoSource
  });
let datasetId;
let created;
let custom;

beforeAll(async () => {
  datasetId = id();
  created = await createKeyBundle({ datasetId, primary: main(), backup: generatedBackup(), cryptoSource });
  custom = await createKeyBundle({
    datasetId: id(),
    primary: main(primarySecret, 'custom'),
    backup: customBackup(),
    cryptoSource
  });
}, 60000);

describe('экспериментальное обёртывание ключа данных двумя способами доступа', () => {
  it('открывает одну и ту же копию основным паролем и независимым случайным запасным ключом', async () => {
    const byMain = await open(created, 'main', primarySecret);
    const byBackup = await open(created, 'backup', created.generatedBackupSecret);
    expect(byMain.dataKey).toBe(created.dataKey);
    expect(byBackup.dataKey).toBe(created.dataKey);
    expect(created.generatedBackupSecret).toMatch(/^TFB1-[A-Za-z0-9_-]{43}$/);
    expect(created.dataKey).toMatch(/^TF1-[A-Za-z0-9_-]{43}$/);
    expect(created.bundle.main.salt).not.toBe(created.bundle.backup.salt);
    expect(created.bundle.main.iv).not.toBe(created.bundle.backup.iv);
    expect(await fingerprintKeyBundle(created.bundle, cryptoSource)).toEqual(created.pin);
    const output = JSON.stringify(created.bundle);
    for (const privateValue of [primarySecret, created.generatedBackupSecret, created.dataKey]) {
      expect(output).not.toContain(privateValue);
    }
    const envelope = await encryptSnapshot({
      snapshot: { value: 'событие', status: 'done' },
      recoveryKey: byMain.dataKey,
      datasetId,
      versionId: id(),
      cryptoSource
    });
    expect(
      await decryptSnapshot({ envelope, recoveryKey: byBackup.dataKey, expectedDatasetId: datasetId, cryptoSource })
    ).toEqual({ value: 'событие', status: 'done' });
  }, 30000);

  it('поддерживает самостоятельно заданные разные основной и запасной ключи', async () => {
    expect(custom.generatedBackupSecret).toBeNull();
    expect(custom.bundle.main.kind).toBe('custom');
    expect(custom.bundle.backup.kind).toBe('custom');
    expect((await open(custom, 'main', primarySecret)).dataKey).toBe(custom.dataKey);
    expect((await open(custom, 'backup', backupSecret)).dataKey).toBe(custom.dataKey);
    expect(JSON.stringify(custom.bundle)).not.toContain(backupSecret);
  }, 30000);

  it('совместим с независимыми реализациями scrypt, AES-GCM, HKDF и HMAC', () => {
    const { bundle } = created;
    const row = bundle.main;
    const salt = Buffer.from(row.salt, 'base64url');
    const iv = Buffer.from(row.iv, 'base64url');
    const wrapKey = scryptSync(Buffer.from(primarySecret.normalize('NFC')), salt, 32, {
      N: 32768,
      r: 8,
      p: 3,
      maxmem: 64 * 1024 * 1024
    });
    const ciphertext = Buffer.from(row.ciphertext, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', wrapKey, iv);
    decipher.setAAD(
      Buffer.from(
        JSON.stringify([
          bundle.format,
          bundle.version,
          bundle.datasetId,
          bundle.bundleId,
          'main',
          row.kind,
          row.kdf,
          row.n,
          row.r,
          row.p,
          row.salt,
          row.algorithm,
          row.iv
        ])
      )
    );
    decipher.setAuthTag(ciphertext.subarray(-16));
    const master = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    expect('TF1-' + master.toString('base64url')).toBe(created.dataKey);
    const proofKey = hkdfSync(
      'sha256',
      master,
      Buffer.from('tvinoferma-key-bundle-hkdf-v1'),
      Buffer.from(JSON.stringify(['tvinoferma-key-bundle-proof-v1', bundle.datasetId, bundle.bundleId])),
      32
    );
    const asArray = item => [
      item.kind,
      item.kdf,
      item.n,
      item.r,
      item.p,
      item.salt,
      item.algorithm,
      item.iv,
      item.ciphertext
    ];
    const canonical = [
      bundle.format,
      bundle.version,
      bundle.datasetId,
      bundle.bundleId,
      asArray(bundle.main),
      asArray(bundle.backup)
    ];
    expect(createHmac('sha256', proofKey).update(JSON.stringify(canonical)).digest('base64url')).toBe(bundle.proof);
    expect(
      createHash('sha256')
        .update(JSON.stringify(['tvinoferma-key-bundle-sha256-v1', ...canonical, bundle.proof]))
        .digest('hex')
    ).toBe(created.pin.sha256);
    wrapKey.fill(0);
    master.fill(0);
  }, 30000);

  it('не открывает неверный секрет, чужой набор или несовпавший доверенный отпечаток', async () => {
    const wrong = 'Совсем другая тестовая фраза 456';
    let message = '';
    try {
      await open(created, 'main', wrong);
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('Не удалось');
    expect(message).not.toContain(wrong);
    await expect(
      openKeyBundle({
        bundle: created.bundle,
        expectedDatasetId: id(),
        expectedPin: created.pin,
        role: 'main',
        secret: primarySecret,
        cryptoSource
      })
    ).rejects.toThrow('другим данным');
    await expect(
      openKeyBundle({
        bundle: created.bundle,
        expectedDatasetId: datasetId,
        expectedPin: { ...created.pin, sha256: '0'.repeat(64) },
        role: 'main',
        secret: primarySecret,
        cryptoSource
      })
    ).rejects.toThrow('Отпечаток');
  }, 30000);

  it('проверяет целостность запасной обёртки даже при открытии основным ключом', async () => {
    const altered = structuredClone(created.bundle);
    const bytes = Buffer.from(altered.backup.ciphertext, 'base64url');
    bytes[0] ^= 1;
    altered.backup.ciphertext = bytes.toString('base64url');
    const fakePin = await fingerprintKeyBundle(altered, cryptoSource);
    await expect(
      openKeyBundle({
        bundle: altered,
        expectedDatasetId: datasetId,
        expectedPin: fakePin,
        role: 'main',
        secret: primarySecret,
        cryptoSource
      })
    ).rejects.toThrow('Не удалось');
  }, 30000);

  it('связывает каждый слот, вид секрета, идентификатор набора и bundleId с шифротекстом', async () => {
    const swapped = structuredClone(custom.bundle);
    [swapped.main, swapped.backup] = [swapped.backup, swapped.main];
    const swappedPin = await fingerprintKeyBundle(swapped, cryptoSource);
    await expect(
      openKeyBundle({
        bundle: swapped,
        expectedDatasetId: custom.bundle.datasetId,
        expectedPin: swappedPin,
        role: 'backup',
        secret: primarySecret,
        cryptoSource
      })
    ).rejects.toThrow('Не удалось');
    const renamed = structuredClone(created.bundle);
    renamed.bundleId = id();
    const renamedPin = await fingerprintKeyBundle(renamed, cryptoSource);
    await expect(
      openKeyBundle({
        bundle: renamed,
        expectedDatasetId: datasetId,
        expectedPin: renamedPin,
        role: 'main',
        secret: primarySecret,
        cryptoSource
      })
    ).rejects.toThrow('Не удалось');
    const foreign = structuredClone(created.bundle);
    foreign.datasetId = id();
    const foreignPin = await fingerprintKeyBundle(foreign, cryptoSource);
    await expect(
      openKeyBundle({
        bundle: foreign,
        expectedDatasetId: foreign.datasetId,
        expectedPin: foreignPin,
        role: 'main',
        secret: primarySecret,
        cryptoSource
      })
    ).rejects.toThrow('Не удалось');
  }, 30000);

  it('отклоняет произвольные параметры расхода памяти, неподдерживаемую схему и лишние поля', async () => {
    const cases = [];
    for (const [field, value] of [
      ['n', 2 ** 25],
      ['n', 2],
      ['r', 1],
      ['p', 1000],
      ['kdf', 'none'],
      ['algorithm', 'none']
    ]) {
      const valueCopy = structuredClone(created.bundle);
      valueCopy.main[field] = value;
      cases.push(valueCopy);
    }
    cases.push({ ...created.bundle, version: 2 });
    cases.push({ ...created.bundle, unrelated: 'PRIVATE_VALUE' });
    cases.push({ ...created.bundle, proof: 'AAAA' });
    const sameSalt = structuredClone(created.bundle);
    sameSalt.backup.salt = sameSalt.main.salt;
    cases.push(sameSalt);
    const sameIv = structuredClone(created.bundle);
    sameIv.backup.iv = sameIv.main.iv;
    cases.push(sameIv);
    const noncanonical = structuredClone(created.bundle);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = noncanonical.main.salt.at(-1);
    noncanonical.main.salt = noncanonical.main.salt.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    cases.push(noncanonical);
    for (const value of cases) await expect(fingerprintKeyBundle(value, cryptoSource)).rejects.toThrow();
  });

  it('отклоняет одинаковые, слабые, повреждённые и слишком длинные пользовательские секреты без их вывода', async () => {
    const composed = 'Надёжная парольная фраза café';
    const decomposed = 'Надёжная парольная фраза cafe\u0301';
    const cases = [
      { primary: main('short'), backup: generatedBackup() },
      { primary: main('aaaaaaaaaaaaaaaaaaaa'), backup: generatedBackup() },
      { primary: main('12345678901234567890'), backup: generatedBackup() },
      { primary: main(composed), backup: customBackup(decomposed) },
      { primary: main('x'.repeat(1025)), backup: generatedBackup() },
      { primary: main('Неисправный \ud800 секрет 782'), backup: generatedBackup() },
      { primary: main(primarySecret), backup: { kind: 'generated', secret: created.generatedBackupSecret } }
    ];
    for (const choices of cases) {
      let message = '';
      try {
        await createKeyBundle({ datasetId, ...choices, cryptoSource });
      } catch (error) {
        message = error.message;
      }
      expect(message).toBeTruthy();
      expect(message).not.toContain(choices.primary.secret);
    }
  });

  it('одинаково обрабатывает эквивалентные Unicode формы, не обрезая пробелы', async () => {
    const normalized = 'Длинная памятная фраза café 73';
    const decomposed = 'Длинная памятная фраза cafe\u0301 73';
    const result = await createKeyBundle({
      datasetId: id(),
      primary: main(normalized),
      backup: customBackup(),
      cryptoSource
    });
    expect((await open(result, 'main', decomposed)).dataKey).toBe(result.dataKey);
    await expect(open(result, 'main', normalized + ' ')).rejects.toThrow('Не удалось');
  }, 30000);

  it('восстанавливает основной доступ через запасной и не уничтожает старую версию', async () => {
    const before = JSON.stringify(created.bundle);
    const restored = await rewrapKeyBundle({
      bundle: created.bundle,
      expectedDatasetId: datasetId,
      expectedPin: created.pin,
      role: 'backup',
      secret: created.generatedBackupSecret,
      primary: main(newPrimary, 'custom'),
      backup: customBackup(created.generatedBackupSecret),
      cryptoSource
    });
    expect(restored.dataKey).toBe(created.dataKey);
    expect(restored.bundle.bundleId).not.toBe(created.bundle.bundleId);
    expect(restored.pin).not.toEqual(created.pin);
    expect(restored.generatedBackupSecret).toBeNull();
    expect((await open(restored, 'main', newPrimary)).dataKey).toBe(created.dataKey);
    expect((await open(restored, 'backup', created.generatedBackupSecret)).dataKey).toBe(created.dataKey);
    await expect(open(restored, 'main', primarySecret)).rejects.toThrow('Не удалось');
    await expect(
      openKeyBundle({
        bundle: restored.bundle,
        expectedDatasetId: datasetId,
        expectedPin: created.pin,
        role: 'main',
        secret: newPrimary,
        cryptoSource
      })
    ).rejects.toThrow('Отпечаток');
    // Перевыпуск обёртки НЕ отзывает доступ по старой копии файла.
    expect((await open(created, 'main', primarySecret)).dataKey).toBe(created.dataKey);
    expect(JSON.stringify(created.bundle)).toBe(before);
  }, 30000);

  it('может восстановить доступ, если на доверенном ПК остался внутренний ключ данных', async () => {
    const before = JSON.stringify(created.bundle);
    const restored = await rewrapKeyBundleFromDataKey({
      bundle: created.bundle,
      expectedDatasetId: datasetId,
      expectedPin: created.pin,
      dataKey: created.dataKey,
      primary: main(newPrimary),
      backup: generatedBackup(),
      cryptoSource
    });
    expect(restored.dataKey).toBe(created.dataKey);
    expect(restored.bundle.datasetId).toBe(datasetId);
    expect(restored.bundle.bundleId).not.toBe(created.bundle.bundleId);
    expect((await open(restored, 'main', newPrimary)).dataKey).toBe(created.dataKey);
    expect((await open(restored, 'backup', restored.generatedBackupSecret)).dataKey).toBe(created.dataKey);
    await expect(
      rewrapKeyBundleFromDataKey({
        bundle: created.bundle,
        expectedDatasetId: datasetId,
        expectedPin: created.pin,
        dataKey: custom.dataKey,
        primary: main(newPrimary),
        backup: generatedBackup(),
        cryptoSource
      })
    ).rejects.toThrow('Не удалось');
    const altered = structuredClone(created.bundle);
    const proof = Buffer.from(altered.proof, 'base64url');
    proof[0] ^= 1;
    altered.proof = proof.toString('base64url');
    const alteredPin = await fingerprintKeyBundle(altered, cryptoSource);
    await expect(
      rewrapKeyBundleFromDataKey({
        bundle: altered,
        expectedDatasetId: datasetId,
        expectedPin: alteredPin,
        dataKey: created.dataKey,
        primary: main(newPrimary),
        backup: generatedBackup(),
        cryptoSource
      })
    ).rejects.toThrow('Не удалось');
    expect(JSON.stringify(created.bundle)).toBe(before);
  }, 30000);

  it('при потере обоих ключей подготавливает новый независимый набор без удаления старого', async () => {
    const before = JSON.stringify(created.bundle);
    const fresh = await prepareKeyLossRestart({
      previousDatasetId: datasetId,
      primary: main(newPrimary),
      backup: generatedBackup(),
      cryptoSource
    });
    expect(fresh.status).toBe('prepared_only');
    expect(fresh.previousDatasetId).toBe(datasetId);
    expect(fresh.bundle.datasetId).not.toBe(datasetId);
    expect(fresh.dataKey).not.toBe(created.dataKey);
    expect((await open(fresh, 'backup', fresh.generatedBackupSecret)).dataKey).toBe(fresh.dataKey);
    const oldEnvelope = await encryptSnapshot({
      snapshot: { event: 'старые данные' },
      recoveryKey: created.dataKey,
      datasetId,
      versionId: id(),
      cryptoSource
    });
    await expect(
      decryptSnapshot({ envelope: oldEnvelope, recoveryKey: fresh.dataKey, expectedDatasetId: datasetId, cryptoSource })
    ).rejects.toThrow('Не удалось');
    expect(JSON.stringify(created.bundle)).toBe(before);
  }, 30000);

  it('фиксирует входной набор и выбор слота до первого асинхронного ожидания', async () => {
    const input = structuredClone(created.bundle);
    const options = {
      bundle: input,
      expectedDatasetId: datasetId,
      expectedPin: { ...created.pin },
      role: 'main',
      secret: primarySecret,
      cryptoSource
    };
    const promise = openKeyBundle(options);
    input.backup.ciphertext = 'A'.repeat(64);
    options.expectedPin.sha256 = '0'.repeat(64);
    options.secret = 'Изменённый неверный секрет 719';
    expect((await promise).dataKey).toBe(created.dataKey);
  }, 30000);

  it('не исполняет getters, не выдаёт секрет в ошибке и отклоняет скрытые поля', async () => {
    const input = structuredClone(created.bundle);
    const getter = vi.fn(() => 'PRIVATE_VALUE');
    Object.defineProperty(input.backup, 'salt', { enumerable: true, get: getter });
    await expect(fingerprintKeyBundle(input, cryptoSource)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const hidden = structuredClone(created.bundle);
    Object.defineProperty(hidden, 'private', { value: 'PRIVATE_VALUE', enumerable: false });
    await expect(fingerprintKeyBundle(hidden, cryptoSource)).rejects.toThrow();
    const primary = { kind: 'password' };
    Object.defineProperty(primary, 'secret', { enumerable: true, get: getter });
    await expect(createKeyBundle({ datasetId, primary, backup: generatedBackup(), cryptoSource })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('блокирует параллельный затратный расчёт в одном JS-контексте и снимает блокировку', async () => {
    const ongoing = open(created, 'main', primarySecret);
    await expect(open(created, 'backup', created.generatedBackupSecret)).rejects.toThrow('Другая операция');
    expect((await ongoing).dataKey).toBe(created.dataKey);
    expect((await open(created, 'backup', created.generatedBackupSecret)).dataKey).toBe(created.dataKey);
  }, 30000);

  it('отказывает при повторяющихся случайных значениях вместо создания небезопасных обёрток', async () => {
    const brokenCrypto = {
      subtle: webcrypto.subtle,
      getRandomValues: bytes => {
        bytes.fill(0);
        return bytes;
      }
    };
    await expect(
      createKeyBundle({ datasetId: id(), primary: main(), backup: generatedBackup(), cryptoSource: brokenCrypto })
    ).rejects.toThrow();
    expect((await open(created, 'main', primarySecret)).dataKey).toBe(created.dataKey);
  }, 30000);

  it('не отправляет сеть и не пишет ключи, пароли или снимки в Storage', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const store = vi.spyOn(Storage.prototype, 'setItem');
    try {
      await open(created, 'main', primarySecret);
      expect(fetch).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      store.mockRestore();
    }
  }, 30000);
});
