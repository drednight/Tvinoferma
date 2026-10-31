import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { enrollNativeCloudAccount } from '../js/modules/cloudSync/providers/nativeOAuthEnrollment.js';
import { readNativeCredentialBinding } from '../js/modules/cloudSync/providers/nativeCredentialStore.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';
import {
  parseGoogleCredentialRecord,
  serializeGoogleCredentialRecord
} from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { parseYandexCredentialRecord } from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';

const CLIENTS = {
  google: '123456789-test_client.apps.googleusercontent.com',
  yandex: '0123456789abcdef0123456789abcdef'
};
const CODE = 'FAKE_TEST_CODE';
const ACCESS = 'FAKE_PRIVATE_ACCESS';
const REFRESH = 'FAKE_PRIVATE_REFRESH';
const ACCOUNT = 'FAKE_PRIVATE_ACCOUNT';
const LABELS = { google: 'fake-user@example.test', yandex: 'fake-user' };
function json(body) {
  return { body: JSON.stringify(body), contentType: 'application/json; charset=utf-8' };
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(provider, extra = {}) {
  const controller = new AbortController();
  const events = [];
  const slots = new Map();
  let identityCount = 0;
  const token = {
    access_token: ACCESS,
    refresh_token: REFRESH,
    expires_in: 3600,
    token_type: 'bearer',
    ...(provider === 'google' ? { scope: OAUTH_PROVIDERS.google.scope } : {}),
    ...extra.token
  };
  const invoke = vi.fn(async (command, args) => {
    if (command === 'cloud_credential_binding_read') {
      const stored = slots.get(args.provider);
      if (!stored) return { status: 'empty' };
      if (stored.status !== 'ready') return { status: 'blocked' };
      const parsed =
        args.provider === 'google'
          ? parseGoogleCredentialRecord(stored.record)
          : parseYandexCredentialRecord(stored.record);
      if (parsed.phase === 'pending') return { status: 'pending' };
      return { status: 'ready', slotId: parsed.slotId, clientId: parsed.clientId, accountKey: parsed.accountKey };
    }
    if (command === 'cloud_credential_read')
      return extra.read ? extra.read() : slots.get(args.provider) || { status: 'empty' };
    if (command === 'cloud_credential_compare_exchange') {
      if (extra.cas) return extra.cas(args, slots);
      const stored = slots.get(args.provider);
      if (stored?.record !== args.expected || stored?.slotId !== args.slotId) return { status: 'mismatch' };
      slots.set(args.provider, { status: 'ready', slotId: args.slotId, record: args.next });
      return { status: 'swapped' };
    }
    if (command === 'cloud_credential_install') {
      if (slots.has(args.provider)) return { status: 'occupied' };
      slots.set(args.provider, { status: 'ready', slotId: args.slotId, record: args.record });
      return extra.install ? extra.install(args) : { status: 'installed' };
    }
    if (command === 'cloud_oauth_callback_begin') return { port: args.port || 37181 };
    if (command === 'cloud_oauth_callback_poll') return extra.poll ? extra.poll() : { status: 'code', code: CODE };
    if (command === 'cloud_oauth_callback_cancel') return null;
    if (command === 'cloud_oauth_network') {
      if (args.operation === 'exchange') return extra.exchange ? extra.exchange(args) : json(token);
      if (args.operation === 'identity') {
        identityCount++;
        if (extra.identity) return extra.identity(identityCount, args);
        return json(
          provider === 'google'
            ? { user: { permissionId: ACCOUNT, emailAddress: LABELS.google } }
            : { login: LABELS.yandex, id: '123456', client_id: CLIENTS.yandex, psuid: ACCOUNT }
        );
      }
    }
    throw new Error(`FAKE_PRIVATE_ERROR ${ACCESS}`);
  });
  const openBrowser = vi.fn(async () => {});
  const confirmAccount = vi.fn(extra.confirm || (async () => true));
  const options = {
    provider,
    clientId: CLIENTS[provider],
    invoke,
    openBrowser,
    confirmAccount,
    signal: controller.signal,
    firstConnectionConfirmed: true,
    onProgress: stage => events.push(stage),
    cryptoSource: webcrypto,
    pollIntervalMs: 20,
    storeTimeoutMs: 1000
  };
  return { controller, events, slots, invoke, openBrowser, confirmAccount, options };
}
function assertNoPrivate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [CODE, ACCESS, REFRESH, ACCOUNT, ...Object.values(LABELS), 'FAKE_PRIVATE_ERROR'])
    expect(text).not.toContain(secret);
}
async function waitForCall(invoke, command, operation) {
  await vi.waitFor(() => {
    expect(
      invoke.mock.calls.some(([cmd, args]) => cmd === command && (!operation || args.operation === operation))
    ).toBe(true);
  });
}

