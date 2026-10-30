import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { checkCloudOAuthRegistration } from '../js/modules/cloudSync/providers/oauthRegistrationCheck.js';
import { createNativeOAuthCheckFetch } from '../js/modules/cloudSync/providers/nativeOAuthCheckFetch.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const CLIENTS = {
  google: '123456789-test_client.apps.googleusercontent.com',
  yandex: '0123456789abcdef0123456789abcdef'
};
const ACCESS = 'FAKE_TEST_ACCESS_TOKEN_123';
const REFRESH = 'FAKE_TEST_REFRESH_TOKEN_123';
const CODE = 'FAKE_TEST_CODE';
const KEY = 'FAKE_ACCOUNT_KEY_123';
const EMAIL = 'fake-check@example.test';
const LOGIN = 'fake-check';
const IDENTITY_URLS = {
  google: 'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%2CemailAddress%29',
  yandex: 'https://login.yandex.ru/info?format=json'
};

function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
function json(body, contentType = 'application/json; charset=utf-8') {
  return { body: JSON.stringify(body), contentType };
}
function setup(provider = 'yandex', extra = {}) {
  const controller = new AbortController();
  const events = [];
  const calls = [];
  const token = {
    access_token: ACCESS,
    refresh_token: REFRESH,
    expires_in: 3600,
    token_type: 'bearer',
    ...(provider === 'google' ? { scope: OAUTH_PROVIDERS.google.scope } : {}),
    ...extra.token
  };
  const identity =
    provider === 'google'
      ? { user: { permissionId: KEY, emailAddress: EMAIL } }
      : { login: LOGIN, id: '123456', client_id: CLIENTS.yandex, psuid: KEY };
  const invoke = vi.fn(async (command, args) => {
    calls.push({ command, args });
    if (command === 'cloud_oauth_callback_begin') return { port: args.port || 37181 };
    if (command === 'cloud_oauth_callback_poll') return extra.poll ? extra.poll() : { status: 'code', code: CODE };
    if (command === 'cloud_oauth_callback_cancel') return null;
    if (command === 'cloud_oauth_network') {
      if (args.operation === 'exchange') return extra.exchange ? extra.exchange(args) : json(token);
      if (args.operation === 'identity') return extra.identity ? extra.identity(args) : json(identity);
    }
    throw new Error('FAKE_PRIVATE_NATIVE_ERROR');
  });
  const openBrowser = vi.fn(async () => {});
  const options = {
    provider,
    clientId: CLIENTS[provider],
    invoke,
    openBrowser,
    signal: controller.signal,
    cryptoSource: webcrypto,
    pollIntervalMs: 20,
    onProgress: stage => events.push(stage)
  };
  return { controller, calls, events, invoke, openBrowser, options };
}
function noSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [ACCESS, REFRESH, CODE, KEY, 'FAKE_PRIVATE_NATIVE_ERROR']) expect(text).not.toContain(secret);
}
async function waitForCall(mock, command, operation) {
  await vi.waitFor(() => {
    expect(mock.mock.calls.some(([cmd, args]) => cmd === command && (!operation || args.operation === operation))).toBe(
      true
    );
  });
}

function requestOptions(provider, signal, method = 'POST') {
  return method === 'POST'
    ? {
        method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'grant_type=authorization_code',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal
      }
    : {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `${provider === 'google' ? 'Bearer' : 'OAuth'} ${ACCESS}`
        },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal
      };
}

