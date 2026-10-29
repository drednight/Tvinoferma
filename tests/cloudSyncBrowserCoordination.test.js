import { beforeEach, describe, expect, it, vi } from 'vitest';

let tryBrowserSyncOperation;
let BROWSER_SYNC_LOCK_NAME;

beforeEach(async () => {
  // Отдельный JS-контекст для каждого теста: неизвестный исход останавливает модуль.
  vi.resetModules();
  ({ tryBrowserSyncOperation, BROWSER_SYNC_LOCK_NAME } =
    await import('../js/modules/cloudSync/browserCoordination.js'));
});

function lockManager() {
  let held = false;
  return {
    request: vi.fn(async (name, options, callback) => {
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

function deferred() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return { promise, resolve };
}

describe('отключённый прототип Web Locks', () => {
  it('использует одно фиксированное имя, неблокирующую эксклюзивную попытку и не возвращает личные данные', async () => {
    const manager = lockManager();
    const result = await tryBrowserSyncOperation({ lockManager: manager, operation: async () => 'PRIVATE-PASSWORD' });
    expect(result).toEqual({ status: 'completed_for_test', action: 'manual_review' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-PASSWORD');
    expect(manager.request).toHaveBeenCalledOnce();
    expect(manager.request.mock.calls[0][0]).toBe(BROWSER_SYNC_LOCK_NAME);
    expect(manager.request.mock.calls[0][1]).toEqual({ mode: 'exclusive', ifAvailable: true });
    expect(BROWSER_SYNC_LOCK_NAME).not.toMatch(/password|dataset|device/i);
  });

  it('при занятом ресурсе не запускает callback; после освобождения перечитывание возможно заново', async () => {
    const manager = lockManager();
    const entered = deferred();
    const release = deferred();
    const first = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const second = vi.fn();
    const pending = tryBrowserSyncOperation({ lockManager: manager, operation: first });
    await entered.promise;
    expect(await tryBrowserSyncOperation({ lockManager: manager, operation: second })).toEqual({ status: 'busy' });
    expect(second).not.toHaveBeenCalled();
    release.resolve();
    expect((await pending).status).toBe('completed_for_test');
    expect((await tryBrowserSyncOperation({ lockManager: manager, operation: second })).status).toBe(
      'completed_for_test'
    );
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('отказывает без API и при ошибке до входа, без fallback и без запуска callback', async () => {
    const operation = vi.fn();
    for (const lockManager of [
      null,
      {},
      { request: 'invalid' },
      {
        request() {
          throw new Error('PRIVATE-LOCK-DETAIL');
        }
      },
      {
        get request() {
          throw new Error('PRIVATE-LOCK-DETAIL');
        }
      }
    ]) {
      const result = await tryBrowserSyncOperation({ lockManager, operation });
      expect(result).toEqual({ status: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('PRIVATE-LOCK-DETAIL');
    }
    expect(operation).not.toHaveBeenCalled();
    expect((await tryBrowserSyncOperation({ lockManager: lockManager(), operation })).status).toBe(
      'completed_for_test'
    );
  });

  it('не запускает операцию для неверного имени или общего режима', async () => {
    const operation = vi.fn();
    for (const forged of [
      { name: 'wrong', mode: 'exclusive' },
      { name: BROWSER_SYNC_LOCK_NAME, mode: 'shared' },
      undefined
    ]) {
      const manager = { request: async (_name, _options, callback) => callback(forged) };
      expect((await tryBrowserSyncOperation({ lockManager: manager, operation })).status).toBe('unavailable');
    }
    expect(operation).not.toHaveBeenCalled();
  });

  it('после ошибки внутри callback не раскрывает ошибку и останавливает повтор даже с другим менеджером', async () => {
    const operation = vi.fn(async () => {
      throw new Error('PRIVATE-PASSWORD /PRIVATE/PATH');
    });
    const result = await tryBrowserSyncOperation({ lockManager: lockManager(), operation });
    expect(result).toEqual({ status: 'uncertain', action: 'manual_review' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const retry = vi.fn();
    expect(await tryBrowserSyncOperation({ lockManager: lockManager(), operation: retry })).toEqual({
      status: 'blocked_after_uncertain',
      action: 'manual_review'
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('не считает ошибку менеджера после callback подтверждённым результатом', async () => {
    const operation = vi.fn();
    const manager = {
      async request(name, _options, callback) {
        await callback({ name, mode: 'exclusive' });
        throw new Error('PRIVATE-INTERNAL-ERROR');
      }
    };
    expect(await tryBrowserSyncOperation({ lockManager: manager, operation })).toEqual({
      status: 'uncertain',
      action: 'manual_review'
    });
    expect(operation).toHaveBeenCalledOnce();
    expect((await tryBrowserSyncOperation({ lockManager: lockManager(), operation })).status).toBe(
      'blocked_after_uncertain'
    );
  });

  it('ранний ответ адаптера после входа не считается успехом и останавливает новые операции', async () => {
    const finish = deferred();
    const operation = vi.fn(async () => {
      await finish.promise;
    });
    const manager = {
      request(name, _options, callback) {
        void callback({ name, mode: 'exclusive' });
        return Promise.resolve('EARLY');
      }
    };
    expect((await tryBrowserSyncOperation({ lockManager: manager, operation })).status).toBe('uncertain');
    expect((await tryBrowserSyncOperation({ lockManager: lockManager(), operation })).status).toBe(
      'blocked_after_uncertain'
    );
    finish.resolve();
    await finish.promise;
    expect(operation).toHaveBeenCalledOnce();
  });

  it('не обещает остановку уже выполняющегося callback после потери блокировки', async () => {
    const entered = deferred();
    const finish = deferred();
    const finished = deferred();
    const effects = [];
    const operation = async () => {
      entered.resolve();
      await finish.promise;
      effects.push('late-effect');
      finished.resolve();
    };
    const manager = {
      async request(name, _options, callback) {
        void callback({ name, mode: 'exclusive' });
        await entered.promise;
        throw new Error('lock stolen');
      }
    };
    expect((await tryBrowserSyncOperation({ lockManager: manager, operation })).status).toBe('uncertain');
    expect((await tryBrowserSyncOperation({ lockManager: lockManager(), operation })).status).toBe(
      'blocked_after_uncertain'
    );
    expect(effects).toEqual([]);
    finish.resolve();
    await finished.promise;
    expect(effects).toEqual(['late-effect']); // продолжение нельзя безопасно отменить этим wrapper
  });

  it('не запускает запоздавший или повторный callback неисправного адаптера', async () => {
    let late;
    const operation = vi.fn();
    const manager = {
      request(_name, _options, callback) {
        late = callback;
        return Promise.resolve('EARLY');
      }
    };
    expect((await tryBrowserSyncOperation({ lockManager: manager, operation })).status).toBe('unavailable');
    await expect(late({ name: BROWSER_SYNC_LOCK_NAME, mode: 'exclusive' })).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();

    const broken = {
      async request(name, _options, callback) {
        const first = callback({ name, mode: 'exclusive' });
        await expect(callback({ name, mode: 'exclusive' })).rejects.toThrow();
        return first;
      }
    };
    expect((await tryBrowserSyncOperation({ lockManager: broken, operation })).status).toBe('uncertain');
    expect(operation).toHaveBeenCalledOnce();
    expect((await tryBrowserSyncOperation({ lockManager: lockManager(), operation })).status).toBe(
      'blocked_after_uncertain'
    );
  });

  it('не вызывает getters и ничего не пишет в сеть или browser storage самостоятельно', async () => {
    const getter = vi.fn(() => vi.fn());
    const options = { lockManager: lockManager() };
    Object.defineProperty(options, 'operation', { enumerable: true, get: getter });
    await expect(tryBrowserSyncOperation(options)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await tryBrowserSyncOperation({ lockManager: lockManager(), operation: () => {} });
    expect(fetch).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
