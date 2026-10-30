import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { startCloudOAuth } from '../js/modules/cloudSync/providers/oauthPkce.js';
import {
  createCloudOAuthTokenTransport,
  createGoogleRefreshRequest
} from '../js/modules/cloudSync/providers/oauthTokenTransport.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const clients = {
  google: '123456789-test_client.apps.googleusercontent.com',
  yandex: '0123456789abcdef0123456789abcdef'
};
const fakeCode = 'FAKE_CODE/+';
const fakeAccess = 'FAKE_ACCESS_TOKEN-123';
const fakeRefresh = 'FAKE_REFRESH_TOKEN:123/+=';
const fakeVerifier = 'a'.repeat(43);
const port = 37411;

function codeRequest(provider, extra = {}) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clients[provider],
    code: fakeCode,
    code_verifier: fakeVerifier
  });
  if (provider === 'google') params.set('redirect_uri', `http://127.0.0.1:${port}/oauth/cloud/callback`);
  return {
    method: 'POST',
    url: OAUTH_PROVIDERS[provider].token,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    redirect: 'error',
    body: params.toString(),
    ...extra
  };
}

function validJson(provider, changes = {}) {
  return JSON.stringify({
    access_token: fakeAccess,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: OAUTH_PROVIDERS[provider].scope,
    refresh_token: fakeRefresh,
    ...changes
  });
}

function response(provider, body = validJson(provider), options = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=UTF-8', ...(options.headers || {}) });
  const result = new Response(body, { status: options.status || 200, headers });
  Object.defineProperty(result, 'url', { value: options.url ?? OAUTH_PROVIDERS[provider].token });
  if (options.redirected) Object.defineProperty(result, 'redirected', { value: true });
  return result;
}

function transport(provider = 'google', operation = 'code', extra = {}) {
  const fetchImpl = vi.fn(async () => response(provider));
  const instance = createCloudOAuthTokenTransport({
    provider,
    clientId: clients[provider],
    operation,
    fetchImpl,
    ...extra
  });
  return { instance, fetchImpl };
}

function changedBody(request, change) {
  const fields = new URLSearchParams(request.body);
  change(fields);
  return { ...request, body: fields.toString() };
}

async function messageOf(promise) {
  try {
    await promise;
    return 'UNEXPECTED_SUCCESS';
  } catch (error) {
    return String(error);
  }
}

afterEach(() => vi.useRealTimers());

