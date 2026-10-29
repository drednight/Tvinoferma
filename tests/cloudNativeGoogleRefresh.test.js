import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createNativeGoogleRefreshFetch } from '../js/modules/cloudSync/providers/nativeGoogleRefreshFetch.js';
import { createGoogleRefreshRequest } from '../js/modules/cloudSync/providers/oauthTokenTransport.js';
import { createNativeGoogleCredentialStore } from '../js/modules/cloudSync/providers/nativeCredentialStore.js';
import {
  prepareGoogleCredentialRecord,
  parseGoogleCredentialRecord
} from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { createGoogleCredentialRotation } from '../js/modules/cloudSync/providers/oauthCredentialRotation.js';
import { createGoogleAccountIdentityReader } from '../js/modules/cloudSync/providers/oauthAccountIdentity.js';
import { createNativeDiskFetch } from '../js/modules/cloudSync/providers/nativeDiskFetch.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const slotId = '01234567-89ab-4cde-8f01-23456789abcd';
const revision = '11234567-89ab-4cde-8f01-23456789abcd';
const clientId = 'fake-client.apps.googleusercontent.com';
const accountKey = 'FAKE_PRIVATE_ACCOUNT';
const oldRefresh = 'FAKE_OLD_REFRESH:+/';
const newRefresh = 'FAKE_NEW_REFRESH';
const accessToken = 'FAKE_ACCESS_TOKEN';
function initialRecord() {
  return prepareGoogleCredentialRecord({
    slotId,
    revision,
    clientId,
    accountKey,
    refreshToken: oldRefresh,
    refreshExpiresAt: null
  });
}
function init(body, signal = new AbortController().signal) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fakeNative({ lost = false, identity = accountKey } = {}) {
  let record = initialRecord();
  const invoke = vi.fn(async (command, args) => {
    if (command === 'cloud_credential_read') return { status: 'ready', slotId, record };
    if (command === 'cloud_credential_compare_exchange') {
      if (args.slotId !== slotId || args.expected !== record) return { status: 'mismatch' };
      record = args.next;
      return { status: 'swapped' };
    }
    if (command === 'cloud_oauth_network') {
      expect(args.provider).toBe('google');
      expect(args.operation).toBe('refresh');
      expect(args.accessToken).toBeNull();
      expect(new URLSearchParams(args.form).get('refresh_token')).toBe(oldRefresh);
      expect(parseGoogleCredentialRecord(record)).toMatchObject({ phase: 'pending', refreshToken: null });
      if (lost) throw new Error('PRIVATE результат refresh мог быть потерян');
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: newRefresh,
          scope: OAUTH_PROVIDERS.google.scope
        })
      };
    }
    if (command === 'cloud_disk_network' && args.args.operation === 'identity') {
      expect(args.args.accessToken).toBe(accessToken);
      expect(parseGoogleCredentialRecord(record).phase).toBe('pending');
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: { permissionId: identity } })
      };
    }
    throw new Error('PRIVATE unexpected fake IPC');
  });
  return { invoke, record: () => record };
}
function coordinator(native) {
  const store = createNativeGoogleCredentialStore({ slotId, clientId, accountKey, invoke: native.invoke });
  const fetchImpl = createNativeGoogleRefreshFetch({ invoke: native.invoke });
  const verifyAccount = createGoogleAccountIdentityReader({
    fetchImpl: createNativeDiskFetch({ provider: 'google', invoke: native.invoke })
  });
  return createGoogleCredentialRotation({
    slotId,
    clientId,
    accountKey,
    store,
    fetchImpl,
    verifyAccount,
    cryptoSource: webcrypto,
    now: () => 100000,
    timeoutMs: 1000,
    identityTimeoutMs: 1000
  });
}

