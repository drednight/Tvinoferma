import { describe, expect, it, vi } from 'vitest';
import {
  createGoogleAccountIdentityReader,
  createGoogleAccountPreviewReader,
  createYandexAccountIdentityReader,
  createYandexAccountPreviewReader
} from '../js/modules/cloudSync/providers/oauthAccountIdentity.js';
import { copyOAuthAccountLabel } from '../js/modules/cloudSync/providers/oauthAccountLabel.js';

const GOOGLE_ID = 'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%29';
const GOOGLE_PREVIEW = 'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%2CemailAddress%29';
const YANDEX = 'https://login.yandex.ru/info?format=json';
const googleClient = '123456789-test_client.apps.googleusercontent.com';
const yandexClient = '0123456789abcdef0123456789abcdef';
const token = 'FAKE_PRIVATE_ACCESS_TOKEN';
const accountKey = 'FAKE_PRIVATE_ACCOUNT_KEY';
const email = 'fake_private+account@example.test';
const login = 'fake.private-login_123';

function reply(url, data, options = {}) {
  const response = new Response(typeof data === 'string' ? data : JSON.stringify(data), {
    status: options.status ?? 200,
    headers: { 'Content-Type': options.type ?? 'application/json', ...(options.headers ?? {}) }
  });
  Object.defineProperty(response, 'url', { value: options.url ?? url });
  if (options.redirected) Object.defineProperty(response, 'redirected', { value: true });
  return response;
}
function args(clientId, signal = new AbortController().signal) {
  return { accessToken: token, clientId, signal };
}
async function rejectPrivately(promise) {
  try {
    await promise;
    throw new Error('unexpected success');
  } catch (error) {
    expect(String(error)).toContain('Не удалось проверить');
    for (const secret of [token, accountKey, email, login, 'PRIVATE_RESPONSE'])
      expect(String(error)).not.toContain(secret);
  }
}

