import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  parseGoogleCredentialRecord,
  prepareGoogleCredentialRecord,
  serializeGoogleCredentialRecord
} from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { createGoogleEncryptedCredentialStore } from '../js/modules/cloudSync/providers/oauthCredentialCipherStore.js';
import { createGoogleCredentialRotation } from '../js/modules/cloudSync/providers/oauthCredentialRotation.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const slotId = 'aa8b55c7-f70e-4db4-bce2-9fe520a71936';
const revision = 'd2041a21-99a5-427c-9db7-b8ca59e22b34';
const pendingRevision = '6fcced31-c105-4fbd-a67b-b95f51c2c967';
const attemptId = '244629ca-e25d-453a-90eb-632016e44d56';
const nextRevision = '5c6007df-22d8-4dbd-866a-9e4c6aba8331';
const otherId = 'b72c802c-b319-4000-86a1-d1c303777452';
const clientId = '123456789-test_client.apps.googleusercontent.com';
const accountKey = 'FAKE_ACCOUNT_PRIVATE_123';
const oldRefresh = 'FAKE_PRIVATE_OLD_REFRESH:123';
const newRefresh = 'FAKE_PRIVATE_NEW_REFRESH:456';
const access = 'FAKE_PRIVATE_ACCESS_789';

function ready(overrides = {}) {
  return prepareGoogleCredentialRecord({
    slotId,
    clientId,
    accountKey,
    revision,
    refreshToken: oldRefresh,
    refreshExpiresAt: null,
    ...overrides
  });
}
function pending(raw = ready(), overrides = {}) {
  return serializeGoogleCredentialRecord({
    ...parseGoogleCredentialRecord(raw),
    revision: pendingRevision,
    phase: 'pending',
    attemptId,
    refreshToken: null,
    refreshExpiresAt: null,
    ...overrides
  });
}
function nextReady(raw = pending(), overrides = {}) {
  return serializeGoogleCredentialRecord({
    ...parseGoogleCredentialRecord(raw),
    revision: nextRevision,
    phase: 'ready',
    attemptId: null,
    refreshToken: newRefresh,
    refreshExpiresAt: null,
    ...overrides
  });
}
async function key() {
  return webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function fixture(initial = null) {
  let value = initial;
  const faults = { failRead: 0, failBefore: 0, failAfter: 0, fakeSwap: 0, badReadback: 0, onWrite: null };
  const reads = vi.fn(async () => {
    const call = reads.mock.calls.length;
    if (call === faults.failRead) throw new Error(`PRIVATE_READ ${oldRefresh}`);
    if (call === faults.badReadback) return 'PRIVATE_WRONG_READBACK';
    return value;
  });
  const swaps = vi.fn(async (expected, next) => {
    const call = swaps.mock.calls.length;
    if (call === faults.failBefore) throw new Error(`PRIVATE_BEFORE ${oldRefresh}`);
    if (value !== expected) return 'mismatch';
    if (call !== faults.fakeSwap) value = next;
    faults.onWrite?.(call, next);
    if (call === faults.failAfter) throw new Error(`PRIVATE_AFTER ${newRefresh}`);
    return 'swapped';
  });
  return {
    backend: { read: reads, compareExchange: swaps },
    faults,
    reads,
    swaps,
    get: () => value,
    replace: next => {
      value = next;
    }
  };
}
function setup(backing, cryptoKey, overrides = {}) {
  return createGoogleEncryptedCredentialStore({
    slotId,
    clientId,
    accountKey,
    key: cryptoKey,
    backend: backing.backend,
    cryptoSource: webcrypto,
    ...overrides
  });
}
function tokenReply() {
  const response = new Response(
    JSON.stringify({
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: OAUTH_PROVIDERS.google.scope,
      refresh_token: newRefresh
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  Object.defineProperty(response, 'url', { value: OAUTH_PROVIDERS.google.token });
  return response;
}
function rotation(store, fetchImpl = vi.fn(async () => tokenReply())) {
  return createGoogleCredentialRotation({
    slotId,
    clientId,
    accountKey,
    store,
    fetchImpl,
    verifyAccount: async () => ({ accountKey }),
    cryptoSource: webcrypto,
    now: () => 100_000,
    timeoutMs: 1000,
    identityTimeoutMs: 1000
  });
}
async function errorMessage(promise) {
  try {
    await promise;
    return 'unexpected success';
  } catch (error) {
    return String(error);
  }
}
function containsNoPrivate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const privateValue of [oldRefresh, newRefresh, access, accountKey, 'PRIVATE_AFTER', 'PRIVATE_READ'])
    expect(text).not.toContain(privateValue);
}

describe('каноническая чувствительная запись Google', () => {
  it('готовит только запись в памяти, а не подтверждение первого входа', () => {
    const raw = ready();
    const record = parseGoogleCredentialRecord(raw);
    expect(record).toMatchObject({ slotId, clientId, accountKey, revision, phase: 'ready', refreshToken: oldRefresh });
    expect(serializeGoogleCredentialRecord(record)).toBe(raw);
    expect(raw).toContain(oldRefresh);
  });

  it('не принимает чужие поля, повторный JSON и getters с приватными ошибками', () => {
    for (const raw of [
      ready().replace('"version":1', '"version":1,"version":1'),
      JSON.stringify(JSON.parse(ready()), null, 2),
      ready().replace('"phase":"ready"', '"phase":"pending"')
    ]) {
      expect(() => parseGoogleCredentialRecord(raw)).toThrow('Некорректная запись');
    }
    const candidate = {
      slotId,
      clientId,
      accountKey,
      revision,
      refreshToken: oldRefresh,
      refreshExpiresAt: null,
      extra: 'PRIVATE_EXTRA'
    };
    expect(() => prepareGoogleCredentialRecord(candidate)).toThrow('Некорректная запись');
    const getter = vi.fn(() => oldRefresh);
    delete candidate.extra;
    Object.defineProperty(candidate, 'refreshToken', { enumerable: true, get: getter });
    expect(() => prepareGoogleCredentialRecord(candidate)).toThrow('Некорректная запись');
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('отключённый шифрующий слой для записи Google', () => {
  it('читает конверт прежнего Google-формата после добавления отдельного формата Яндекса', async () => {
    const cryptoKey = await key();
    const format = 'tvinoferma-local-google-oauth-sealed';
    const iv = Uint8Array.from({ length: 12 }, (_, index) => index);
    const aad = new TextEncoder().encode(
      JSON.stringify([format, 1, 'AES-256-GCM', 'google', slotId, clientId, accountKey])
    );
    const encrypted = new Uint8Array(
      await webcrypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        cryptoKey,
        new TextEncoder().encode(ready())
      )
    );
    const encode = bytes => Buffer.from(bytes).toString('base64url');
    const previous = JSON.stringify({
      format,
      version: 1,
      algorithm: 'AES-256-GCM',
      iv: encode(iv),
      ciphertext: encode(encrypted)
    });
    const backing = fixture(previous);
    expect(await setup(backing, cryptoKey).read()).toBe(ready());
    expect(backing.swaps).not.toHaveBeenCalled();
    containsNoPrivate(previous);
  });

  it('первую запись явно устанавливает только в пустой fake-CAS и хранит не открытый текст', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const store = setup(backing, cryptoKey);
    expect(Object.isFrozen(store)).toBe(true);
    expect(await store.read()).toBeNull();
    expect(await store.compareExchange(null, ready())).toBe('swapped');
    const ciphertext = backing.get();
    expect(JSON.parse(ciphertext)).toMatchObject({
      format: 'tvinoferma-local-google-oauth-sealed',
      version: 1,
      algorithm: 'AES-256-GCM'
    });
    for (const secret of [oldRefresh, access, accountKey, clientId, slotId]) expect(ciphertext).not.toContain(secret);
    expect(await store.read()).toBe(ready());
    expect(await setup(backing, cryptoKey).read()).toBe(ready());
    expect(JSON.stringify(store)).toBe('{}');
  });

  it('уже занятую или повреждённую запись не считает пустой и не перезаписывает', async () => {
    const cryptoKey = await key();
    for (const existing of ['CORRUPTED_PRIVATE', '{}']) {
      const backing = fixture(existing);
      const store = setup(backing, cryptoKey);
      expect(await store.compareExchange(null, ready())).toBe('mismatch');
      expect(backing.get()).toBe(existing);
      expect(backing.swaps).not.toHaveBeenCalled();
    }
    const backing = fixture();
    const store = setup(backing, cryptoKey);
    expect(await store.compareExchange(null, ready())).toBe('swapped');
    const original = backing.get();
    expect(await store.compareExchange(null, ready({ refreshToken: newRefresh }))).toBe('mismatch');
    expect(backing.get()).toBe(original);
  });

  it('потеря записи при уже закреплённом pin блокирует refresh, а не подтверждает первое подключение', async () => {
    const backing = fixture();
    const store = setup(backing, await key());
    const fetchImpl = vi.fn();
    const coordinator = rotation(store, fetchImpl);
    expect(await coordinator.inspect()).toEqual({ status: 'blocked_missing' });
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'blocked_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(backing.swaps).not.toHaveBeenCalled();
  });

  it('разрешает ready → pending → ready и не сохраняет старый токен в расшифрованной pending-записи', async () => {
    const backing = fixture();
    const store = setup(backing, await key());
    const first = ready();
    const middle = pending(first);
    const last = nextReady(middle);
    expect(await store.compareExchange(null, first)).toBe('swapped');
    const firstCipher = backing.get();
    expect(await store.compareExchange(first, middle)).toBe('swapped');
    const pendingCipher = backing.get();
    expect(firstCipher).not.toBe(pendingCipher);
    expect(await store.read()).toBe(middle);
    expect(await store.read()).not.toContain(oldRefresh);
    expect(await store.compareExchange(middle, last)).toBe('swapped');
    expect(await store.read()).toBe(last);
    for (const raw of [firstCipher, pendingCipher, backing.get()]) containsNoPrivate(raw);
    // В адаптер бэкенда передаются только зашифрованные строки или null.
    for (const [expected, next] of backing.swaps.mock.calls) {
      if (expected !== null) containsNoPrivate(expected);
      containsNoPrivate(next);
    }
  });

  it('по возможности обнуляет буферы шифрования и скрывает исходную ошибку', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    let seenPlain;
    let seenIv;
    let seenAad;
    const badCrypto = {
      getRandomValues(bytes) {
        bytes.fill(42);
        return bytes;
      },
      subtle: {
        async encrypt(params, _key, plaintext) {
          seenPlain = plaintext;
          seenIv = params.iv;
          seenAad = params.additionalData;
          throw new Error(`PRIVATE_CRYPTO ${oldRefresh}`);
        }
      }
    };
    const store = setup(backing, cryptoKey, { cryptoSource: badCrypto });
    const message = await errorMessage(store.compareExchange(null, ready()));
    expect(message).toContain('Не удалось безопасно');
    containsNoPrivate(message);
    for (const buffer of [seenPlain, seenIv, seenAad]) expect([...buffer].every(byte => byte === 0)).toBe(true);
    expect(backing.swaps).not.toHaveBeenCalled();
  });

  it('не даёт обходить фазы или повторять старые ID через compareExchange', async () => {
    const backing = fixture();
    const store = setup(backing, await key());
    const first = ready();
    expect(await store.compareExchange(null, first)).toBe('swapped');
    const original = backing.get();
    const swaps = backing.swaps.mock.calls.length;
    const attempts = [
      [null, pending(first)],
      [first, ready({ revision: nextRevision, refreshToken: newRefresh })],
      [first, pending(first, { revision })],
      [first, pending(first, { attemptId: revision })],
      [pending(first), pending(first, { revision: nextRevision })],
      [pending(first), nextReady(pending(first), { revision: attemptId })]
    ];
    for (const [expected, next] of attempts)
      await expect(store.compareExchange(expected, next)).rejects.toThrow('Не удалось безопасно');
    expect(backing.swaps).toHaveBeenCalledTimes(swaps);
    expect(backing.get()).toBe(original);
  });

  it('две попытки с одним исходным значением не обе проходят доверенный CAS', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const firstStore = setup(backing, cryptoKey);
    const secondStore = setup(backing, cryptoKey);
    const source = ready();
    expect(await firstStore.compareExchange(null, source)).toBe('swapped');
    const outcomes = await Promise.all([
      firstStore.compareExchange(source, pending(source)),
      secondStore.compareExchange(source, pending(source, { revision: otherId }))
    ]);
    expect(outcomes.sort()).toEqual(['mismatch', 'swapped']);
    expect(parseGoogleCredentialRecord(await firstStore.read()).phase).toBe('pending');
  });

  it('нужны именно ключ и независимо заданные slot/client/account; неправильная привязка не расшифровывает', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const store = setup(backing, cryptoKey);
    expect(await store.compareExchange(null, ready())).toBe('swapped');
    const alternatives = [
      setup(backing, await key()),
      setup(backing, cryptoKey, { slotId: otherId }),
      setup(backing, cryptoKey, { accountKey: 'OTHER_ACCOUNT' }),
      setup(backing, cryptoKey, { clientId: '987654321-another.apps.googleusercontent.com' })
    ];
    for (const other of alternatives) {
      const message = await errorMessage(other.read());
      expect(message).toContain('Не удалось безопасно');
      containsNoPrivate(message);
    }
  });

  it('отклоняет изменённый конверт, нестандартный JSON, повторы и большие данные без исходных ошибок', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const store = setup(backing, cryptoKey);
    await store.compareExchange(null, ready());
    const original = backing.get();
    const value = JSON.parse(original);
    const change = text => (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
    const cases = [
      JSON.stringify({ ...value, iv: change(value.iv) }),
      JSON.stringify({ ...value, ciphertext: change(value.ciphertext) }),
      JSON.stringify({ ...value, version: 2 }),
      JSON.stringify({ ...value, algorithm: 'AES-128-GCM' }),
      JSON.stringify({ ...value, ciphertext: value.ciphertext + '=' }),
      JSON.stringify({ ...value, private: oldRefresh }),
      original.replace('"version":1', '"version":1,"version":1'),
      JSON.stringify(value, null, 2),
      'x'.repeat(24 * 1024 + 1),
      'null'
    ];
    for (const corrupted of cases) {
      backing.replace(corrupted);
      const message = await errorMessage(store.read());
      expect(message).toContain('Не удалось безопасно');
      containsNoPrivate(message);
    }
  });

  it('отклоняет неверный ключ и небезопасную конфигурацию до доступа к fake-store', async () => {
    const backing = fixture();
    const proper = await key();
    const extractable = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt'
    ]);
    const shortKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, [
      'encrypt',
      'decrypt'
    ]);
    const oneUse = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    for (const overrides of [
      { key: extractable },
      { key: shortKey },
      { key: oneUse },
      { key: null },
      { slotId: 'bad' },
      { clientId: 'bad' },
      { accountKey: 'mail@example.test' },
      { backend: {} },
      { cryptoSource: {} }
    ]) {
      expect(() => setup(backing, proper, overrides)).toThrow('Не удалось безопасно');
    }
    const getter = vi.fn(() => proper);
    const args = { slotId, clientId, accountKey, key: proper, backend: backing.backend, cryptoSource: webcrypto };
    Object.defineProperty(args, 'key', { enumerable: true, get: getter });
    expect(() => createGoogleEncryptedCredentialStore(args)).toThrow('Не удалось безопасно');
    expect(getter).not.toHaveBeenCalled();
    expect(backing.reads).not.toHaveBeenCalled();
    expect(backing.swaps).not.toHaveBeenCalled();
  });

  it('останавливает повторный nonce в одном экземпляре до изменения бэкенда', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const badCrypto = {
      subtle: webcrypto.subtle,
      getRandomValues(bytes) {
        bytes.fill(7);
        return bytes;
      }
    };
    const store = setup(backing, cryptoKey, { cryptoSource: badCrypto });
    await store.compareExchange(null, ready());
    const before = backing.get();
    await expect(store.compareExchange(ready(), pending())).rejects.toThrow('Не удалось безопасно');
    expect(backing.get()).toBe(before);
    expect(backing.swaps).toHaveBeenCalledOnce();
  });

  it('повтор nonce после создания другого экземпляра этот слой не обнаруживает', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const badCrypto = {
      subtle: webcrypto.subtle,
      getRandomValues(bytes) {
        bytes.fill(7);
        return bytes;
      }
    };
    const first = setup(backing, cryptoKey, { cryptoSource: badCrypto });
    await first.compareExchange(null, ready());
    const firstIv = JSON.parse(backing.get()).iv;
    const restarted = setup(backing, cryptoKey, { cryptoSource: badCrypto });
    expect(await restarted.compareExchange(ready(), pending())).toBe('swapped');
    expect(JSON.parse(backing.get()).iv).toBe(firstIv);
    // Это сознательная демонстрация границы: с реальными данными нужен CSPRNG и аудит.
  });

  it('подавляет детали сбоев backend и не считает потерянный ответ доказательством отсутствия записи', async () => {
    for (const fault of ['failBefore', 'failAfter', 'fakeSwap', 'badReadback']) {
      const backing = fixture();
      const store = setup(backing, await key());
      if (fault === 'badReadback') backing.faults[fault] = 2;
      else backing.faults[fault] = 1;
      const message = await errorMessage(store.compareExchange(null, ready()));
      expect(message).toContain('Не удалось безопасно');
      containsNoPrivate(message);
      if (fault === 'failAfter' || fault === 'badReadback') expect(backing.get()).not.toBeNull();
      else expect(backing.get()).toBeNull();
    }
    const backing = fixture();
    backing.faults.failRead = 1;
    const message = await errorMessage(setup(backing, await key()).read());
    expect(message).toContain('Не удалось безопасно');
    containsNoPrivate(message);
  });

  it('соединяется с отключённой моделью refresh: в fake-backend попадают только конверты', async () => {
    const backing = fixture();
    const store = setup(backing, await key());
    expect(await store.compareExchange(null, ready())).toBe('swapped');
    const fetchImpl = vi.fn(async () => {
      const during = parseGoogleCredentialRecord(await store.read());
      expect(during).toMatchObject({ phase: 'pending', refreshToken: null });
      containsNoPrivate(backing.get());
      return tokenReply();
    });
    const coordinator = rotation(store, fetchImpl);
    const result = await coordinator.refresh({ expectedRevision: revision });
    expect(result.status).toBe('refreshed');
    containsNoPrivate(result);
    expect(result.access.takeAccessToken()).toBe(access);
    expect(() => result.access.takeAccessToken()).toThrow();
    expect(parseGoogleCredentialRecord(await store.read())).toMatchObject({ phase: 'ready', refreshToken: newRefresh });
    containsNoPrivate(backing.get());
  });

  it('не делает POST при потерянном ответе записи pending; новый экземпляр видит pending', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const store = setup(backing, cryptoKey);
    await store.compareExchange(null, ready());
    backing.faults.failAfter = 2;
    const fetchImpl = vi.fn(async () => tokenReply());
    const coordinator = rotation(store, fetchImpl);
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'begin_uncertain' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await coordinator.inspect()).toEqual({ status: 'blocked_in_session' });
    backing.faults.failAfter = 0;
    expect(await rotation(setup(backing, cryptoKey), fetchImpl).inspect()).toEqual({ status: 'blocked_pending' });
    containsNoPrivate(backing.get());
  });

  it('не обнаруживает полный откат старого корректного конверта', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const store = setup(backing, cryptoKey);
    await store.compareExchange(null, ready());
    const oldCiphertext = backing.get();
    const coordinator = rotation(store);
    const result = await coordinator.refresh({ expectedRevision: revision });
    expect(result.status).toBe('refreshed');
    result.access.discard();
    backing.replace(oldCiphertext);
    expect(await rotation(setup(backing, cryptoKey)).inspect()).toEqual({ status: 'ready', revision });
    // Для реального использования нужен независимый защищённый якорь/anti-rollback.
  });
});
