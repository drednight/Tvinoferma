import { describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pkceChallenge, startCloudOAuth } from '../js/modules/cloudSync/providers/oauthPkce.js';
import { OAUTH_CALLBACK_PATH, YANDEX_OAUTH_CALLBACK_PORT } from '../js/modules/cloudSync/providers/oauthCommon.js';

const googleClient = '123456789-test_client.apps.googleusercontent.com';
const yandexClient = '0123456789abcdef0123456789abcdef';
const port = 37181;
const secret = 'PRIVATE-AUTH-CODE';

function fakeNative(responses = []) {
  const calls = [];
  const invoke = vi.fn(async (command, args) => {
    calls.push({ command, args });
    if (command === 'cloud_oauth_callback_begin') return { port: args.port || port };
    if (command === 'cloud_oauth_callback_poll') return responses.length ? responses.shift() : { status: 'pending' };
    if (command === 'cloud_oauth_callback_cancel') return null;
    throw new Error('unexpected command');
  });
  return { invoke, calls };
}

function options(provider = 'google', extra = {}) {
  const native = fakeNative();
  const openBrowser = vi.fn(async () => {});
  return {
    input: {
      provider,
      clientId: provider === 'google' ? googleClient : yandexClient,
      ...(provider === 'yandex' ? { port } : {}),
      invoke: native.invoke,
      openBrowser,
      cryptoSource: webcrypto,
      ...extra
    },
    native,
    openBrowser
  };
}

const beginArgs = mock => mock.mock.calls.find(([command]) => command === 'cloud_oauth_callback_begin')[1];
const cancelCalls = mock => mock.mock.calls.filter(([command]) => command === 'cloud_oauth_callback_cancel');