describe('полный экспериментальный PKCE → подтверждение → поддельное локальное хранилище', () => {
  it.each(['google', 'yandex'])('%s: результат не содержит секреты и данные пользователя', async provider => {
    const s = setup(provider);
    const result = await enrollNativeCloudAccount(s.options);
    expect(result).toEqual({ status: 'installed' });
    assertNoPrivate(result);
    expect(s.confirmAccount).toHaveBeenCalledOnce();
    const args = s.confirmAccount.mock.calls[0][0];
    expect(args).toMatchObject({ provider, clientId: CLIENTS[provider], label: { value: LABELS[provider] } });
    for (const secret of [CODE, ACCESS, REFRESH, ACCOUNT]) expect(JSON.stringify(args)).not.toContain(secret);
    const stored = s.slots.get(provider);
    const parsed =
      provider === 'google' ? parseGoogleCredentialRecord(stored.record) : parseYandexCredentialRecord(stored.record);
    expect(parsed).toMatchObject({ clientId: CLIENTS[provider], accountKey: ACCOUNT });
    const binding = await readNativeCredentialBinding({ provider, invoke: s.invoke });
    expect(binding).toEqual({
      status: 'ready',
      binding: { slotId: stored.slotId, clientId: CLIENTS[provider], accountKey: ACCOUNT }
    });
    expect(JSON.stringify(binding)).not.toContain(ACCESS);
    expect(JSON.stringify(binding)).not.toContain(REFRESH);
    expect(stored.record).not.toContain(LABELS[provider]);
    if (provider === 'google') {
      expect(parsed.refreshToken).toBe(REFRESH);
      expect(stored.record).not.toContain(ACCESS);
    } else {
      expect(parsed.accessToken).toBe(ACCESS);
      expect(stored.record).not.toContain(REFRESH);
    }
    expect(s.invoke.mock.calls.filter(([command]) => command === 'cloud_credential_install')).toHaveLength(1);
    expect(
      s.invoke.mock.calls.filter(
        ([command, value]) => command === 'cloud_oauth_network' && value.operation === 'identity'
      )
    ).toHaveLength(2);
    expect(s.events).toEqual([
      'checking_local',
      'browser',
      'token',
      'identity',
      'confirming',
      'identity',
      'installing'
    ]);
    const authorize = new URL(s.openBrowser.mock.calls[0][0]);
    if (provider === 'google') {
      expect(authorize.searchParams.get('access_type')).toBe('offline');
      expect(authorize.searchParams.get('prompt')).toBe('consent');
    } else {
      expect(authorize.searchParams.has('prompt')).toBe(false);
    }
  });

  it('без отдельного подтверждения первого подключения не вызывает браузер и IPC', async () => {
    const s = setup('yandex');
    await expect(enrollNativeCloudAccount({ ...s.options, firstConnectionConfirmed: false })).rejects.toThrow();
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.openBrowser).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'pending', 'configured'])(
    'локальное состояние %s не открывает OAuth и не перезаписывается',
    async state => {
      const s = setup('google');
      if (state === 'blocked') s.slots.set('google', { status: 'blocked' });
      else {
        const ready =
          '{"format":"tvinoferma-google-oauth-credential","version":1,"slotId":"01234567-89ab-4cde-8f01-23456789abcd","clientId":"123456789-test_client.apps.googleusercontent.com","accountKey":"FAKE_PRIVATE_ACCOUNT","revision":"11234567-89ab-4cde-8f01-23456789abcd","phase":"ready","attemptId":null,"refreshToken":"FAKE_PRIVATE_REFRESH","refreshExpiresAt":null}';
        let record = ready;
        if (state === 'pending') {
          record = ready
            .replace('"phase":"ready"', '"phase":"pending"')
            .replace('"attemptId":null', '"attemptId":"21234567-89ab-4cde-8f01-23456789abcd"')
            .replace('"refreshToken":"FAKE_PRIVATE_REFRESH"', '"refreshToken":null');
        }
        s.slots.set('google', { status: 'ready', slotId: '01234567-89ab-4cde-8f01-23456789abcd', record });
      }
      expect(await enrollNativeCloudAccount(s.options)).toEqual({
        status: state === 'configured' ? 'already_configured' : 'local_blocked'
      });
      expect(s.openBrowser).not.toHaveBeenCalled();
      expect(s.invoke.mock.calls.filter(([command]) => command === 'cloud_credential_install')).toHaveLength(0);
    }
  );

  it('если Google не выдал refresh token, не делает вид, что подключение установлено', async () => {
    const s = setup('google', { token: { refresh_token: undefined } });
    expect(await enrollNativeCloudAccount(s.options)).toEqual({ status: 'refresh_missing' });
    expect(s.confirmAccount).not.toHaveBeenCalled();
    expect(s.slots.size).toBe(0);
  });

  it('отказ и изменение аккаунта до установки не сохраняют доступ', async () => {
    const declined = setup('yandex', { confirm: async () => false });
    expect(await enrollNativeCloudAccount(declined.options)).toEqual({ status: 'declined' });
    expect(declined.slots.size).toBe(0);
    const changed = setup('yandex', {
      identity: count =>
        json({
          login: LABELS.yandex,
          id: '123456',
          client_id: CLIENTS.yandex,
          psuid: count === 1 ? ACCOUNT : 'OTHER_ACCOUNT'
        })
    });
    expect(await enrollNativeCloudAccount(changed.options)).toEqual({ status: 'account_changed' });
    expect(changed.slots.size).toBe(0);
  });

  it('отмена во время обмена отбрасывает поздний результат и не устанавливает запись', async () => {
    const gate = deferred();
    const s = setup('yandex', { exchange: () => gate.promise });
    const request = enrollNativeCloudAccount(s.options);
    await waitForCall(s.invoke, 'cloud_oauth_network', 'exchange');
    s.controller.abort();
    expect(await request).toEqual({ status: 'cancelled' });
    gate.resolve(json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: 'bearer' }));
    await Promise.resolve();
    expect(s.slots.size).toBe(0);
    expect(
      s.invoke.mock.calls.filter(
        ([command, args]) => command === 'cloud_oauth_network' && args.operation === 'identity'
      )
    ).toHaveLength(0);
  });

  it('отмена уже начавшейся установки не объявляет её отменённой', async () => {
    const gate = deferred();
    const s = setup('yandex', { install: () => gate.promise });
    const request = enrollNativeCloudAccount(s.options);
    await waitForCall(s.invoke, 'cloud_credential_install');
    s.controller.abort();
    gate.resolve({ status: 'installed' });
    expect(await request).toEqual({ status: 'installed' });
    expect(s.slots.has('yandex')).toBe(true);
  });

  it('таймаут начатой записи возвращает неопределённость и не повторяет её', async () => {
    const gate = deferred();
    const s = setup('yandex', { install: () => gate.promise });
    const request = enrollNativeCloudAccount({ ...s.options, storeTimeoutMs: 20 });
    await waitForCall(s.invoke, 'cloud_credential_install');
    expect(await request).toEqual({ status: 'installation_uncertain' });
    gate.resolve({ status: 'installed' });
    await Promise.resolve();
    expect(s.invoke.mock.calls.filter(([command]) => command === 'cloud_credential_install')).toHaveLength(1);
  });

  it('ошибка нативной диагностики не раскрывает токен и не повторяет обмен', async () => {
    const s = setup('yandex', { exchange: () => Promise.reject(new Error(`FAKE_PRIVATE_ERROR ${ACCESS}`)) });
    const result = await enrollNativeCloudAccount(s.options);
    expect(result).toMatchObject({ status: 'failed' });
    assertNoPrivate(result);
    expect(
      s.invoke.mock.calls.filter(
        ([command, args]) => command === 'cloud_oauth_network' && args.operation === 'exchange'
      )
    ).toHaveLength(1);
    expect(s.slots.size).toBe(0);
  });
});