describe('одноразовая диагностика регистрации: fake IPC и fake провайдеры', () => {
  it.each(['google', 'yandex'])(
    '%s проходит callback, обмен и проверку аккаунта, ничего не сохраняя',
    async provider => {
      const s = setup(provider);
      const result = await checkCloudOAuthRegistration(s.options);
      expect(result).toEqual({
        status: 'checked',
        scope: provider === 'google' ? 'reported' : 'request_bound',
        label: provider === 'google' ? { kind: 'email', value: EMAIL } : { kind: 'login', value: LOGIN }
      });
      noSecrets(result);
      expect(s.events).toEqual(['browser', 'token', 'identity']);
      const browser = new URL(s.openBrowser.mock.calls[0][0]);
      expect(browser.searchParams.get('access_type')).toBeNull();
      expect(browser.searchParams.get('scope')).toBe(OAUTH_PROVIDERS[provider].scope);
      expect(browser.searchParams.get('client_secret')).toBeNull();
      const requests = s.calls.filter(item => item.command === 'cloud_oauth_network');
      expect(requests.map(item => item.args.operation)).toEqual(['exchange', 'identity']);
      expect(requests[0].args.accessToken).toBeNull();
      const form = new URLSearchParams(requests[0].args.form);
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe(CODE);
      expect(form.get('client_id')).toBe(CLIENTS[provider]);
      expect(form.get('client_secret')).toBeNull();
      expect(form.get('refresh_token')).toBeNull();
      expect(requests[1].args).toEqual({
        provider,
        operation: 'identity',
        form: null,
        accessToken: ACCESS,
        refreshClaim: null
      });
      expect(
        s.calls.map(item => item.command).every(command => !/secrets|save|store|upload|download/.test(command))
      ).toBe(true);
      expect(s.invoke.mock.calls.filter(([command]) => command === 'cloud_oauth_network')).toHaveLength(2);
    }
  );

  it('Google без scope не объявляется подтверждённым правом', async () => {
    const s = setup('google', { token: { scope: undefined } });
    expect(await checkCloudOAuthRegistration(s.options)).toMatchObject({ status: 'checked', scope: 'unverified' });
  });

  it('не принимает лишние выданные права, неправильный тип ответа или чужой client_id', async () => {
    for (const extra of [
      { token: { scope: 'cloud_api:disk.app_folder login:email' } },
      { exchange: () => json({ access_token: ACCESS, expires_in: 3600, token_type: 'bearer' }, 'text/html') },
      { identity: () => json({ login: LOGIN, id: '1', client_id: 'another-client', psuid: KEY }) },
      { identity: () => ({ body: 'x'.repeat(70_000), contentType: 'application/json' }) }
    ]) {
      const s = setup('yandex', extra);
      const result = await checkCloudOAuthRegistration(s.options);
      expect(result).toEqual({ status: 'failed' });
      noSecrets(result);
      expect(
        s.invoke.mock.calls.filter(
          ([command, args]) => command === 'cloud_oauth_network' && args.operation === 'exchange'
        )
      ).toHaveLength(1);
    }
  });

  it.each(['denied', 'expired', 'error'])('завершает %s без запроса токена', async status => {
    const s = setup('yandex', { poll: () => ({ status }) });
    const result = await checkCloudOAuthRegistration(s.options);
    expect(result).toEqual({ status: status === 'error' ? 'failed' : status });
    expect(s.calls.some(item => item.command === 'cloud_oauth_network')).toBe(false);
  });

  it('отмена во время callback запрещает использовать поздний код', async () => {
    const gate = deferred();
    const s = setup('yandex', { poll: () => gate.promise });
    const pending = checkCloudOAuthRegistration(s.options);
    await waitForCall(s.invoke, 'cloud_oauth_callback_poll');
    s.controller.abort();
    gate.resolve({ status: 'code', code: CODE });
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(s.calls.some(item => item.command === 'cloud_oauth_network')).toBe(false);
    expect(s.calls.some(item => item.command === 'cloud_oauth_callback_cancel')).toBe(true);
  });

  it('отмена во время POST не запускает identity и не повторяет обмен, даже после позднего ответа', async () => {
    const gate = deferred();
    const s = setup('yandex', { exchange: () => gate.promise });
    const pending = checkCloudOAuthRegistration(s.options);
    await waitForCall(s.invoke, 'cloud_oauth_network', 'exchange');
    s.controller.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    gate.resolve(json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: 'bearer' }));
    await Promise.resolve();
    expect(s.calls.filter(item => item.command === 'cloud_oauth_network')).toHaveLength(1);
  });

  it('не раскрывает исходную ошибку и не делает автоматический повтор POST', async () => {
    const s = setup('yandex', {
      exchange: () => {
        throw new Error(`FAKE_PRIVATE_NATIVE_ERROR ${ACCESS}`);
      }
    });
    const result = await checkCloudOAuthRegistration(s.options);
    expect(result).toEqual({ status: 'failed' });
    noSecrets(result);
    expect(s.calls.filter(item => item.command === 'cloud_oauth_network')).toHaveLength(1);
  });
});

describe('мост диагностики разрешает только закреплённые операции', () => {
  it.each(['google', 'yandex'])(
    '%s передаёт конкретную операцию, а не адрес или произвольные заголовки',
    async provider => {
      const outer = new AbortController();
      const inner = new AbortController();
      const invoke = vi.fn(async () => ({ body: '{}', contentType: 'application/json' }));
      const fetchImpl = createNativeOAuthCheckFetch({ provider, invoke, signal: outer.signal });
      const response = await fetchImpl(IDENTITY_URLS[provider], requestOptions(provider, inner.signal, 'GET'));
      expect(response.url).toBe(IDENTITY_URLS[provider]);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(invoke).toHaveBeenCalledWith('cloud_oauth_network', {
        provider,
        operation: 'identity',
        form: null,
        accessToken: ACCESS,
        refreshClaim: null
      });
      expect(await response.body.getReader().read()).toMatchObject({ done: false });
      await expect(
        fetchImpl('https://attacker.example/steal', requestOptions(provider, inner.signal))
      ).rejects.toThrow();
      await expect(
        fetchImpl(`${OAUTH_PROVIDERS[provider].token}?x=1`, requestOptions(provider, inner.signal))
      ).rejects.toThrow();
      await expect(
        fetchImpl(IDENTITY_URLS[provider], { ...requestOptions(provider, inner.signal, 'GET'), body: 'x' })
      ).rejects.toThrow();
      await expect(
        fetchImpl(IDENTITY_URLS[provider], {
          ...requestOptions(provider, inner.signal, 'GET'),
          headers: { Accept: 'application/json', Authorization: `Bearer ${ACCESS}\r\nX-Test: x` }
        })
      ).rejects.toThrow();
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  );

  it('отклоняет неправильно устроенный ответ IPC и скрывает ошибку', async () => {
    const controller = new AbortController();
    for (const answer of [
      { body: '{}', contentType: 'application/json', url: 'https://attacker.example' },
      { body: '{}', contentType: null },
      { body: 'x'.repeat(64 * 1024 + 1), contentType: 'application/json' }
    ]) {
      const invoke = vi.fn(async () => answer);
      const fetchImpl = createNativeOAuthCheckFetch({ provider: 'yandex', invoke, signal: controller.signal });
      await expect(
        fetchImpl(OAUTH_PROVIDERS.yandex.token, requestOptions('yandex', controller.signal))
      ).rejects.toThrow('Не удалось безопасно выполнить запрос авторизации');
    }
  });
});