describe('desktop OAuth PKCE: изолированная подготовка', () => {
  it('разрешает в CSP callback только неизменённый скрипт очистки адреса', () => {
    const source = readFileSync('src-tauri/src/cloud_oauth_callback.rs', 'utf8');
    const script = source.match(/const CLEAN_QUERY_SCRIPT: &str =\s*"([^"]+)";/)?.[1];
    const allowed = source.match(/const CLEAN_QUERY_SCRIPT_HASH: &str =\s*"([^"]+)";/)?.[1];
    expect(script).toBe("try{history.replaceState(null,'','/oauth/cloud/complete')}catch{}");
    expect(allowed).toBe(`sha256-${createHash('sha256').update(script).digest('base64')}`);
    expect(source).toContain("script-src '{CLEAN_QUERY_SCRIPT_HASH}'");
    expect(source).not.toContain("'unsafe-inline'");
  });

  it('вычисляет опубликованный контрольный вектор RFC 7636 S256', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await pkceChallenge(verifier, webcrypto)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    await expect(pkceChallenge('short', webcrypto)).rejects.toThrow();
    await expect(pkceChallenge('x'.repeat(129), webcrypto)).rejects.toThrow();
  });

  it.each(['google', 'yandex'])(
    '%s связывает браузер, callback и одноразовый код без секрета приложения',
    async provider => {
      const { input, native, openBrowser } = options(provider);
      native.invoke.mockImplementation(async (command, args) => {
        if (command === 'cloud_oauth_callback_begin') return { port: args.port || port };
        if (command === 'cloud_oauth_callback_poll') return { status: 'code', code: `${secret}/+` };
        if (command === 'cloud_oauth_callback_cancel') return null;
        throw new Error('unexpected command');
      });
      const flow = await startCloudOAuth(input);
      const start = beginArgs(native.invoke);
      expect(start.provider).toBe(provider);
      expect(start.port).toBe(provider === 'google' ? 0 : port);
      expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(start.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(start.state).not.toBe(start.handle);
      expect(openBrowser).toHaveBeenCalledTimes(1);
      const auth = new URL(openBrowser.mock.calls[0][0]);
      expect(auth.origin).toBe(provider === 'google' ? 'https://accounts.google.com' : 'https://oauth.yandex.com');
      expect(auth.pathname).toBe(provider === 'google' ? '/o/oauth2/v2/auth' : '/authorize');
      expect(auth.searchParams.get('client_id')).toBe(input.clientId);
      expect(auth.searchParams.get('response_type')).toBe('code');
      expect(auth.searchParams.get('scope')).toBe(
        provider === 'google' ? 'https://www.googleapis.com/auth/drive.file' : 'cloud_api:disk.app_folder'
      );
      expect(auth.searchParams.get('state')).toBe(start.state);
      expect(auth.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/oauth/cloud/callback`);
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
      expect(auth.searchParams.get('access_type')).toBe(provider === 'google' ? 'offline' : null);
      expect(auth.toString()).not.toContain(start.handle);
      expect(auth.searchParams.has('code_verifier')).toBe(false);
      expect(auth.searchParams.has('client_secret')).toBe(false);

      const status = await flow.poll();
      expect(status).toEqual({ status: 'code_ready' });
      expect(JSON.stringify(status)).not.toContain(secret);
      const transport = vi.fn(async request => ({ result: 'FAKE-RESPONSE', request }));
      const answer = await flow.exchange(transport);
      const token = answer.request;
      expect(token.url).toBe(
        provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://oauth.yandex.com/token'
      );
      expect(token.method).toBe('POST');
      expect(token.redirect).toBe('error');
      const body = new URLSearchParams(token.body);
      expect(body.get('client_id')).toBe(input.clientId);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe(`${secret}/+`);
      expect(body.get('client_secret')).toBeNull();
      expect(body.get('redirect_uri')).toBe(provider === 'google' ? auth.searchParams.get('redirect_uri') : null);
      const verifier = body.get('code_verifier');
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(verifier).not.toBe(start.state);
      expect(verifier).not.toBe(start.handle);
      expect(await pkceChallenge(verifier, webcrypto)).toBe(auth.searchParams.get('code_challenge'));
      expect(auth.toString()).not.toContain(verifier);
      expect(Object.isFrozen(token)).toBe(true);
      expect(Object.isFrozen(token.headers)).toBe(true);
      await expect(flow.exchange(transport)).rejects.toThrow();
      expect(await flow.poll()).toEqual({ status: 'consumed' });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  );

  it('диагностика Google не запрашивает offline refresh, другие попытки не меняют прежний режим', async () => {
    const s = options('google', { requestOffline: false });
    const flow = await startCloudOAuth(s.input);
    expect(new URL(s.openBrowser.mock.calls[0][0]).searchParams.get('access_type')).toBeNull();
    expect(await flow.cancel()).toEqual({ status: 'cancelled' });
    const invalid = options('google', { requestOffline: 'false' });
    await expect(startCloudOAuth(invalid.input)).rejects.toThrow();
    expect(invalid.openBrowser).not.toHaveBeenCalled();
    expect(invalid.native.invoke).not.toHaveBeenCalled();
  });

  it('повторное согласие запрашивается только явно для offline Google', async () => {
    const allowed = options('google', { requestOffline: true, forceConsent: true });
    const flow = await startCloudOAuth(allowed.input);
    const url = new URL(allowed.openBrowser.mock.calls[0][0]);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    await flow.cancel();
    for (const [provider, extra] of [
      ['google', { requestOffline: false, forceConsent: true }],
      ['google', { forceConsent: 'true' }],
      ['yandex', { forceConsent: true }]
    ]) {
      const s = options(provider, extra);
      await expect(startCloudOAuth(s.input)).rejects.toThrow();
      expect(s.native.invoke).not.toHaveBeenCalled();
      expect(s.openBrowser).not.toHaveBeenCalled();
    }
  });

  it('использует заранее согласованный тестовый redirect Яндекса по умолчанию', async () => {
    const { input, native, openBrowser } = options('yandex');
    delete input.port;
    const flow = await startCloudOAuth(input);
    const start = beginArgs(native.invoke);
    expect(YANDEX_OAUTH_CALLBACK_PORT).toBe(37181);
    expect(start.port).toBe(YANDEX_OAUTH_CALLBACK_PORT);
    expect(new URL(openBrowser.mock.calls[0][0]).searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${YANDEX_OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`
    );
    expect(await flow.cancel()).toEqual({ status: 'cancelled' });
  });

  it('пока ожидает, сообщает статус; отмена не оставляет возможности использовать код', async () => {
    const { input, native } = options();
    const flow = await startCloudOAuth(input);
    expect(await flow.poll()).toEqual({ status: 'pending' });
    expect(await flow.cancel()).toEqual({ status: 'cancelled' });
    expect(cancelCalls(native.invoke)).toHaveLength(1);
    expect(await flow.poll()).toEqual({ status: 'cancelled' });
    const transport = vi.fn();
    await expect(flow.exchange(transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['denied', 'expired', 'error', 'cancelled', 'consumed'])(
    'нормализует завершение %s и не возвращает код',
    async status => {
      const native = fakeNative([{ status }]);
      const { input } = options('google', { invoke: native.invoke });
      const flow = await startCloudOAuth(input);
      expect(await flow.poll()).toEqual({ status: status === 'consumed' ? 'error' : status });
      await expect(flow.exchange(vi.fn())).rejects.toThrow();
    }
  );

  it.each([
    null,
    {},
    { status: 'code' },
    { status: 'code', code: '' },
    { status: 'code', code: 'contains space' },
    { status: 'code', code: 'x'.repeat(2049) },
    { status: 'pending', code: secret },
    { status: 'code', code: secret, url: 'PRIVATE-CALLBACK' },
    { status: 'fake' }
  ])('отклоняет повреждённый или лишний ответ callback без утечки: %#', async reply => {
    const native = fakeNative([reply]);
    const { input } = options('google', { invoke: native.invoke });
    const flow = await startCloudOAuth(input);
    let error;
    try {
      await flow.poll();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('PRIVATE-CALLBACK');
    expect(await flow.poll()).toEqual({ status: 'error' });
    expect(cancelCalls(native.invoke)).toHaveLength(1);
  });

  it('не вызывает getter в ответе и не раскрывает ошибку IPC', async () => {
    const native = fakeNative();
    const getter = vi.fn(() => secret);
    native.invoke.mockImplementation(async command => {
      if (command === 'cloud_oauth_callback_begin') return { port };
      if (command === 'cloud_oauth_callback_poll')
        return {
          status: 'code',
          get code() {
            return getter();
          }
        };
      if (command === 'cloud_oauth_callback_cancel') throw new Error(secret);
    });
    const { input } = options('google', { invoke: native.invoke });
    const flow = await startCloudOAuth(input);
    await expect(flow.poll()).rejects.toThrow('Не удалось безопасно проверить ответ');
    expect(getter).not.toHaveBeenCalled();
    expect(await flow.poll()).toEqual({ status: 'error' });
  });

  it('не запускает браузер при подмене адреса/порта и пытается закрыть приёмник', async () => {
    const native = fakeNative();
    native.invoke.mockImplementation(async command => {
      if (command === 'cloud_oauth_callback_begin') return { port: port + 1 };
      if (command === 'cloud_oauth_callback_cancel') return null;
    });
    const { input, openBrowser } = options('yandex', { invoke: native.invoke });
    await expect(startCloudOAuth(input)).rejects.toThrow('Не удалось подготовить');
    expect(openBrowser).not.toHaveBeenCalled();
    expect(cancelCalls(native.invoke)).toHaveLength(1);
  });

  it('при неизвестном результате начала и ошибке браузера пытается отменить callback, не выдавая детали', async () => {
    for (const stage of ['begin', 'browser']) {
      const native = fakeNative();
      native.invoke.mockImplementation(async command => {
        if (command === 'cloud_oauth_callback_begin') {
          if (stage === 'begin') throw new Error(secret);
          return { port };
        }
        if (command === 'cloud_oauth_callback_cancel') throw new Error(secret);
      });
      const openBrowser = vi.fn(async () => {
        if (stage === 'browser') throw new Error(secret);
      });
      const { input } = options('google', { invoke: native.invoke, openBrowser });
      let error;
      try {
        await startCloudOAuth(input);
      } catch (caught) {
        error = caught;
      }
      expect(error.message).not.toContain(secret);
      expect(cancelCalls(native.invoke)).toHaveLength(1);
      expect(openBrowser).toHaveBeenCalledTimes(stage === 'browser' ? 1 : 0);
    }
  });

  it('проигнорирует код, если отмена произошла во время асинхронного опроса', async () => {
    let resolvePoll;
    const native = fakeNative();
    native.invoke.mockImplementation(async command => {
      if (command === 'cloud_oauth_callback_begin') return { port };
      if (command === 'cloud_oauth_callback_poll')
        return await new Promise(resolve => {
          resolvePoll = resolve;
        });
      if (command === 'cloud_oauth_callback_cancel') return null;
    });
    const { input } = options('google', { invoke: native.invoke });
    const flow = await startCloudOAuth(input);
    const poll = flow.poll();
    await expect(flow.poll()).rejects.toThrow('уже выполняется');
    expect(await flow.cancel()).toEqual({ status: 'cancelled' });
    resolvePoll({ status: 'code', code: secret });
    expect(await poll).toEqual({ status: 'cancelled' });
    const transport = vi.fn();
    await expect(flow.exchange(transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('останавливает использование кода даже при неподтверждённой отмене', async () => {
    const native = fakeNative([{ status: 'code', code: secret }]);
    const base = native.invoke.getMockImplementation();
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'cloud_oauth_callback_cancel') throw new Error(secret);
      return base(command, args);
    });
    const { input } = options('google', { invoke: native.invoke });
    const flow = await startCloudOAuth(input);
    expect(await flow.poll()).toEqual({ status: 'code_ready' });
    await expect(flow.cancel()).rejects.toThrow('не подтверждена');
    expect(await flow.poll()).toEqual({ status: 'cancelled' });
    await expect(flow.exchange(vi.fn())).rejects.toThrow();
  });

  it('после неоднозначной ошибки обмена не повторяет код и не раскрывает исходную ошибку', async () => {
    const native = fakeNative([{ status: 'code', code: secret }]);
    const { input } = options('google', { invoke: native.invoke });
    const flow = await startCloudOAuth(input);
    await flow.poll();
    const transport = vi.fn(async () => {
      throw new Error(secret);
    });
    let error;
    try {
      await flow.exchange(transport);
    } catch (caught) {
      error = caught;
    }
    expect(error.message).toContain('не подтверждён');
    expect(error.message).not.toContain(secret);
    expect(await flow.poll()).toEqual({ status: 'error' });
    await expect(flow.exchange(transport)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('не обещает остановить уже начавшийся обмен', async () => {
    const native = fakeNative([{ status: 'code', code: secret }]);
    const { input } = options('google', { invoke: native.invoke });
    const flow = await startCloudOAuth(input);
    await flow.poll();
    let release;
    const exchange = flow.exchange(
      async () =>
        await new Promise(resolve => {
          release = resolve;
        })
    );
    await expect(flow.cancel()).rejects.toThrow('уже начался');
    release('fake');
    expect(await exchange).toBe('fake');
    expect(await flow.poll()).toEqual({ status: 'consumed' });
  });

  it('истекает от начала попытки и отменяет локальное ожидание даже с полученным кодом', async () => {
    let time = 10_000;
    const native = fakeNative([{ status: 'code', code: secret }]);
    const { input } = options('google', { invoke: native.invoke, now: () => time });
    const flow = await startCloudOAuth(input);
    await flow.poll();
    time += 5 * 60 * 1000;
    expect(await flow.poll()).toEqual({ status: 'expired' });
    await expect(flow.exchange(vi.fn())).rejects.toThrow();
    expect(cancelCalls(native.invoke)).toHaveLength(1);
  });

  it('обратный ход часов или сбой часов также останавливает попытку', async () => {
    for (const failure of ['backwards', 'throws']) {
      let time = 1000;
      const { input, native } = options('google', {
        now: () => {
          if (time === null) throw new Error(secret);
          return time;
        }
      });
      const flow = await startCloudOAuth(input);
      time = failure === 'backwards' ? 999 : null;
      expect(await flow.poll()).toEqual({ status: 'expired' });
      expect(cancelCalls(native.invoke)).toHaveLength(1);
    }
  });

  it('учитывает время открытия браузера в общем сроке ожидания', async () => {
    vi.useFakeTimers();
    try {
      let time = 1000;
      const { input, native } = options('google', {
        now: () => time,
        openBrowser: async () => {
          time += 4 * 60 * 1000;
        }
      });
      const flow = await startCloudOAuth(input);
      await vi.advanceTimersByTimeAsync(60 * 1000 - 1);
      expect(cancelCalls(native.invoke)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(cancelCalls(native.invoke)).toHaveLength(1);
      expect(await flow.poll()).toEqual({ status: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('отменяет приёмник, если открытие браузера вернулось после истечения срока', async () => {
    let time = 1000;
    const { input, native } = options('google', {
      now: () => time,
      openBrowser: async () => {
        time += 5 * 60 * 1000;
      }
    });
    await expect(startCloudOAuth(input)).rejects.toThrow('Не удалось подготовить');
    expect(cancelCalls(native.invoke)).toHaveLength(1);
  });

  it('сама очищает попытку по таймеру, даже если её больше не опрашивают', async () => {
    vi.useFakeTimers();
    try {
      const { input, native } = options();
      const flow = await startCloudOAuth(input);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(cancelCalls(native.invoke)).toHaveLength(1);
      expect(await flow.poll()).toEqual({ status: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('не принимает неизвестного провайдера, недопустимые client ID, порт или повтор случайных данных', async () => {
    const { input, native, openBrowser } = options();
    for (const override of [
      { provider: 'third-party' },
      { clientId: 'bad?access_token=secret' },
      { port: 8080 },
      { provider: 'yandex', clientId: yandexClient, port: 0 },
      { provider: 'yandex', clientId: yandexClient, port: 1023 },
      { provider: 'yandex', clientId: yandexClient, port: 65536 },
      { cryptoSource: { getRandomValues: bytes => bytes, subtle: webcrypto.subtle } }
    ]) {
      await expect(startCloudOAuth({ ...input, ...override })).rejects.toThrow();
    }
    expect(native.invoke).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });
});