it('сохранение доступа показывает безопасную причину обмена и не трогает vault', async () => {
  const s = setup('google', {
    exchange: () => {
      throw 'oauth_client_secret_required';
    }
  });
  const result = await enrollNativeCloudAccount(s.options);
  expect(result).toEqual({ status: 'failed', diagnostic: { stage: 'token', code: 'client_secret_required' } });
  expect(s.invoke.mock.calls.some(([command]) => command === 'cloud_credential_install')).toBe(false);
});

describe('fresh Google reconnection preserves the existing protected slot', () => {
  function makeOld(s, phase = 'ready', extra = {}) {
    const stored = s.slots.get('google'),
      old = parseGoogleCredentialRecord(stored.record);
    stored.record = serializeGoogleCredentialRecord({
      ...old,
      ...extra,
      phase,
      ...(phase === 'pending'
        ? {
            revision: generateSyncId(webcrypto),
            attemptId: generateSyncId(webcrypto),
            refreshToken: null,
            refreshExpiresAt: null
          }
        : { refreshToken: 'FAKE_OLD_UNCERTAIN_REFRESH' })
    });
    return { ...stored };
  }
  it.each(['ready', 'pending'])('%s → fresh browser OAuth → same slot/client/account', async phase => {
    const s = setup('google');
    expect(await enrollNativeCloudAccount(s.options)).toEqual({ status: 'installed' });
    const old = makeOld(s, phase);
    s.invoke.mockClear();
    s.confirmAccount.mockClear();
    const result = await enrollNativeCloudAccount({ ...s.options, reconnect: true });
    expect(result).toEqual({ status: 'installed' });
    assertNoPrivate(result);
    expect(s.confirmAccount).toHaveBeenCalledOnce();
    const fresh = parseGoogleCredentialRecord(s.slots.get('google').record);
    expect(fresh).toMatchObject({
      slotId: old.slotId,
      phase: 'ready',
      refreshToken: REFRESH,
      accountKey: ACCOUNT,
      clientId: CLIENTS.google
    });
    const calls = s.invoke.mock.calls;
    expect(calls.filter(([c]) => c === 'cloud_credential_compare_exchange')).toHaveLength(phase === 'ready' ? 2 : 1);
    expect(calls.filter(([c, a]) => c === 'cloud_oauth_network' && a.operation === 'identity')).toHaveLength(2);
    expect(calls.filter(([c]) => c === 'cloud_credential_install')).toHaveLength(0);
    expect(
      calls.some(
        ([c, a]) => c.includes('dataset') || c.includes('outbox') || c.includes('forget') || a?.operation === 'refresh'
      )
    ).toBe(false);
    expect(JSON.stringify(calls.filter(([c]) => c === 'cloud_oauth_network'))).not.toContain(
      'FAKE_OLD_UNCERTAIN_REFRESH'
    );
  });
  it.each(['client', 'account'])('rejects a different %s without replacing credentials', async kind => {
    const s = setup('google');
    await enrollNativeCloudAccount(s.options);
    const old = makeOld(
      s,
      'pending',
      kind === 'client' ? { clientId: 'different.apps.googleusercontent.com' } : { accountKey: 'different_account' }
    );
    s.openBrowser.mockClear();
    s.invoke.mockClear();
    s.confirmAccount.mockClear();
    expect(await enrollNativeCloudAccount({ ...s.options, reconnect: true })).toEqual({ status: 'account_changed' });
    expect(s.slots.get('google')).toEqual(old);
    expect(s.confirmAccount).not.toHaveBeenCalled();
    if (kind === 'client') expect(s.openBrowser).not.toHaveBeenCalled();
    expect(s.invoke.mock.calls.some(([c]) => c === 'cloud_credential_compare_exchange')).toBe(false);
  });
  it('concurrent change is not overwritten', async () => {
    let conflict = false;
    const s = setup('google', {
      confirm: async () => {
        if (conflict) {
          const stored = s.slots.get('google');
          const parsed = parseGoogleCredentialRecord(stored.record);
          stored.record = serializeGoogleCredentialRecord({ ...parsed, revision: generateSyncId(webcrypto) });
        }
        return true;
      }
    });
    await enrollNativeCloudAccount(s.options);
    makeOld(s, 'pending');
    conflict = true;
    s.invoke.mockClear();
    expect(await enrollNativeCloudAccount({ ...s.options, reconnect: true })).toEqual({ status: 'already_configured' });
    expect(s.invoke.mock.calls.some(([c]) => c === 'cloud_credential_compare_exchange')).toBe(false);
  });
  it('lost CAS reply remains uncertain and does not repeat', async () => {
    const s = setup('google', {
      cas: async (args, slots) => {
        slots.set('google', { status: 'ready', slotId: args.slotId, record: args.next });
        throw new Error('FAKE_PRIVATE_ERROR');
      }
    });
    await enrollNativeCloudAccount(s.options);
    makeOld(s, 'pending');
    s.invoke.mockClear();
    const result = await enrollNativeCloudAccount({ ...s.options, reconnect: true });
    expect(result).toEqual({ status: 'installation_uncertain' });
    assertNoPrivate(result);
    expect(s.invoke.mock.calls.filter(([c]) => c === 'cloud_credential_compare_exchange')).toHaveLength(1);
  });
  it('reconnect never falls back to first installation on an empty store', async () => {
    const s = setup('google');
    expect(await enrollNativeCloudAccount({ ...s.options, reconnect: true })).toEqual({ status: 'local_blocked' });
    expect(s.openBrowser).not.toHaveBeenCalled();
    expect(s.invoke.mock.calls.some(([c]) => c === 'cloud_credential_install')).toBe(false);
  });
});

