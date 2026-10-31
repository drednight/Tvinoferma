import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createAuthenticatedCloudSession } from '../js/modules/cloudSync/providers/authenticatedSession.js';
import { createCloudUploadTransport } from '../js/modules/cloudSync/providers/uploadTransport.js';
import { createYandexAccountIdentityReader } from '../js/modules/cloudSync/providers/oauthAccountIdentity.js';
import {
  cloudAccessDiagnostic,
  withCloudAccessDiagnostic
} from '../js/modules/cloudSync/providers/cloudAccessDiagnostics.js';
import { checkCloudAccess } from '../js/modules/cloudSync/checkCloudAccess.js';
import { encryptSnapshot, generateRecoveryKey } from '../js/modules/cloudSync/envelope.js';

const datasetId = '31234567-89ab-4cde-8f01-23456789abcd';
const versionId = '41234567-89ab-4cde-8f01-23456789abcd';
const clients = { google: 'test.apps.googleusercontent.com', yandex: '0123456789abcdef' };
const accountKey = 'FAKE_PRIVATE_ACCOUNT';
function response(url, value, status = 200) {
  const reply = new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  Object.defineProperty(reply, 'url', { value: url });
  return reply;
}
function fixture(provider, { identityStatus = 200, diskStatus = 200, invalid = false, identity = accountKey } = {}) {
  const fetchImpl = vi.fn(async (url, init) => {
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const isIdentity = url.includes('/about?') || url.includes('/info?');
    return response(
      url,
      isIdentity
        ? provider === 'google'
          ? { user: { permissionId: identity } }
          : { client_id: clients.yandex, psuid: identity }
        : invalid
          ? {}
          : provider === 'google'
            ? { files: [] }
            : { type: 'dir', _embedded: { items: [] } },
      isIdentity ? identityStatus : diskStatus
    );
  });
  const session = createAuthenticatedCloudSession({
    provider,
    clientId: clients[provider],
    accountKey,
    datasetId,
    accessToken: 'FAKE_PRIVATE_TOKEN',
    fetchImpl,
    ...(provider === 'google' ? { folderId: 'root' } : {})
  });
  return { session, fetchImpl };
}
describe.each(['google', 'yandex'])('%s: проверка реальных стадий API на fake fetch', provider => {
  it('читает идентификатор и API без записи и без личных полей в результате', async () => {
    const f = fixture(provider);
    expect(await f.session.checkAccount()).toEqual({ status: 'access_verified' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [503, 'service_unavailable']
  ])('различает отказ identity %s до обращения к диску', async (status, reason) => {
    const f = fixture(provider, { identityStatus: status });
    expect(await f.session.checkAccount()).toEqual({ status: `identity_${reason}` });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [503, 'service_unavailable']
  ])('различает отказ API диска %s', async (status, reason) => {
    const f = fixture(provider, { diskStatus: status });
    expect(await f.session.checkAccount()).toEqual({ status: `disk_${reason}` });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('останавливается при чужом аккаунте и неверном ответе API', async () => {
    const f = fixture(provider, { identity: 'OTHER_ACCOUNT' });
    expect(await f.session.checkAccount()).toEqual({ status: 'account_mismatch' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await fixture(provider, { invalid: true }).session.checkAccount()).toEqual({
      status: 'disk_invalid_response'
    });
  });
  it('верхний preflight освобождает сессию и не трогает хранилища/очередь', async () => {
    const f = fixture(provider);
    const dispose = vi.fn(),
      invoke = vi.fn();
    const openSession = vi.fn(async () => ({ status: 'opened', session: { ...f.session, dispose } }));
    expect(await checkCloudAccess({ provider, invoke, openSession })).toEqual({ status: 'access_verified' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });
});
it('метаданные ошибки не сериализуются и не доверяют поддельным свойствам/геттерам', () => {
  const error = new Error('PRIVATE_TOKEN');
  expect(cloudAccessDiagnostic(withCloudAccessDiagnostic(error, 'identity_forbidden'))).toBe('identity_forbidden');
  expect(JSON.stringify(error)).toBe('{}');
  const forged = {
    get diagnostic() {
      throw new Error('getter called');
    }
  };
  expect(cloudAccessDiagnostic(forged)).toBeUndefined();
  expect(cloudAccessDiagnostic(withCloudAccessDiagnostic({}, 'PRIVATE_TOKEN'))).toBeUndefined();
});
it('не раскрывает исходное исключение сети и не смягчает строгую схему identity', async () => {
  const verify = createYandexAccountIdentityReader({
    fetchImpl: async () => {
      throw new Error('PRIVATE_TOKEN');
    }
  });
  try {
    await verify({ clientId: clients.yandex, accessToken: 'FAKE_PRIVATE_TOKEN', signal: new AbortController().signal });
    throw new Error('success');
  } catch (error) {
    expect(cloudAccessDiagnostic(error)).toBe('identity_transport_unavailable');
    expect(String(error)).not.toContain('PRIVATE_TOKEN');
  }
});
it.each([
  [403, 'upload_link_forbidden'],
  [503, 'upload_link_service_unavailable'],
  [401, 'upload_link_unauthorized']
])('различает отказ ссылки Яндекса %s без PUT и без смены старого контракта not_sent', async (status, code) => {
  const envelope = await encryptSnapshot({
    snapshot: {},
    recoveryKey: generateRecoveryKey(webcrypto),
    datasetId,
    versionId,
    cryptoSource: webcrypto
  });
  const fetchImpl = vi.fn(async url => response(url, {}, status));
  const transport = createCloudUploadTransport({
    provider: 'yandex',
    datasetId,
    accessToken: 'FAKE_PRIVATE_TOKEN',
    fetchImpl
  });
  const reply = await transport.upload({ envelope });
  expect(reply).toEqual({ status: 'not_sent' });
  expect(cloudAccessDiagnostic(reply)).toBe(code);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
});

it('после начала PUT неизвестный исход не помечается отказом до записи', async () => {
  const envelope = await encryptSnapshot({
    snapshot: {},
    recoveryKey: generateRecoveryKey(webcrypto),
    datasetId,
    versionId,
    cryptoSource: webcrypto
  });
  const fetchImpl = vi.fn(async (url, init) => {
    if (init.method === 'PUT') throw new Error('PRIVATE uncertain PUT');
    return response(url, {
      href: 'https://uploader1.dst.yandex.net/upload-target/private',
      method: 'PUT',
      templated: false
    });
  });
  const reply = await createCloudUploadTransport({
    provider: 'yandex',
    datasetId,
    accessToken: 'FAKE_TOKEN',
    fetchImpl
  }).upload({ envelope });
  expect(reply).toEqual({ status: 'unknown' });
  expect(cloudAccessDiagnostic(reply)).toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('различает таймаут identity без раскрытия исключений и повторов', async () => {
  const verify = createYandexAccountIdentityReader({ fetchImpl: () => new Promise(() => {}), timeoutMs: 20 });
  let error;
  try {
    await verify({ clientId: clients.yandex, accessToken: 'FAKE_TOKEN', signal: new AbortController().signal });
  } catch (e) {
    error = e;
  }
  expect(cloudAccessDiagnostic(error)).toBe('identity_timeout');
});

it('ошибка повторной identity перед upload сохраняет старый account_unavailable и точный безопасный этап', async () => {
  const f = fixture('yandex', { identityStatus: 403 });
  const envelope = await encryptSnapshot({
    snapshot: {},
    recoveryKey: generateRecoveryKey(webcrypto),
    datasetId,
    versionId,
    cryptoSource: webcrypto
  });
  const result = await f.session.upload({ envelope });
  expect(result).toEqual({ status: 'account_unavailable' });
  expect(cloudAccessDiagnostic(result)).toBe('identity_forbidden');
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});

it.each(['binding_missing', 'binding_blocked', 'login_required'])(
  'проверка неподключённого/закрытого Google (%s) не блокирует уже настроенный Яндекс',
  async status => {
    vi.resetModules();
    const { checkCloudAccess: check } = await import('../js/modules/cloudSync/checkCloudAccess.js');
    expect(await check({ provider: 'google', invoke: vi.fn(), openSession: async () => ({ status }) })).toEqual({
      status
    });
    const f = fixture('yandex');
    expect(
      await check({
        provider: 'yandex',
        invoke: vi.fn(),
        openSession: async () => ({ status: 'opened', session: { ...f.session, dispose: vi.fn() } })
      })
    ).toEqual({ status: 'access_verified' });
  }
);
