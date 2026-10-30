import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  createGoogleEncryptedCredentialStore,
  createYandexEncryptedCredentialStore
} from '../js/modules/cloudSync/providers/oauthCredentialCipherStore.js';
import { createYandexEnrollmentAttempt } from '../js/modules/cloudSync/providers/oauthCredentialEnrollment.js';
import {
  parseYandexCredentialRecord,
  prepareYandexCredentialRecord
} from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';

const slotId = 'a1234567-1234-4abc-8def-123456789abc';
const revision = 'b1234567-1234-4abc-8def-123456789abc';
const otherId = 'c1234567-1234-4abc-8def-123456789abc';
const clientId = '0123456789abcdef0123456789abcdef';
const otherClient = 'fedcba9876543210fedcba9876543210';
const googleClient = '123456789-test_client.apps.googleusercontent.com';
const accountKey = 'FAKE_PRIVATE_ACCOUNT_123';
const access = 'FAKE_PRIVATE_ACCESS_123';
const otherAccess = 'FAKE_PRIVATE_ACCESS_456';
const refresh = 'FAKE_PRIVATE_REFRESH:456';
const label = { kind: 'login', value: 'fake.private-login_123' };

async function key() {
  return webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function record(changes = {}) {
  return prepareYandexCredentialRecord({
    slotId,
    clientId,
    accountKey,
    revision,
    accessToken: access,
    expiresAt: 3_700_000,
    ...changes
  });
}
function fixture(initial = null) {
  let value = initial;
  const faults = { failBefore: false, failAfter: false, failRead: false, badReadback: false };
  const read = vi.fn(async () => {
    if (faults.failRead) throw new Error(`PRIVATE_ERROR ${access}`);
    if (faults.badReadback) return 'PRIVATE_WRONG_READBACK';
    return value;
  });
  const compareExchange = vi.fn(async (expected, next) => {
    if (faults.failBefore) throw new Error(`PRIVATE_ERROR ${access}`);
    if (value !== expected) return 'mismatch';
    value = next;
    if (faults.failAfter) throw new Error(`PRIVATE_ERROR ${access}`);
    return 'swapped';
  });
  return {
    backend: { read, compareExchange },
    faults,
    get: () => value,
    replace: next => {
      value = next;
    }
  };
}
function setup(backing, cryptoKey, changes = {}) {
  return createYandexEncryptedCredentialStore({
    slotId,
    clientId,
    accountKey,
    key: cryptoKey,
    backend: backing.backend,
    cryptoSource: webcrypto,
    ...changes
  });
}
async function messageOf(promise) {
  try {
    await promise;
    return 'unexpected success';
  } catch (error) {
    return String(error);
  }
}
function noPrivate(text) {
  for (const secret of [access, otherAccess, refresh, accountKey, label.value, 'PRIVATE_ERROR'])
    expect(text).not.toContain(secret);
}

describe('Яндекс: отключённая AES-GCM обёртка и fake-CAS', () => {
  it('первая установка шифруется и читается тем же закреплённым контекстом', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const store = setup(backing, cryptoKey);
    expect(await store.read()).toBeNull();
    expect(await store.compareExchange(null, record())).toBe('swapped');
    const cipher = backing.get();
    expect(JSON.parse(cipher)).toMatchObject({
      format: 'tvinoferma-local-yandex-oauth-sealed',
      version: 1,
      algorithm: 'AES-256-GCM'
    });
    for (const privateValue of [access, refresh, accountKey, clientId, slotId, label.value])
      expect(cipher).not.toContain(privateValue);
    expect(await store.read()).toBe(record());
    expect(await setup(backing, cryptoKey).read()).toBe(record());
    expect(JSON.stringify(store)).toBe('{}');
  });

  it('не подменяет имеющийся или повреждённый конверт и не поддерживает замену токена', async () => {
    const cryptoKey = await key();
    const backing = fixture();
    const store = setup(backing, cryptoKey);
    expect(await store.compareExchange(null, record())).toBe('swapped');
    const original = backing.get();
    expect(await store.compareExchange(null, record({ revision: otherId, accessToken: otherAccess }))).toBe('mismatch');
    const error = await messageOf(
      store.compareExchange(record(), record({ revision: otherId, accessToken: otherAccess }))
    );
    expect(error).toContain('Не удалось безопасно');
    noPrivate(error);
    expect(backing.get()).toBe(original);
    expect(backing.backend.compareExchange).toHaveBeenCalledOnce();
    for (const corrupt of ['CORRUPT', '{}']) {
      const bad = fixture(corrupt);
      expect(await setup(bad, cryptoKey).compareExchange(null, record())).toBe('mismatch');
      expect(bad.get()).toBe(corrupt);
      expect(bad.backend.compareExchange).not.toHaveBeenCalled();
    }
  });

  it('отдельный key, клиент, аккаунт, slot и тип провайдера являются частью привязки', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const store = setup(backing, cryptoKey);
    expect(await store.compareExchange(null, record())).toBe('swapped');
    const wrong = [
      setup(backing, await key()),
      setup(backing, cryptoKey, { slotId: otherId }),
      setup(backing, cryptoKey, { clientId: otherClient }),
      setup(backing, cryptoKey, { accountKey: 'DIFFERENT_ACCOUNT' }),
      createGoogleEncryptedCredentialStore({
        slotId,
        clientId: googleClient,
        accountKey,
        key: cryptoKey,
        backend: backing.backend,
        cryptoSource: webcrypto
      })
    ];
    for (const reader of wrong) {
      const error = await messageOf(reader.read());
      expect(error).toContain('Не удалось безопасно');
      noPrivate(error);
    }
    expect(await store.read()).toBe(record());
  });

  it.each(['format', 'algorithm', 'iv', 'ciphertext'])(
    'повреждение %s отклоняется без раскрытия содержимого',
    async field => {
      const backing = fixture();
      const store = setup(backing, await key());
      expect(await store.compareExchange(null, record())).toBe('swapped');
      const envelope = JSON.parse(backing.get());
      if (field === 'format' || field === 'algorithm') envelope[field] += 'bad';
      else envelope[field] = (envelope[field][0] === 'A' ? 'B' : 'A') + envelope[field].slice(1);
      backing.replace(JSON.stringify(envelope));
      const error = await messageOf(store.read());
      expect(error).toContain('Не удалось безопасно');
      noPrivate(error);
    }
  );

  it('конкурирующие первые установки при атомарном fake-CAS не перезаписывают друг друга', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const left = setup(backing, cryptoKey);
    const right = setup(backing, cryptoKey);
    const second = record({ revision: otherId, accessToken: otherAccess });
    const outcomes = await Promise.all([left.compareExchange(null, record()), right.compareExchange(null, second)]);
    expect(outcomes.sort()).toEqual(['mismatch', 'swapped']);
    const actual = await left.read();
    expect([record(), second]).toContain(actual);
    const raw = backing.get();
    expect(raw).not.toContain(access);
    expect(raw).not.toContain(otherAccess);
  });

  it('ошибка после записи не выдаёт гарантированный отказ, а приватные детали не попадают в исключение', async () => {
    const backing = fixture();
    const store = setup(backing, await key());
    backing.faults.failAfter = true;
    const error = await messageOf(store.compareExchange(null, record()));
    expect(error).toContain('Не удалось безопасно');
    noPrivate(error);
    expect(backing.get()).not.toBeNull();
    expect(backing.get()).not.toContain(access);
    expect(await store.read()).toBe(record());
  });

  it('не подтверждает write при неуспешном readback', async () => {
    const backing = fixture();
    const store = setup(backing, await key());
    backing.backend.compareExchange.mockImplementation(async (expected, next) => {
      if (backing.get() !== expected) return 'mismatch';
      backing.replace(next);
      backing.faults.badReadback = true;
      return 'swapped';
    });
    const error = await messageOf(store.compareExchange(null, record()));
    expect(error).toContain('Не удалось безопасно');
    noPrivate(error);
    expect(backing.get()).not.toBeNull();
  });

  it('отклоняет некорректные ключи и записи, не вызывая backend', async () => {
    const backing = fixture();
    const extractableKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt'
    ]);
    expect(() => setup(backing, extractableKey)).toThrow('Не удалось безопасно');
    expect(() => setup(backing, awaitKeyPlaceholder())).toThrow('Не удалось безопасно');
    const store = setup(backing, await key());
    for (const bad of [
      record({ clientId: otherClient }),
      record({ accountKey: 'DIFFERENT_ACCOUNT' }),
      record({ slotId: otherId }),
      '{}'
    ]) {
      const error = await messageOf(store.compareExchange(null, bad));
      expect(error).toContain('Не удалось безопасно');
      noPrivate(error);
    }
    expect(backing.backend.compareExchange).not.toHaveBeenCalled();
  });

  it('один экземпляр отвергает повтор nonce даже при внешнем удалении записи', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const cryptoSource = {
      subtle: webcrypto.subtle,
      getRandomValues: value => {
        value.fill(7);
        return value;
      }
    };
    const store = setup(backing, cryptoKey, { cryptoSource });
    expect(await store.compareExchange(null, record())).toBe('swapped');
    backing.replace(null);
    const error = await messageOf(store.compareExchange(null, record({ revision: otherId })));
    expect(error).toContain('Не удалось безопасно');
    noPrivate(error);
    expect(backing.get()).toBeNull();
  });

  it('на поддельном хранилище проверяет связку подтверждения и зашифрованной первой установки', async () => {
    const backing = fixture();
    const cryptoKey = await key();
    const tokenResponse = {
      summary: {
        provider: 'yandex',
        operation: 'code',
        expiresAt: 3_700_000,
        refreshExpiresAt: null,
        refreshAvailable: true,
        scope: 'request_bound'
      },
      takeSecrets: () => ({ accessToken: access, refreshToken: refresh }),
      discard: () => {}
    };
    let store;
    const installer = {
      installIfAbsent: async value => {
        store = setup(backing, cryptoKey, {
          slotId: value.slotId,
          clientId: value.clientId,
          accountKey: value.accountKey
        });
        return (await store.compareExchange(null, value.record)) === 'swapped' ? 'installed' : 'occupied';
      },
      verifyInstallation: async value => (await store.read()) === value.record
    };
    const previewAccount = vi.fn(async () => ({ accountKey, label }));
    const confirmAccount = vi.fn(async () => true);
    const attempt = createYandexEnrollmentAttempt({
      clientId,
      tokenResponse,
      previewAccount,
      confirmAccount,
      installer,
      cryptoSource: webcrypto,
      now: () => 100_000
    });
    const result = await attempt.complete();
    expect(result).toEqual({ status: 'installed' });
    noPrivate(JSON.stringify(result));
    expect(previewAccount).toHaveBeenCalledTimes(2);
    expect(confirmAccount).toHaveBeenCalledOnce();
    expect(parseYandexCredentialRecord(await store.read()).accessToken).toBe(access);
    for (const privateValue of [access, refresh, accountKey, clientId, label.value])
      expect(backing.get()).not.toContain(privateValue);
  });
});

function awaitKeyPlaceholder() {
  return { type: 'secret', extractable: false, algorithm: { name: 'AES-GCM', length: 256 }, usages: ['encrypt'] };
}