it.each(['ready', 'pending'])('reconnection stops on native CAS mismatch (%s)', async phase => {
  const s = setup('google', { cas: async () => ({ status: 'mismatch' }) });
  await enrollNativeCloudAccount(s.options);
  const old = s.slots.get('google');
  if (phase === 'pending')
    old.record = serializeGoogleCredentialRecord({
      ...parseGoogleCredentialRecord(old.record),
      phase: 'pending',
      revision: generateSyncId(webcrypto),
      attemptId: generateSyncId(webcrypto),
      refreshToken: null,
      refreshExpiresAt: null
    });
  const saved = { ...old };
  s.invoke.mockClear();
  expect(await enrollNativeCloudAccount({ ...s.options, reconnect: true })).toEqual({ status: 'already_configured' });
  expect(s.slots.get('google')).toEqual(saved);
  expect(s.invoke.mock.calls.filter(([c]) => c === 'cloud_credential_compare_exchange')).toHaveLength(1);
});

it('reconnection checks the pinned account again AFTER user confirmation', async () => {
  const s = setup('google', {
    identity: async count =>
      json({ user: { permissionId: count === 4 ? 'DIFFERENT_ACCOUNT' : ACCOUNT, emailAddress: LABELS.google } })
  });
  await enrollNativeCloudAccount(s.options);
  const old = { ...s.slots.get('google') };
  s.invoke.mockClear();
  s.confirmAccount.mockClear();
  expect(await enrollNativeCloudAccount({ ...s.options, reconnect: true })).toEqual({ status: 'account_changed' });
  expect(s.confirmAccount).toHaveBeenCalledOnce();
  expect(s.slots.get('google')).toEqual(old);
  expect(s.invoke.mock.calls.some(([c]) => c === 'cloud_credential_compare_exchange')).toBe(false);
});

