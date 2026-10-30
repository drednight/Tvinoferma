import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createGoogleAccountIdentityReader } from '../js/modules/cloudSync/providers/oauthAccountIdentity.js';
import { createGoogleCredentialRotation } from '../js/modules/cloudSync/providers/oauthCredentialRotation.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%29';
const clientId = '123456789-test_client.apps.googleusercontent.com';
const token = 'FAKE_ACCESS-TOKEN_123';
const accountKey = 'FAKE_ACCOUNT_123';

function reply(body = JSON.stringify({ user: { permissionId: accountKey } }), options = {}) {
  const response = new Response(body, {
    status: options.status || 200,
    headers: { 'Content-Type': options.type || 'application/json; charset=UTF-8', ...(options.headers || {}) }
  });
  Object.defineProperty(response, 'url', { value: options.url ?? ABOUT_URL });
  if (options.redirected) Object.defineProperty(response, 'redirected', { value: true });
  if (options.responseType) Object.defineProperty(response, 'type', { value: options.responseType });
  return response;
}
function input(extra = {}) {
  return { accessToken: token, clientId, signal: new AbortController().signal, ...extra };
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function errorMessage(promise) {
  try {
    await promise;
    return 'unexpected success';
  } catch (error) {
    return String(error);
  }
}

describe('отключённое чтение идентификатора Google Drive about.get', () => {
  it('читает только permissionId с фиксированного URL и отправляет токен только в заголовке', async () => {
    const fetchImpl = vi.fn(async () => reply(' { "user" : { "permissionId" : "FAKE_ACCOUNT_123" } } '));
    const check = createGoogleAccountIdentityReader({ fetchImpl });
    const result = await check(input());
    expect(result).toEqual({ accountKey });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(ABOUT_URL);
    expect(url).not.toContain(token);
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
  });

  it('понимает экранированные имена/значение, но не повторные поля', async () => {
    const fetchImpl = vi.fn(async () =>
      reply('{"\\u0075ser":{"permission\\u0049d":"FAKE_ACCOUNT_\\u0031\\u0032\\u0033"}}')
    );
    const check = createGoogleAccountIdentityReader({ fetchImpl });
    expect(await check(input())).toEqual({ accountKey });
    const duplicate = createGoogleAccountIdentityReader({
      fetchImpl: async () => reply('{"user":{"permissionId":"FAKE","permission\\u0049d":"PRIVATE"}}')
    });
    await expect(duplicate(input())).rejects.toThrow('Не удалось проверить');
  });

  it.each([
    '{}',
    '[]',
    '{"user":null}',
    '{"user":{"permissionId":null}}',
    '{"user":{"permissionId":""}}',
    '{"user":{"permissionId":"has space"}}',
    '{"user":{"permissionId":"mail@example.test"}}',
    '{"user":{"permissionId":"' + 'x'.repeat(257) + '"}}',
    '{"user":{"permissionId":"PRIVATE"},"user":{"permissionId":"OTHER"}}',
    '{"user":{"permissionId":"PRIVATE","permissionId":"OTHER"}}',
    '{"user":{"permissionId":"PRIVATE","emailAddress":"PRIVATE_EMAIL"}}',
    '{"kind":"drive#about","user":{"permissionId":"PRIVATE"}}',
    '{"user":{"permissionId":"PRIVATE"}} trailing',
    '{"user":{"permissionId":"BROKEN\\u00"}}'
  ])('не раскрывает и не принимает повреждённый, повторный или лишний JSON: %#', async body => {
    const check = createGoogleAccountIdentityReader({ fetchImpl: async () => reply(body) });
    const message = await errorMessage(check(input()));
    expect(message).toContain('Не удалось проверить');
    expect(message).not.toContain(token);
    expect(message).not.toContain('PRIVATE');
  });

  it('ограничивает тип, размер, UTF-8, статус и конечный URL', async () => {
    const variants = [
      reply(undefined, { type: 'text/html' }),
      reply(undefined, { headers: { 'Content-Length': '8193' } }),
      reply(undefined, { headers: { 'Content-Length': '-1' } }),
      reply('x'.repeat(8193)),
      reply(Uint8Array.from([0xc3, 0x28])),
      reply(undefined, { status: 401 }),
      reply(undefined, { status: 302 }),
      reply(undefined, { url: 'https://evil.example/' }),
      reply(undefined, { redirected: true }),
      reply(undefined, { responseType: 'opaque' })
    ];
    for (const response of variants) {
      const check = createGoogleAccountIdentityReader({ fetchImpl: async () => response });
      await expect(check(input())).rejects.toThrow('Не удалось проверить');
    }
  });

  it('не начинает запрос при неверных токене, client ID или signal', async () => {
    const fetchImpl = vi.fn();
    const check = createGoogleAccountIdentityReader({ fetchImpl });
    const cancelled = new AbortController();
    cancelled.abort();
    const bad = [
      { accessToken: '' },
      { accessToken: 'with space' },
      { accessToken: 'TOKEN\r\nInjected' },
      { accessToken: 'x'.repeat(8193) },
      { clientId: 'bad' },
      { signal: null },
      { signal: cancelled.signal },
      { extra: 'PRIVATE_EXTRA' }
    ];
    for (const override of bad) await expect(check(input(override))).rejects.toThrow('Не удалось проверить');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => createGoogleAccountIdentityReader({ fetchImpl, timeoutMs: 1 })).toThrow('Не удалось проверить');
    expect(() => createGoogleAccountIdentityReader({})).toThrow('Не удалось проверить');
  });

  it('подавляет исходную ошибку, которая может содержать токен и идентификатор', async () => {
    const check = createGoogleAccountIdentityReader({
      fetchImpl: async () => {
        throw new Error(`${token} ${accountKey} PRIVATE`);
      }
    });
    const message = await errorMessage(check(input()));
    expect(message).toContain('Не удалось проверить');
    for (const secret of [token, accountKey, 'PRIVATE']) expect(message).not.toContain(secret);
  });

  it('таймаут отменяет ожидание, а зависший fetch занимает слот до реального завершения', async () => {
    const later = deferred();
    let signal;
    const fetchImpl = vi.fn((_url, init) => {
      signal = init.signal;
      return later.promise;
    });
    const check = createGoogleAccountIdentityReader({ fetchImpl, timeoutMs: 20 });
    await expect(check(input())).rejects.toThrow('Не удалось проверить');
    expect(signal.aborted).toBe(true);
    await expect(check(input())).rejects.toThrow('Не удалось проверить');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const lateReply = reply();
    const cancel = vi.spyOn(lateReply.body, 'cancel');
    later.resolve(lateReply);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    fetchImpl.mockImplementation(async () => reply());
    await vi.waitFor(async () => expect(await check(input())).toEqual({ accountKey }));
  });

  it('не принимает поздний результат даже если таймер ещё не успел сработать', async () => {
    let time = 100;
    const clock = vi.spyOn(globalThis.performance, 'now').mockImplementation(() => time);
    try {
      const late = reply();
      const cancel = vi.spyOn(late.body, 'cancel');
      const check = createGoogleAccountIdentityReader({
        fetchImpl: async () => {
          time = 120;
          return late;
        },
        timeoutMs: 20
      });
      await expect(check(input())).rejects.toThrow('Не удалось проверить');
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('после разбора ещё раз проверяет срок до выдачи идентификатора', async () => {
    let calls = 0;
    const clock = vi.spyOn(globalThis.performance, 'now').mockImplementation(() => (++calls >= 5 ? 120 : 100));
    try {
      const check = createGoogleAccountIdentityReader({ fetchImpl: async () => reply(), timeoutMs: 20 });
      await expect(check(input())).rejects.toThrow('Не удалось проверить');
      expect(calls).toBeGreaterThanOrEqual(5);
    } finally {
      clock.mockRestore();
    }
  });

  it('по внешнему signal останавливается и пытается отменить зависшее чтение тела', async () => {
    const reader = { read: vi.fn(() => new Promise(() => {})), cancel: vi.fn(async () => {}), releaseLock: vi.fn() };
    const response = {
      status: 200,
      type: 'basic',
      redirected: false,
      url: ABOUT_URL,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader: () => reader, cancel: vi.fn() }
    };
    const fetchImpl = vi.fn(async () => response);
    const check = createGoogleAccountIdentityReader({ fetchImpl, timeoutMs: 1000 });
    const controller = new AbortController();
    const pending = check(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow('Не удалось проверить');
    expect(reader.cancel).toHaveBeenCalled();
    await expect(check(input())).rejects.toThrow('Не удалось проверить');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('если signal был отменён во время подписки, не вызывает даже некооперативный fetch', async () => {
    let aborted = false;
    const strangeSignal = {
      get aborted() {
        return aborted;
      },
      addEventListener(_name, callback) {
        aborted = true;
        callback();
      },
      removeEventListener() {}
    };
    const fetchImpl = vi.fn(async () => reply());
    const check = createGoogleAccountIdentityReader({ fetchImpl });
    await expect(check(input({ signal: strangeSignal }))).rejects.toThrow('Не удалось проверить');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ошибка нестандартного signal не раскрывает детали и не оставляет слот занятым', async () => {
    const fetchImpl = vi.fn(async () => reply());
    const check = createGoogleAccountIdentityReader({ fetchImpl });
    const brokenSubscription = {
      aborted: false,
      addEventListener(_name, callback) {
        callback();
        throw new Error('PRIVATE_SUBSCRIPTION');
      },
      removeEventListener() {}
    };
    const message = await errorMessage(check(input({ signal: brokenSubscription })));
    expect(message).toContain('Не удалось проверить');
    expect(message).not.toContain('PRIVATE_SUBSCRIPTION');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await check(input())).toEqual({ accountKey });

    let reads = 0;
    const brokenGetter = {
      get aborted() {
        if (++reads > 2) throw new Error('PRIVATE_GETTER');
        return false;
      },
      addEventListener() {},
      removeEventListener() {
        throw new Error('PRIVATE_UNSUBSCRIBE');
      }
    };
    const before = fetchImpl.mock.calls.length;
    const getterMessage = await errorMessage(check(input({ signal: brokenGetter })));
    expect(getterMessage).toContain('Не удалось проверить');
    expect(getterMessage).not.toContain('PRIVATE');
    expect(fetchImpl).toHaveBeenCalledTimes(before);
    await vi.waitFor(async () => expect(await check(input())).toEqual({ accountKey }));
  });

  it('соединяет экспериментальные POST и about.get с поддельными ответами; другой аккаунт блокирует сохранение', async () => {
    const slotId = 'aa8b55c7-f70e-4db4-bce2-9fe520a71936';
    const revision = 'd2041a21-99a5-427c-9db7-b8ca59e22b34';
    let raw = JSON.stringify({
      format: 'tvinoferma-google-oauth-credential',
      version: 1,
      slotId,
      clientId,
      accountKey,
      revision,
      phase: 'ready',
      attemptId: null,
      refreshToken: 'FAKE_OLD_REFRESH',
      refreshExpiresAt: null
    });
    const store = {
      read: async () => raw,
      compareExchange: async (expected, next) => {
        if (raw !== expected) return 'mismatch';
        raw = next;
        return 'swapped';
      }
    };
    let seenAccount = accountKey;
    const fetchImpl = vi.fn(async url => {
      if (url === OAUTH_PROVIDERS.google.token) {
        const response = new Response(
          JSON.stringify({
            access_token: token,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: OAUTH_PROVIDERS.google.scope,
            refresh_token: 'FAKE_ROTATED_REFRESH'
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      expect(url).toBe(ABOUT_URL);
      return reply(JSON.stringify({ user: { permissionId: seenAccount } }));
    });
    const verifyAccount = createGoogleAccountIdentityReader({ fetchImpl });
    const options = {
      slotId,
      clientId,
      accountKey,
      store,
      fetchImpl,
      verifyAccount,
      cryptoSource: webcrypto,
      now: () => 100_000
    };
    const coordinator = createGoogleCredentialRotation(options);
    const first = await coordinator.refresh({ expectedRevision: revision });
    expect(first.status).toBe('refreshed');
    first.access.discard();
    const nextRevision = JSON.parse(raw).revision;
    expect(JSON.parse(raw).refreshToken).toBe('FAKE_ROTATED_REFRESH');
    seenAccount = 'DIFFERENT_ACCOUNT';
    const second = await coordinator.refresh({ expectedRevision: nextRevision });
    expect(second).toEqual({ status: 'account_changed' });
    expect(JSON.parse(raw)).toMatchObject({ phase: 'pending', refreshToken: null });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      OAUTH_PROVIDERS.google.token,
      ABOUT_URL,
      OAUTH_PROVIDERS.google.token,
      ABOUT_URL
    ]);
  });
});