describe('отключённые readers для предпросмотра аккаунта', () => {
  it('Google получает ID и email вместе, не помещая токен в URL, и замораживает результат', async () => {
    const fetchImpl = vi.fn(async url => reply(url, { user: { emailAddress: email, permissionId: accountKey } }));
    const preview = createGoogleAccountPreviewReader({ fetchImpl });
    const result = await preview(args(googleClient));
    expect(result).toEqual({ accountKey, label: { kind: 'email', value: email } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.label)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(GOOGLE_PREVIEW);
    expect(new URL(url).searchParams.get('fields')).toBe('user(permissionId,emailAddress)');
    for (const secret of [token, accountKey, email]) expect(url).not.toContain(secret);
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(googleClient);
  });

  it('Яндекс сверяет client_id, возвращает login, но не подменяет его id или email', async () => {
    const fetchImpl = vi.fn(async url =>
      reply(url, { login, id: 'FAKE_PRIVATE_USER_ID', psuid: accountKey, client_id: yandexClient })
    );
    const preview = createYandexAccountPreviewReader({ fetchImpl });
    const result = await preview(args(yandexClient));
    expect(result).toEqual({ accountKey, label: { kind: 'login', value: login } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.label)).toBe(true);
    for (const secret of [token, yandexClient, 'FAKE_PRIVATE_USER_ID'])
      expect(JSON.stringify(result)).not.toContain(secret);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(YANDEX);
    expect(init.headers.Authorization).toBe(`OAuth ${token}`);
    expect(init).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
  });

  it('отсутствующую метку не заменяет идентификатором или предположением', async () => {
    const google = createGoogleAccountPreviewReader({
      fetchImpl: async url => reply(url, { user: { permissionId: accountKey } })
    });
    const yandex = createYandexAccountPreviewReader({
      fetchImpl: async url => reply(url, { id: 'PRIVATE_USER_ID', psuid: accountKey, client_id: yandexClient })
    });
    expect(await google(args(googleClient))).toEqual({ accountKey, label: null });
    expect(await yandex(args(yandexClient))).toEqual({ accountKey, label: null });
  });

  it('обычные readers по-прежнему возвращают только ID, без запроса email Google', async () => {
    const fetchImpl = vi.fn(async url => {
      if (url === GOOGLE_ID) return reply(url, { user: { permissionId: accountKey } });
      if (url === YANDEX) return reply(url, { client_id: yandexClient, psuid: accountKey, login });
      throw new Error('unexpected request');
    });
    const google = createGoogleAccountIdentityReader({ fetchImpl });
    const yandex = createYandexAccountIdentityReader({ fetchImpl });
    expect(await google(args(googleClient))).toEqual({ accountKey });
    expect(await yandex(args(yandexClient))).toEqual({ accountKey });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([GOOGLE_ID, YANDEX]);
  });

  it('принимает экранированные имена и значение из одного ответа', async () => {
    const preview = createGoogleAccountPreviewReader({
      fetchImpl: async url =>
        reply(url, `{"\\u0075ser":{"email\\u0041ddress":"${email}","permission\\u0049d":"${accountKey}"}}`)
    });
    expect(await preview(args(googleClient))).toEqual({ accountKey, label: { kind: 'email', value: email } });
  });

  it.each([
    '{}',
    '{"user":null}',
    '{"user":{"emailAddress":"fake@example.test"}}',
    `{"user":{"permissionId":"${accountKey}","emailAddress":null}}`,
    `{"user":{"permissionId":"${accountKey}","emailAddress":"${email}","email\\u0041ddress":"PRIVATE_RESPONSE"}}`,
    `{"user":{"permissionId":"${accountKey}","permission\\u0049d":"OTHER","emailAddress":"${email}"}}`,
    `{"user":{"permissionId":"${accountKey}","emailAddress":"${email}","displayName":"PRIVATE_RESPONSE"}}`,
    `{"user":{"permissionId":"${accountKey}"},"user":{"permissionId":"OTHER"}}`,
    `{"user":{"permissionId":"${accountKey}"}} trailing`
  ])('отклоняет неоднозначный или неподходящий Google JSON: %#', async body => {
    const preview = createGoogleAccountPreviewReader({ fetchImpl: async url => reply(url, body) });
    await rejectPrivately(preview(args(googleClient)));
  });

  it.each([
    '',
    'not-an-email',
    'fake@example',
    '.fake@example.test',
    'fake..user@example.test',
    'fake@-example.test',
    'fake@ex..test',
    'x'.repeat(65) + '@example.test',
    'fake@example.test\nattacker@example.test',
    'fake@example.test\u202eattacker',
    'fake\u200b@example.test',
    'кириллица@example.test',
    '<img src=x>@example.test'
  ])('не выдаёт опасный или неоднозначный email для показа: %#', async badEmail => {
    const preview = createGoogleAccountPreviewReader({
      fetchImpl: async url => reply(url, { user: { permissionId: accountKey, emailAddress: badEmail } })
    });
    await rejectPrivately(preview(args(googleClient)));
  });

  it.each([
    { login, psuid: accountKey, client_id: 'another_client_id_123456' },
    { login: null, psuid: accountKey, client_id: yandexClient },
    { login: '', psuid: accountKey, client_id: yandexClient },
    { login: 'user\nattacker', psuid: accountKey, client_id: yandexClient },
    { login: 'user\u202eattacker', psuid: accountKey, client_id: yandexClient },
    { login: 'кириллица', psuid: accountKey, client_id: yandexClient },
    { login: 'user@not-a-login.example', psuid: accountKey, client_id: yandexClient },
    { login: 'x'.repeat(129), psuid: accountKey, client_id: yandexClient },
    { login, psuid: accountKey, client_id: yandexClient, default_email: 'PRIVATE_RESPONSE' },
    `{"client_id":"${yandexClient}","psuid":"${accountKey}","login":"${login}","l\\u006fgin":"PRIVATE_RESPONSE"}`
  ])('не показывает неподходящий или неоднозначный ответ Яндекса: %#', async body => {
    const preview = createYandexAccountPreviewReader({ fetchImpl: async url => reply(url, body) });
    await rejectPrivately(preview(args(yandexClient)));
  });

  it('не возвращает метку при redirect, ошибке, неверном формате или превышении лимита', async () => {
    const replies = [
      reply(GOOGLE_PREVIEW, 'PRIVATE_RESPONSE', { status: 401 }),
      reply(GOOGLE_PREVIEW, 'PRIVATE_RESPONSE', { url: 'https://evil.example/' }),
      reply(GOOGLE_PREVIEW, 'PRIVATE_RESPONSE', { redirected: true }),
      reply(GOOGLE_PREVIEW, 'PRIVATE_RESPONSE', { type: 'text/html' }),
      reply(GOOGLE_PREVIEW, 'PRIVATE_RESPONSE', { headers: { 'Content-Length': '8193' } }),
      reply(GOOGLE_PREVIEW, 'x'.repeat(8193))
    ];
    for (const response of replies) {
      const preview = createGoogleAccountPreviewReader({ fetchImpl: async () => response });
      await rejectPrivately(preview(args(googleClient)));
    }
  });

  it('после отмены игнорирует поздний ответ с меткой и очищает исходную ошибку', async () => {
    let finish;
    let requestSignal;
    const fetchImpl = vi.fn((_url, init) => {
      requestSignal = init.signal;
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const preview = createGoogleAccountPreviewReader({ fetchImpl, timeoutMs: 1000 });
    const controller = new AbortController();
    const waiting = preview(args(googleClient, controller.signal));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();
    await rejectPrivately(waiting);
    expect(requestSignal.aborted).toBe(true);
    const late = reply(GOOGLE_PREVIEW, { user: { permissionId: accountKey, emailAddress: email } });
    const cancel = vi.spyOn(late.body, 'cancel');
    finish(late);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());

    const throwing = createYandexAccountPreviewReader({
      fetchImpl: async () => {
        throw new Error(`${token} ${accountKey} ${login} PRIVATE_RESPONSE`);
      }
    });
    await rejectPrivately(throwing(args(yandexClient)));
  });

  it('snapshot метки не исполняет getters и не принимает дополнительные поля', () => {
    const getter = vi.fn(() => email);
    const suspicious = { kind: 'email' };
    Object.defineProperty(suspicious, 'value', { enumerable: true, get: getter });
    expect(() => copyOAuthAccountLabel('google', suspicious)).toThrow('Не удалось безопасно показать');
    expect(getter).not.toHaveBeenCalled();
    expect(() => copyOAuthAccountLabel('google', { kind: 'email', value: email, extra: token })).toThrow();
    expect(copyOAuthAccountLabel('google', null)).toBeNull();
  });
});