it.each([1, 2])('ready reconnection does not continue after lost CAS reply at step %s', async lostStep => {
  let count = 0;
  const s = setup('google', {
    cas: async (args, slots) => {
      slots.set('google', { status: 'ready', slotId: args.slotId, record: args.next });
      if (++count === lostStep) throw new Error('FAKE_PRIVATE_ERROR');
      return { status: 'swapped' };
    }
  });
  await enrollNativeCloudAccount(s.options);
  s.invoke.mockClear();
  expect(await enrollNativeCloudAccount({ ...s.options, reconnect: true })).toEqual({
    status: 'installation_uncertain'
  });
  expect(s.invoke.mock.calls.filter(([c]) => c === 'cloud_credential_compare_exchange')).toHaveLength(lostStep);
  expect(parseGoogleCredentialRecord(s.slots.get('google').record).phase).toBe(lostStep === 1 ? 'pending' : 'ready');
});

it('declining fresh Google account confirmation keeps the old access unchanged', async () => {
  let decline = false;
  const s = setup('google', { confirm: async () => !decline });
  await enrollNativeCloudAccount(s.options);
  decline = true;
  const old = { ...s.slots.get('google') };
  s.invoke.mockClear();
  expect(await enrollNativeCloudAccount({ ...s.options, reconnect: true })).toEqual({ status: 'declined' });
  expect(s.slots.get('google')).toEqual(old);
  expect(s.invoke.mock.calls.some(([c]) => c === 'cloud_credential_compare_exchange')).toBe(false);
});
