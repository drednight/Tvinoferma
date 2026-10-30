import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';

const cryptoSource = webcrypto;
const markerId = '624123d7-97cc-477f-b0a3-03a1c3850f9e';
const deviceId = '2eb22942-b230-4d47-b9e8-507905695b2d';
const datasetId = '50c0182a-8bc4-4b82-a98c-c71f76d04471';
let module;
let authKey;
let markerStorage;
let manager;
let initial;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function lockManager() {
  let held = false;
  return {
    request: vi.fn(async (name, _options, callback) => {
      if (held) return callback(null);
      held = true;
      try {
        return await callback({ name, mode: 'exclusive' });
      } finally {
        held = false;
      }
    })
  };
}

function memoryMarker() {
  return {
    value: null,
    writes: 0,
    reads: 0,
    failRead: false,
    failBeforeWrite: 0,
    failAfterWrite: 0,
    badReadback: 0,
    nextReadBad: false,
    getItem(key) {
      if (key !== 'tf-cloud-sync-quarantine:v1') throw new Error('wrong marker slot');
      this.reads++;
      if (this.failRead || this.nextReadBad) {
        this.nextReadBad = false;
        throw new Error('PRIVATE marker read');
      }
      return this.value;
    },
    setItem(key, value) {
      if (key !== 'tf-cloud-sync-quarantine:v1') throw new Error('wrong marker slot');
      this.writes++;
      if (this.writes === this.failBeforeWrite) throw new Error('PRIVATE before');
      this.value = value;
      if (this.writes === this.badReadback) this.nextReadBad = true;
      if (this.writes === this.failAfterWrite) throw new Error('PRIVATE after');
    }
  };
}

function options(overrides = {}) {
  return {
    markerId,
    deviceId,
    datasetId,
    authKey,
    cryptoSource,
    markerStorage,
    lockManager: manager,
    operation: () => {},
    ...overrides
  };
}

async function reloadModule() {
  vi.resetModules();
  module = await import('../js/modules/cloudSync/persistentQuarantine.js');
}

async function attempt(overrides) {
  return module.tryQuarantinedBrowserOperation(options(overrides));
}

beforeEach(async () => {
  await reloadModule();
  authKey = await cryptoSource.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, [
    'sign',
    'verify'
  ]);
  markerStorage = memoryMarker();
  manager = lockManager();
  initial = await module.prepareFreshQuarantineMarker({ markerId, deviceId, datasetId, authKey, cryptoSource });
  markerStorage.value = initial; // тестовая инициализация; модуль сам не создаёт/сбрасывает отметку
});