describe('подготовительный одноразовый POST OAuth', () => {
  it.each(['google', 'yandex'])(
    '%s проверяет запрос и передаёт только фиксированный HTTPS endpoint',
    async provider => {
      const { instance, fetchImpl } = transport(provider);
      const request = codeRequest(provider);
      const lease = await instance.send(request);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(OAUTH_PROVIDERS[provider].token);
      expect(init).toMatchObject({
        method: 'POST',
        body: request.body,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(lease.summary).toMatchObject({ provider, operation: 'code', scope: 'reported', refreshAvailable: true });
      expect(JSON.stringify(lease)).not.toContain(fakeCode);
      expect(JSON.stringify(lease)).not.toContain(fakeAccess);
      expect(JSON.stringify(lease)).not.toContain(fakeRefresh);
      expect(Object.isFrozen(lease)).toBe(true);
      expect(Object.isFrozen(lease.summary)).toBe(true);
      expect(lease.takeSecrets()).toEqual({ accessToken: fakeAccess, refreshToken: fakeRefresh });
      expect(() => lease.takeSecrets()).toThrow('больше не доступны');
      await expect(instance.send(request)).rejects.toThrow('уже использована');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['google', 'yandex'])(
    '%s без scope оставляет права неподтверждёнными, а не предполагает их',
    async provider => {
      const body = JSON.parse(validJson(provider));
      delete body.scope;
      const { instance } = transport(provider, 'code', {
        fetchImpl: vi.fn(async () => response(provider, JSON.stringify(body)))
      });
      const lease = await instance.send(codeRequest(provider));
      expect(lease.summary.scope).toBe('unverified');
      // Это низкоуровневая метка, а не запрет использования: вызывающий код
      // обязан сам не допускать синхронизацию без проверенной политики прав.
      expect(lease.takeSecrets()).toEqual({ accessToken: fakeAccess, refreshToken: fakeRefresh });
      expect(() => lease.takeSecrets()).toThrow();
      const other = transport(provider, 'code', { fetchImpl: async () => response(provider, JSON.stringify(body)) });
      const discarded = await other.instance.send(codeRequest(provider));
      discarded.discard();
      expect(() => discarded.takeSecrets()).toThrow();
    }
  );

  it.each(['google', 'yandex'])(
    '%s связывает PKCE-подготовку с ограниченным транспортом через поддельный IPC',
    async provider => {
      let opened;
      const invoke = async command => {
        if (command === 'cloud_oauth_callback_begin') return { port };
        if (command === 'cloud_oauth_callback_poll') return { status: 'code', code: fakeCode };
        if (command === 'cloud_oauth_callback_cancel') return null;
        throw new Error('unexpected');
      };
      const flow = await startCloudOAuth({
        provider,
        clientId: clients[provider],
        ...(provider === 'yandex' ? { port } : {}),
        invoke,
        openBrowser: async url => {
          opened = new URL(url);
        },
        cryptoSource: webcrypto
      });
      expect(await flow.poll()).toEqual({ status: 'code_ready' });
      const { instance, fetchImpl } = transport(provider);
      const lease = await flow.exchange(instance.send);
      expect(lease.summary.scope).toBe('reported');
      expect(lease.takeSecrets()).toEqual({ accessToken: fakeAccess, refreshToken: fakeRefresh });
      const sent = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
      const hash = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(sent.get('code_verifier')));
      const challenge = Buffer.from(hash).toString('base64url');
      expect(challenge).toBe(opened.searchParams.get('code_challenge'));
      expect(await flow.poll()).toEqual({ status: 'consumed' });
    }
  );

  it('Яндекс без поля scope связывает права только с исходной PKCE-попыткой', async () => {
    let opened;
    const flow = await startCloudOAuth({
      provider: 'yandex',
      clientId: clients.yandex,
      port,
      invoke: async command => {
        if (command === 'cloud_oauth_callback_begin') return { port };
        if (command === 'cloud_oauth_callback_poll') return { status: 'code', code: fakeCode };
        if (command === 'cloud_oauth_callback_cancel') return null;
        throw new Error('unexpected');
      },
      openBrowser: async url => {
        opened = new URL(url);
      },
      cryptoSource: webcrypto
    });
    expect(opened.searchParams.get('scope')).toBe(OAUTH_PROVIDERS.yandex.scope);
    expect(opened.searchParams.has('optional_scope')).toBe(false);
    expect(await flow.poll()).toEqual({ status: 'code_ready' });
    const body = JSON.parse(validJson('yandex'));
    delete body.scope;
    const fakeFetch = vi.fn(async () => response('yandex', JSON.stringify(body)));
    const first = transport('yandex', 'code', { fetchImpl: fakeFetch }).instance;
    let original;
    const lease = await flow.exchange(request => {
      original = request;
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.headers)).toBe(true);
      return first.send(request);
    });
    expect(lease.summary.scope).toBe('request_bound');
    expect(lease.takeSecrets()).toEqual({ accessToken: fakeAccess, refreshToken: fakeRefresh });
    expect(await flow.poll()).toEqual({ status: 'consumed' });

    // Другая транспортная попытка не наследует одноразовую привязку: даже если
    // локальная проверка пропустила бы повтор, сервер может уже использовать код.
    const replay = transport('yandex', 'code', { fetchImpl: fakeFetch }).instance;
    const again = await replay.send(original);
    expect(again.summary.scope).toBe('unverified');
    again.discard();
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('копия запроса и произвольный запрос не получают привязку, даже с теми же полями', async () => {
    const flow = await startCloudOAuth({
      provider: 'yandex',
      clientId: clients.yandex,
      port,
      invoke: async command => {
        if (command === 'cloud_oauth_callback_begin') return { port };
        if (command === 'cloud_oauth_callback_poll') return { status: 'code', code: fakeCode };
        if (command === 'cloud_oauth_callback_cancel') return null;
        throw new Error('unexpected');
      },
      openBrowser: async () => {},
      cryptoSource: webcrypto
    });
    expect(await flow.poll()).toEqual({ status: 'code_ready' });
    const body = JSON.parse(validJson('yandex'));
    delete body.scope;
    const fakeFetch = async () => response('yandex', JSON.stringify(body));
    const lease = await flow.exchange(request => {
      const copy = { ...request, headers: { ...request.headers } };
      return transport('yandex', 'code', { fetchImpl: fakeFetch }).instance.send(copy);
    });
    expect(lease.summary.scope).toBe('unverified');
    lease.discard();
    const arbitrary = await transport('yandex', 'code', { fetchImpl: fakeFetch }).instance.send(codeRequest('yandex'));
    expect(arbitrary.summary.scope).toBe('unverified');
    arbitrary.discard();
  });

  it('готовит refresh только Google, не выдаёт старый refresh за новый при его отсутствии', async () => {
    const request = createGoogleRefreshRequest({ clientId: clients.google, refreshToken: fakeRefresh });
    const fields = new URLSearchParams(request.body);
    expect([...fields.keys()]).toEqual(['grant_type', 'client_id', 'refresh_token']);
    expect(fields.get('grant_type')).toBe('refresh_token');
    expect(fields.get('refresh_token')).toBe(fakeRefresh);
    expect(fields.get('client_secret')).toBeNull();
    const body = JSON.parse(validJson('google'));
    delete body.refresh_token;
    const { instance } = transport('google', 'refresh', {
      fetchImpl: vi.fn(async () => response('google', JSON.stringify(body)))
    });
    const lease = await instance.send(request);
    expect(lease.summary).toMatchObject({ operation: 'refresh', refreshAvailable: false });
    expect(lease.takeSecrets()).toEqual({ accessToken: fakeAccess, refreshToken: null });
    await expect(instance.send(request)).rejects.toThrow('уже использована');
  });

  it('приходит новый refresh — возвращает именно его и не сохраняет самостоятельно', async () => {
    const request = createGoogleRefreshRequest({ clientId: clients.google, refreshToken: 'FAKE_OLD_REFRESH' });
    const { instance } = transport('google', 'refresh');
    const lease = await instance.send(request);
    expect(lease.summary.refreshAvailable).toBe(true);
    expect(lease.takeSecrets().refreshToken).toBe(fakeRefresh);
  });

  it('отслеживает отдельно заявленный срок refresh, не передавая истёкшие данные', async () => {
    let now = 1000;
    const { instance } = transport('google', 'code', {
      now: () => now,
      fetchImpl: async () => response('google', validJson('google', { refresh_token_expires_in: 2 }))
    });
    const lease = await instance.send(codeRequest('google'));
    expect(lease.summary.refreshExpiresAt).toBe(3000);
    now = 3000;
    expect(() => lease.takeSecrets()).toThrow('больше не доступны');
    const missing = JSON.parse(validJson('google', { refresh_token_expires_in: 5 }));
    delete missing.refresh_token;
    const noToken = transport('google', 'code', { fetchImpl: async () => response('google', JSON.stringify(missing)) });
    await expect(noToken.instance.send(codeRequest('google'))).rejects.toThrow('подтвердить');
  });

  it('не создаёт и не отправляет refresh Яндекса или client_secret до проверки политики', async () => {
    const fetchImpl = vi.fn();
    expect(() =>
      createCloudOAuthTokenTransport({ provider: 'yandex', clientId: clients.yandex, operation: 'refresh', fetchImpl })
    ).toThrow();
    const code = transport('yandex', 'code', { fetchImpl });
    const refresh = changedBody(codeRequest('yandex'), fields => {
      fields.delete('code');
      fields.delete('code_verifier');
      fields.set('grant_type', 'refresh_token');
      fields.set('refresh_token', fakeRefresh);
    });
    await expect(code.instance.send(refresh)).rejects.toThrow();
    await expect(
      code.instance.send(changedBody(codeRequest('yandex'), f => f.set('client_secret', 'FAKE_SECRET')))
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('отклоняет подмену endpoint, заголовков и параметров до отправки', async () => {
    const { instance, fetchImpl } = transport();
    const good = codeRequest('google');
    const wrong = [
      { ...good, method: 'GET' },
      { ...good, redirect: 'follow' },
      { ...good, url: 'https://oauth2.googleapis.com.evil.example/token' },
      { ...good, url: `${good.url}?access_token=SECRET` },
      { ...good, url: good.url.replace('https:', 'http:') },
      { ...good, headers: { ...good.headers, Authorization: 'Bearer FAKE' } },
      { ...good, headers: { ...good.headers, Accept: 'text/html' } },
      { ...good, body: good.body + '&code=another' },
      { ...good, body: good.body + '&client_secret=fake' },
      { ...good, body: good.body.replace('%2F', '%2f') },
      changedBody(good, f => f.set('client_id', 'other.apps.googleusercontent.com')),
      changedBody(good, f => f.set('code', 'with space')),
      changedBody(good, f => f.set('code_verifier', 'short')),
      changedBody(good, f => f.set('redirect_uri', 'http://localhost:37411/oauth/cloud/callback')),
      changedBody(good, f => f.set('redirect_uri', 'http://127.0.0.1:37411/other')),
      changedBody(good, f => f.set('redirect_uri', 'http://127.0.0.1:443/oauth/cloud/callback')),
      changedBody(good, f => f.set('redirect_uri', 'http://127.0.0.1:65536/oauth/cloud/callback')),
      changedBody(good, f => f.set('grant_type', 'refresh_token'))
    ];
    for (const request of wrong) await expect(instance.send(request)).rejects.toThrow('Некорректный запрос');
    expect(fetchImpl).not.toHaveBeenCalled();
    const lease = await instance.send(good);
    lease.discard();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('не запускает getter и использует снятый снимок запроса', async () => {
    const { instance, fetchImpl } = transport();
    const bad = codeRequest('google');
    const getter = vi.fn(() => bad.url);
    Object.defineProperty(bad, 'url', { enumerable: true, get: getter });
    await expect(instance.send(bad)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const good = codeRequest('google');
    const body = good.body;
    const pending = instance.send(good);
    good.body = 'FAKE_MODIFIED_SECRET';
    good.url = 'https://evil.example/';
    const lease = await pending;
    lease.discard();
    expect(fetchImpl.mock.calls[0][0]).toBe(OAUTH_PROVIDERS.google.token);
    expect(fetchImpl.mock.calls[0][1].body).toBe(body);
  });

  it('не включает детали сети, ошибки сервера, код или токены в ошибки', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`${fakeCode} ${fakeAccess} ${fakeRefresh}`);
    });
    const { instance } = transport('google', 'code', { fetchImpl });
    const message = await messageOf(instance.send(codeRequest('google')));
    expect(message).toContain('Не удалось подтвердить');
    for (const secret of [fakeCode, fakeAccess, fakeRefresh]) expect(message).not.toContain(secret);
    await expect(instance.send(codeRequest('google'))).rejects.toThrow('уже использована');
    const denied = transport('google', 'code', {
      fetchImpl: async () => response('google', `SERVER-${fakeAccess}`, { status: 401 })
    });
    const deniedMessage = await messageOf(denied.instance.send(codeRequest('google')));
    expect(deniedMessage).not.toContain(fakeAccess);
    expect(deniedMessage).not.toContain('SERVER');
  });

  it.each([
    'not json',
    '[]',
    '{"access_token":"FAKE","access_token":"DUPLICATE","token_type":"Bearer","expires_in":3600}',
    '{"access_token":"FAKE","acc\\u0065ss_token":"DUPLICATE","token_type":"Bearer","expires_in":3600}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":1,"expires_in":2}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":0}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":-1}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":1.2}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":1e3}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":9007199254740992}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":3600,"id_token":"UNREQUESTED"}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":3600,"scope":"another_scope"}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":3600,"scope":"https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive"}',
    '{"access_token":"FAKE","token_type":"MAC","expires_in":3600}',
    '{"access_token":"FAKE\\nINJECTED","token_type":"Bearer","expires_in":3600}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":3600,"refresh_token":""}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":3600,"refresh_token":null}',
    '{"access_token":"FAKE","token_type":"Bearer","expires_in":3600} trailing'
  ])('отклоняет неоднозначный или неподходящий JSON ответа: %#', async json => {
    const { instance } = transport('google', 'code', { fetchImpl: async () => response('google', json) });
    const message = await messageOf(instance.send(codeRequest('google')));
    expect(message).toContain('Не удалось подтвердить');
    expect(message).not.toContain('DUPLICATE');
    expect(message).not.toContain('UNREQUESTED');
  });

  it('ограничивает Content-Type, размеры, UTF-8, статус, url и редиректы', async () => {
    const variants = [
      response('google', validJson('google'), { headers: { 'Content-Type': 'text/html' } }),
      response('google', validJson('google'), { headers: { 'Content-Length': '65537' } }),
      response('google', validJson('google'), { headers: { 'Content-Length': '-1' } }),
      response('google', 'x'.repeat(65537)),
      response('google', Uint8Array.from([0xc3, 0x28])),
      response('google', validJson('google'), { status: 302 }),
      response('google', validJson('google'), { url: 'https://evil.example/token' }),
      response('google', validJson('google'), { redirected: true })
    ];
    for (const reply of variants) {
      const { instance } = transport('google', 'code', { fetchImpl: async () => reply });
      await expect(instance.send(codeRequest('google'))).rejects.toThrow('подтвердить');
    }
  });

  it('таймаут прерывает fetch и не позволяет повторить даже при игнорировании abort', async () => {
    let complete;
    let signal;
    const fetchImpl = vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise(resolve => {
        complete = resolve;
      });
    });
    const { instance } = transport('google', 'code', { fetchImpl, timeoutMs: 20 });
    await expect(instance.send(codeRequest('google'))).rejects.toThrow('подтвердить');
    expect(signal.aborted).toBe(true);
    await expect(instance.send(codeRequest('google'))).rejects.toThrow('уже использована');
    const lateReply = response('google');
    const cancel = vi.spyOn(lateReply.body, 'cancel');
    complete(lateReply);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('таймаут также пытается отменить зависшее чтение тела', async () => {
    const reader = {
      read: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn()
    };
    const reply = {
      status: 200,
      redirected: false,
      type: 'basic',
      url: OAUTH_PROVIDERS.google.token,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader: () => reader, cancel: vi.fn() }
    };
    const { instance } = transport('google', 'code', { fetchImpl: async () => reply, timeoutMs: 20 });
    await expect(instance.send(codeRequest('google'))).rejects.toThrow('подтвердить');
    expect(reader.cancel).toHaveBeenCalled();
  });

  it('запрещает параллельный повтор ещё до завершения первого POST', async () => {
    let finish;
    const fetchImpl = vi.fn(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const { instance } = transport('google', 'code', { fetchImpl });
    const pending = instance.send(codeRequest('google'));
    await expect(instance.send(codeRequest('google'))).rejects.toThrow('уже использована');
    finish(response('google'));
    const lease = await pending;
    lease.discard();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('не выдаёт данные, если срок токена истёк во время запроса или часы пошли назад', async () => {
    for (const end of [999, 5000]) {
      let now = 1000;
      const { instance } = transport('google', 'code', {
        now: () => now,
        fetchImpl: async () => {
          now = end;
          return response('google', validJson('google', { expires_in: 1 }));
        }
      });
      await expect(instance.send(codeRequest('google'))).rejects.toThrow('подтвердить');
    }
  });

  it('ограничивает время хранения ответа и учитывает сдвиг часов', async () => {
    vi.useFakeTimers();
    let now = 1000;
    const { instance } = transport('google', 'code', { now: () => now });
    const lease = await instance.send(codeRequest('google'));
    expect(JSON.stringify(lease)).not.toContain(fakeAccess);
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(() => lease.takeSecrets()).toThrow('больше не доступны');

    now = 1000;
    const second = transport('google', 'code', { now: () => now });
    const other = await second.instance.send(codeRequest('google'));
    now = 999;
    expect(() => other.takeSecrets()).toThrow('больше не доступны');
  });

  it('отклоняет невалидные параметры до получения чего-либо из сети', () => {
    const fetchImpl = vi.fn();
    for (const options of [
      { provider: 'other', clientId: clients.google, operation: 'code', fetchImpl },
      { provider: 'google', clientId: 'bad', operation: 'code', fetchImpl },
      { provider: 'google', clientId: clients.google, operation: 'other', fetchImpl },
      { provider: 'google', clientId: clients.google, operation: 'code', fetchImpl, timeoutMs: 1 },
      { provider: 'google', clientId: clients.google, operation: 'code' }
    ])
      expect(() => createCloudOAuthTokenTransport(options)).toThrow();
    expect(() => createGoogleRefreshRequest({ clientId: clients.google, refreshToken: 'a\r\nInjected: x' })).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
