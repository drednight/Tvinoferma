import { describe, expect, it, vi } from 'vitest';
import { createYandexAccountIdentityReader } from '../js/modules/cloudSync/providers/oauthAccountIdentity.js';

const URL = 'https://login.yandex.ru/info?format=json';
const clientId = '0123456789abcdef0123456789abcdef';
const token = 'FAKE_YANDEX_ACCESS_TOKEN';
const accountKey = '1.FAKE_CLIENT_SCOPED.ACCOUNT_123';
const login = 'PRIVATE_USER_LOGIN';
const userId = 'PRIVATE_USER_ID';

function response(body = JSON.stringify({ login, id: userId, client_id: clientId, psuid: accountKey }), options = {}) {
  const result = new Response(body, {
    status: options.status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(options.headers || {}) }
  });
  Object.defineProperty(result, 'url', { value: options.url ?? URL });
  if (options.redirected) Object.defineProperty(result, 'redirected', { value: true });
  return result;
}
function args(overrides = {}) {
  return { accessToken: token, clientId, signal: new AbortController().signal, ...overrides };
}
async function errorMessage(promise) {
  try {
    await promise;
    return 'unexpected success';
  } catch (error) {
    return String(error);
  }
}

describe('отключённое чтение идентификатора Яндекс ID', () => {
  it('запрашивает фиксированный адрес с OAuth в заголовке и возвращает только psuid', async () => {
    const fetchImpl = vi.fn(async () => response());
    const verify = createYandexAccountIdentityReader({ fetchImpl });
    const result = await verify(args());
    expect(result).toEqual({ accountKey });
    expect(Object.isFrozen(result)).toBe(true);
    for (const secret of [token, login, userId, clientId]) expect(JSON.stringify(result)).not.toContain(secret);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(URL);
    expect(url).not.toContain(token);
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
  });

  it('сверяет client_id и принимает произвольный порядок с отсутствующими ненужными login/id', async () => {
    const body = `{ "psuid":"${accountKey}", "client_\\u0069d":"${clientId}" }`;
    const verify = createYandexAccountIdentityReader({ fetchImpl: async () => response(body) });
    expect(await verify(args())).toEqual({ accountKey });
  });

  it.each([
    '{}',
    '[]',
    `{"client_id":"${clientId}"}`,
    `{"psuid":"${accountKey}"}`,
    `{"client_id":"another_client_id_123456","psuid":"${accountKey}"}`,
    `{"client_id":"${clientId}","psuid":""}`,
    `{"client_id":"${clientId}","psuid":"email@example.test"}`,
    `{"client_id":"${clientId}","psuid":"${accountKey}","client_id":"other"}`,
    `{"client_id":"${clientId}","client_\\u0069d":"${clientId}","psuid":"${accountKey}"}`,
    `{"client_id":"${clientId}","psuid":"${accountKey}","default_email":"PRIVATE_EMAIL"}`,
    `{"client_id":"${clientId}","psuid":"${accountKey}","login":null}`,
    `{"client_id":"${clientId}","psuid":"${accountKey}","id":123}`,
    `{"client_id":"${clientId}","psuid":"${accountKey}","id":"PRIVATE\\nVALUE"}`,
    `{"client_id":"${clientId}","psuid":"${accountKey}"} trailing`
  ])('отклоняет неоднозначный, неподходящий или расширенный ответ: %#', async body => {
    const verify = createYandexAccountIdentityReader({ fetchImpl: async () => response(body) });
    const message = await errorMessage(verify(args()));
    expect(message).toContain('Не удалось проверить');
    for (const secret of [token, accountKey, login, userId, 'PRIVATE_EMAIL']) expect(message).not.toContain(secret);
  });

  it('ограничивает статус, redirect, URL и размер без раскрытия исходного ответа', async () => {
    for (const reply of [
      response('PRIVATE', { status: 401 }),
      response(undefined, { redirected: true }),
      response(undefined, { url: 'https://evil.example/info' }),
      response(undefined, { headers: { 'Content-Length': '8193' } }),
      response('x'.repeat(8193))
    ]) {
      const verify = createYandexAccountIdentityReader({ fetchImpl: async () => reply });
      const message = await errorMessage(verify(args()));
      expect(message).toContain('Не удалось проверить');
      expect(message).not.toContain('PRIVATE');
    }
  });

  it('не отправляет токен при неправильном client ID, отменённом signal или неподходящем токене', async () => {
    const fetchImpl = vi.fn();
    const verify = createYandexAccountIdentityReader({ fetchImpl });
    const controller = new AbortController();
    controller.abort();
    for (const overrides of [
      { clientId: 'bad' },
      { accessToken: 'TOKEN\r\nInjected' },
      { signal: controller.signal }
    ]) {
      await expect(verify(args(overrides))).rejects.toThrow('Не удалось проверить');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('таймаут прерывает ожидание и не позволяет позднему ответу вернуть идентификатор', async () => {
    let finish;
    let signal;
    const fetchImpl = vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const verify = createYandexAccountIdentityReader({ fetchImpl, timeoutMs: 20 });
    await expect(verify(args())).rejects.toThrow('Не удалось проверить');
    expect(signal.aborted).toBe(true);
    const late = response();
    const cancel = vi.spyOn(late.body, 'cancel');
    finish(late);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