describe('отключённая модель карантинной отметки', () => {
  it('сначала записывает и перечитывает pending, после успешного callback возвращает ready и не раскрывает значение', async () => {
    const operation = vi.fn(() => {
      const marker = JSON.parse(markerStorage.value);
      expect(marker.body.phase).toBe('pending');
      expect(marker.body.attemptId).toMatch(/^[0-9a-f-]{36}$/);
      expect(markerStorage.writes).toBe(1);
      return 'PRIVATE-PASSWORD';
    });
    const result = await attempt({ operation });
    expect(result).toEqual({ status: 'completed_for_test', action: 'manual_review' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(markerStorage.value).toBe(initial);
    expect(markerStorage.writes).toBe(2);
    expect(operation).toHaveBeenCalledOnce();
    expect(JSON.stringify(markerStorage.value)).not.toContain('PRIVATE');
  });

  it('не создаёт отметку автоматически: отсутствие, ошибки чтения и повреждение блокируют callback', async () => {
    const operation = vi.fn();
    markerStorage.value = null;
    expect(await attempt({ operation })).toEqual({ status: 'blocked_marker', action: 'manual_review' });
    markerStorage.failRead = true;
    expect(await attempt({ operation })).toEqual({ status: 'unavailable', action: 'manual_review' });
    markerStorage.failRead = false;
    markerStorage.value = '{broken';
    expect((await attempt({ operation })).status).toBe('blocked_marker');
    markerStorage.value = 'x'.repeat(2049);
    expect((await attempt({ operation })).status).toBe('blocked_marker');
    expect(markerStorage.writes).toBe(0);
    expect(operation).not.toHaveBeenCalled();
  });

  it('отклоняет другую привязку, другой ключ, подменённую подпись и неоднозначный JSON без перезаписи', async () => {
    const operation = vi.fn();
    expect((await attempt({ operation, datasetId: generateSyncId(cryptoSource) })).status).toBe('blocked_marker');
    expect((await attempt({ operation, markerId: generateSyncId(cryptoSource) })).status).toBe('blocked_marker');
    const otherKey = await cryptoSource.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, [
      'sign',
      'verify'
    ]);
    expect((await attempt({ operation, authKey: otherKey })).status).toBe('blocked_marker');
    const altered = initial
      .replace('"phase":"ready"', '"phase":"pending"')
      .replace('"attemptId":null', `"attemptId":"${generateSyncId(cryptoSource)}"`);
    const duplicate = initial.replace('"version":1', '"version":1,"version":1');
    const escapedDuplicate = initial.replace('"version":1', '"version":1,"\\u0076ersion":1');
    const formatted = JSON.stringify(JSON.parse(initial), null, 2);
    const invalidMac = JSON.parse(initial);
    invalidMac.mac = invalidMac.mac.slice(0, -1) + (invalidMac.mac.endsWith('A') ? 'B' : 'A');
    for (const raw of [altered, duplicate, escapedDuplicate, formatted, JSON.stringify(invalidMac)]) {
      markerStorage.value = raw;
      expect((await attempt({ operation })).status).toBe('blocked_marker');
      expect(markerStorage.value).toBe(raw);
    }
    expect(markerStorage.writes).toBe(0);
    expect(operation).not.toHaveBeenCalled();
  });

  it('требует отдельный неизвлекаемый HMAC-SHA-256 ключ с двумя разрешениями и явные pin', async () => {
    const extractable = await cryptoSource.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, true, [
      'sign',
      'verify'
    ]);
    const signOnly = await cryptoSource.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, [
      'sign'
    ]);
    for (const key of [null, extractable, signOnly]) {
      await expect(attempt({ authKey: key })).rejects.toThrow('Некорректная карантинная отметка');
    }
    await expect(attempt({ markerId: '' })).rejects.toThrow();
    expect(markerStorage.writes).toBe(0);
  });

  it('после ошибки callback сохраняет pending и блокирует новый экземпляр модуля и новый объект Storage', async () => {
    const operation = vi.fn(() => {
      throw new Error('PRIVATE-SECRET /PRIVATE/PATH');
    });
    const result = await attempt({ operation });
    expect(result).toEqual({ status: 'operation_uncertain', action: 'manual_review' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.parse(markerStorage.value).body.phase).toBe('pending');
    expect(markerStorage.writes).toBe(1);
    expect((await attempt()).status).toBe('blocked_after_uncertain');

    const sameBackingStorage = {
      getItem: key => markerStorage.getItem(key),
      setItem: (key, value) => markerStorage.setItem(key, value)
    };
    await reloadModule();
    const retry = vi.fn();
    expect(await attempt({ markerStorage: sameBackingStorage, operation: retry })).toEqual({
      status: 'blocked_pending',
      action: 'manual_review'
    });
    expect(retry).not.toHaveBeenCalled();
    expect(markerStorage.writes).toBe(1);
  });

  it.each(['failBeforeWrite', 'failAfterWrite', 'badReadback'])(
    'не запускает callback, если запись или перечитывание pending неопределённы: %s',
    async fault => {
      markerStorage[fault] = 1;
      const operation = vi.fn();
      expect(await attempt({ operation })).toEqual({ status: 'marker_write_uncertain', action: 'manual_review' });
      expect(operation).not.toHaveBeenCalled();
      expect((await attempt({ operation })).status).toBe('blocked_after_uncertain');
      markerStorage[fault] = 0;
      markerStorage.nextReadBad = false;
      await reloadModule();
      if (fault === 'failBeforeWrite') {
        // Только заглушка знает, что старая ready сохранилась и callback не начинался.
        expect(markerStorage.value).toBe(initial);
        expect((await attempt({ operation })).status).toBe('completed_for_test');
        expect(operation).toHaveBeenCalledOnce();
      } else {
        expect(JSON.parse(markerStorage.value).body.phase).toBe('pending');
        expect((await attempt({ operation })).status).toBe('blocked_pending');
        expect(operation).not.toHaveBeenCalled();
      }
    }
  );

  it.each(['failBeforeWrite', 'failAfterWrite', 'badReadback'])(
    'после ошибки возврата ready не сообщает успех; проверяет сохранённую отметку при новом запуске: %s',
    async fault => {
      markerStorage[fault] = 2;
      const operation = vi.fn();
      expect((await attempt({ operation })).status).toBe('marker_write_uncertain');
      expect(operation).toHaveBeenCalledOnce();
      expect((await attempt()).status).toBe('blocked_after_uncertain');
      markerStorage[fault] = 0;
      markerStorage.nextReadBad = false;
      await reloadModule();
      const retry = vi.fn();
      const result = await attempt({ operation: retry });
      if (fault === 'failBeforeWrite') {
        expect(result.status).toBe('blocked_pending');
        expect(retry).not.toHaveBeenCalled();
      } else {
        // Callback завершился до сохранения ready; это не доказательство fsync данных callback.
        expect(result.status).toBe('completed_for_test');
        expect(retry).toHaveBeenCalledOnce();
      }
    }
  );

  it('не затирает другую отметку, заменённую во время callback', async () => {
    const replacement = 'PRIVATE external replacement';
    const result = await attempt({ operation: () => (markerStorage.value = replacement) });
    expect(result.status).toBe('marker_write_uncertain');
    expect(markerStorage.value).toBe(replacement);
    expect(markerStorage.writes).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('не затирает отметку, подменённую пока асинхронно проверялась подпись', async () => {
    const entered = deferred();
    const release = deferred();
    const delayedCrypto = {
      getRandomValues: cryptoSource.getRandomValues.bind(cryptoSource),
      subtle: {
        sign: cryptoSource.subtle.sign.bind(cryptoSource.subtle),
        async verify(...args) {
          entered.resolve();
          await release.promise;
          return cryptoSource.subtle.verify(...args);
        }
      }
    };
    const operation = vi.fn();
    const result = attempt({ operation, cryptoSource: delayedCrypto });
    await entered.promise;
    markerStorage.value = 'CHANGED-WHILE-VERIFYING';
    release.resolve();
    expect((await result).status).toBe('blocked_marker');
    expect(markerStorage.value).toBe('CHANGED-WHILE-VERIFYING');
    expect(markerStorage.writes).toBe(0);
    expect(operation).not.toHaveBeenCalled();
  });

  it('занятая блокировка не читает отметку и не запускает второй callback', async () => {
    const entered = deferred();
    const release = deferred();
    const first = attempt({
      operation: async () => {
        entered.resolve();
        await release.promise;
      }
    });
    await entered.promise;
    const reads = markerStorage.reads;
    const second = vi.fn();
    expect((await attempt({ operation: second })).status).toBe('busy');
    expect(markerStorage.reads).toBe(reads);
    expect(second).not.toHaveBeenCalled();
    release.resolve();
    expect((await first).status).toBe('completed_for_test');
  });

  it('после известной потери lock поздний callback не снимает pending; новую вкладку блокирует отметка', async () => {
    const entered = deferred();
    const release = deferred();
    const done = deferred();
    const stolen = deferred();
    const broken = {
      request(name, _options, callback) {
        const running = callback({ name, mode: 'exclusive' });
        return Promise.race([running, stolen.promise]);
      }
    };
    const first = attempt({
      lockManager: broken,
      operation: async () => {
        entered.resolve();
        await release.promise;
        done.resolve();
      }
    });
    await entered.promise;
    stolen.reject(new Error('lock stolen'));
    expect((await first).status).toBe('uncertain');
    release.resolve();
    await done.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(markerStorage.value).body.phase).toBe('pending');
    await reloadModule();
    const next = vi.fn();
    expect((await attempt({ operation: next })).status).toBe('blocked_pending');
    expect(next).not.toHaveBeenCalled();
  });

  it('демонстрирует ограничение: откат старой подписанной ready-отметки не обнаруживается', async () => {
    expect(
      (
        await attempt({
          operation: () => {
            throw new Error('test');
          }
        })
      ).status
    ).toBe('operation_uncertain');
    expect(JSON.parse(markerStorage.value).body.phase).toBe('pending');
    markerStorage.value = initial; // внешний откат обеих отметок: HMAC доказывает подлинность, не свежесть
    await reloadModule();
    const operation = vi.fn();
    expect((await attempt({ operation })).status).toBe('completed_for_test');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('модельно окружает зашифрованную очередь: потеря локальной блокировки после перезагрузки не снимает pending', async () => {
    const { EncryptedOutbox } = await import('../js/modules/cloudSync/encryptedOutbox.js');
    const queueStorage = {
      value: null,
      failAfter: true,
      getItem() {
        return this.value;
      },
      setItem(_key, value) {
        this.value = value;
        if (this.failAfter) throw new Error('PRIVATE after queue write');
      }
    };
    const recoveryKey = generateRecoveryKey(cryptoSource);
    const versionId = generateSyncId(cryptoSource);
    const outbox = new EncryptedOutbox({ storage: queueStorage, deviceId, datasetId, cryptoSource });
    const result = await attempt({
      operation: () => outbox.enqueueSnapshot({ snapshot: { secret: 'PRIVATE-SNAPSHOT' }, recoveryKey, versionId })
    });
    expect(result.status).toBe('operation_uncertain');
    expect(queueStorage.value).not.toContain('PRIVATE-SNAPSHOT');
    expect(markerStorage.value).not.toContain('PRIVATE-SNAPSHOT');
    expect(JSON.parse(markerStorage.value).body.phase).toBe('pending');
    queueStorage.failAfter = false;
    await reloadModule();
    const { EncryptedOutbox: RestartedOutbox } = await import('../js/modules/cloudSync/encryptedOutbox.js');
    const restarted = new RestartedOutbox({ storage: queueStorage, deviceId, datasetId, cryptoSource });
    const directList = await restarted.list(); // сама очередь после reload теряет прежнюю блокировку
    expect(directList).toHaveLength(1);
    const read = vi.fn(() => restarted.list());
    expect((await attempt({ operation: read })).status).toBe('blocked_pending');
    expect(read).not.toHaveBeenCalled();
  });

  it('фиксирует параметры без getters и сам не делает сетевых запросов', async () => {
    const getter = vi.fn(() => () => {});
    const input = options();
    Object.defineProperty(input, 'operation', { enumerable: true, get: getter });
    await expect(module.tryQuarantinedBrowserOperation(input)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await attempt();
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