describe('экспериментальный refresh Google через fake IPC', () => {
  it('согласует credential CAS, POST и проверку аккаунта до выдачи одноразового access', async () => {
    const native = fakeNative();
    const rotation = coordinator(native);
    expect(await rotation.inspect()).toEqual({ status: 'ready', revision });
    const result = await rotation.refresh({ expectedRevision: revision });
    expect(result.status).toBe('refreshed');
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(result.access.takeAccessToken()).toBe(accessToken);
    expect(() => result.access.takeAccessToken()).toThrow();
    expect(parseGoogleCredentialRecord(native.record())).toMatchObject({ phase: 'ready', refreshToken: newRefresh });
    expect(native.record()).not.toContain(oldRefresh);
    expect(native.record()).not.toContain(accessToken);
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cloud_oauth_network')).toHaveLength(1);
  });

  it('не повторяет неизвестный refresh после перезапуска и не возвращает секреты в ошибках', async () => {
    const native = fakeNative({ lost: true });
    const rotation = coordinator(native);
    expect(await rotation.refresh({ expectedRevision: revision })).toEqual({ status: 'exchange_uncertain' });
    expect(parseGoogleCredentialRecord(native.record())).toMatchObject({ phase: 'pending', refreshToken: null });
    expect(await rotation.inspect()).toEqual({ status: 'blocked_in_session' });
    const reopened = coordinator(native);
    expect(await reopened.inspect()).toEqual({ status: 'blocked_pending' });
    expect(await reopened.refresh({ expectedRevision: revision })).toEqual({ status: 'blocked_pending' });
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cloud_oauth_network')).toHaveLength(1);
  });

  it('другой аккаунт после POST оставляет pending и не выдаёт токен', async () => {
    const native = fakeNative({ identity: 'OTHER_ACCOUNT' });
    const rotation = coordinator(native);
    expect(await rotation.refresh({ expectedRevision: revision })).toEqual({ status: 'account_changed' });
    expect(parseGoogleCredentialRecord(native.record())).toMatchObject({ phase: 'pending', refreshToken: null });
  });

  it('отклоняет неизвестные адреса, поля, типы, повторные ключи и Яндекс до IPC', async () => {
    const invoke = vi.fn();
    const fetch = createNativeGoogleRefreshFetch({ invoke });
    const request = createGoogleRefreshRequest({ clientId, refreshToken: oldRefresh });
    const good = init(request.body);
    for (const [url, candidate] of [
      ['https://oauth.yandex.com/token', good],
      [request.url + '?extra=1', good],
      [request.url, { ...good, method: 'GET' }],
      [request.url, { ...good, redirect: 'follow' }],
      [request.url, { ...good, headers: { ...good.headers, Cookie: 'PRIVATE' } }],
      [request.url, { ...good, body: `${request.body}&refresh_token=twice` }],
      [request.url, { ...good, body: `${request.body}&client_secret=PRIVATE` }],
      [request.url, { ...good, body: request.body.replace('refresh_token', 'authorization_code') }],
      [
        request.url,
        { ...good, body: request.body.replace('fake-client.apps.googleusercontent.com', 'yandex-client-id') }
      ]
    ])
      await expect(fetch(url, candidate)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('отмена не освобождает слот до завершения native POST', async () => {
    const gate = deferred();
    const invoke = vi.fn(() => gate.promise);
    const fetch = createNativeGoogleRefreshFetch({ invoke });
    const request = createGoogleRefreshRequest({ clientId, refreshToken: oldRefresh });
    const controller = new AbortController();
    const first = fetch(request.url, init(request.body, controller.signal));
    await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toThrow();
    await expect(fetch(request.url, init(request.body))).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    gate.resolve({ body: '{}', contentType: 'application/json' });
    await gate.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    const later = fetch(request.url, init(request.body));
    await expect(later).resolves.toMatchObject({ status: 200 });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('скрывает ошибки и не принимает некорректные ответы IPC', async () => {
    const request = createGoogleRefreshRequest({ clientId, refreshToken: oldRefresh });
    for (const value of [
      null,
      { body: 'PRIVATE', contentType: '' },
      { body: 'x'.repeat(65537), contentType: 'application/json' },
      { body: '{}', contentType: 'application/json', extra: 'PRIVATE' }
    ]) {
      const fetch = createNativeGoogleRefreshFetch({ invoke: vi.fn(async () => value) });
      await expect(fetch(request.url, init(request.body))).rejects.not.toThrow('PRIVATE');
    }
    const fetch = createNativeGoogleRefreshFetch({
      invoke: vi.fn(async () => {
        throw new Error('PRIVATE REFRESH');
      })
    });
    await expect(fetch(request.url, init(request.body))).rejects.not.toThrow('PRIVATE');
  });
});
