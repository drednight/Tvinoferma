import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  createGoogleEnrollmentAttempt,
  createYandexEnrollmentAttempt
} from '../js/modules/cloudSync/providers/oauthCredentialEnrollment.js';
import {
  parseYandexCredentialRecord,
  prepareYandexCredentialRecord,
  serializeYandexCredentialRecord
} from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';
import { createYandexAccountPreviewReader } from '../js/modules/cloudSync/providers/oauthAccountIdentity.js';
import { createCloudOAuthTokenTransport } from '../js/modules/cloudSync/providers/oauthTokenTransport.js';
import { startCloudOAuth } from '../js/modules/cloudSync/providers/oauthPkce.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const clientId = '0123456789abcdef0123456789abcdef';
const googleClientId = '123456789-test_client.apps.googleusercontent.com';
const accountKey = 'FAKE_PRIVATE_YANDEX_ACCOUNT_123';
const access = 'FAKE_PRIVATE_ACCESS_123';
const refresh = 'FAKE_PRIVATE_REFRESH:456';
const login = 'fake.private-login_123';
const label = Object.freeze({ kind: 'login', value: login });
const slotId = 'a1234567-1234-4abc-8def-123456789abc';
const revision = 'b1234567-1234-4abc-8def-123456789abc';

function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fakeLease(summaryChanges = {}, secretChanges = {}) {
  let spent = false;
  return Object.freeze({
    summary: Object.freeze({
      provider: 'yandex',
      operation: 'code',
      expiresAt: 3_700_000,
      refreshExpiresAt: null,
      refreshAvailable: true,
      scope: 'reported',
      ...summaryChanges
    }),
    takeSecrets: vi.fn(() => {
      if (spent) throw new Error('PRIVATE_SPENT');
      spent = true;
      return Object.freeze({ accessToken: access, refreshToken: refresh, ...secretChanges });
    }),
    discard: vi.fn(() => {
      spent = true;
    })
  });
}

function setup(extra = {}) {
  const clock = extra.clock || { value: 100_000 };
  const tokenResponse = extra.tokenResponse || fakeLease();
  const previewAccount = extra.previewAccount || vi.fn(async () => ({ accountKey, label }));
  const confirmAccount = extra.confirmAccount || vi.fn(async () => true);
  const installer = extra.installer || {
    installIfAbsent: vi.fn(async () => 'installed'),
    verifyInstallation: vi.fn(async () => true)
  };
  const options = {
    clientId,
    tokenResponse,
    previewAccount,
    confirmAccount,
    installer,
    cryptoSource: webcrypto,
    now: () => clock.value,
    identityTimeoutMs: 1000,
    confirmationTimeoutMs: 1000,
    installationTimeoutMs: 1000,
    ...(extra.options || {})
  };
  return {
    clock,
    tokenResponse,
    previewAccount,
    confirmAccount,
    installer,
    options,
    attempt: createYandexEnrollmentAttempt(options)
  };
}

function noPrivate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [access, refresh, accountKey, login, 'PRIVATE_ERROR']) expect(text).not.toContain(secret);
}

function recordOptions(changes = {}) {
  return { slotId, clientId, accountKey, revision, accessToken: access, expiresAt: 3_700_000, ...changes };
}

function fakeResponse(url, data) {
  const response = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('Яндекс: отключённое первое подключение и запись access token', () => {
  it.each(['reported', 'request_bound'])('при %s проверяет аккаунт дважды и не сохраняет refresh', async scope => {
    const { attempt, tokenResponse, previewAccount, confirmAccount, installer } = setup({
      tokenResponse: fakeLease({ scope })
    });
    previewAccount.mockImplementation(async args => {
      expect(args).toMatchObject({ clientId, accessToken: access });
      expect(args.signal).toBeInstanceOf(AbortSignal);
      expect(installer.installIfAbsent).not.toHaveBeenCalled();
      return { accountKey, label };
    });
    confirmAccount.mockImplementation(async args => {
      expect(args).toMatchObject({ provider: 'yandex', clientId, label });
      expect(args.signal).toBeInstanceOf(AbortSignal);
      expect(Object.isFrozen(args.label)).toBe(true);
      for (const secret of [access, refresh, accountKey]) expect(JSON.stringify(args)).not.toContain(secret);
      expect(installer.installIfAbsent).not.toHaveBeenCalled();
      return true;
    });
    const result = await attempt.complete();
    expect(result).toEqual({ status: 'installed' });
    noPrivate(result);
    expect(tokenResponse.takeSecrets).toHaveBeenCalledOnce();
    expect(previewAccount).toHaveBeenCalledTimes(2);
    expect(confirmAccount).toHaveBeenCalledOnce();
    expect(installer.installIfAbsent).toHaveBeenCalledOnce();
    expect(installer.verifyInstallation).toHaveBeenCalledOnce();
    const installed = installer.installIfAbsent.mock.calls[0][0];
    const record = parseYandexCredentialRecord(installed.record);
    expect(installed.accountKey).toBe(accountKey);
    expect(record).toMatchObject({ clientId, accountKey, accessToken: access, expiresAt: 3_700_000 });
    expect(record.slotId).toBe(installed.slotId);
    expect(record.revision).not.toBe(installed.slotId);
    expect(installed.record).not.toContain(refresh);
    expect(installed.record).not.toContain(login);
    expect(installed.record).not.toContain('refreshToken');
    expect(await attempt.complete()).toEqual({ status: 'spent' });
  });

  it('работает без выданного refresh, который сейчас нельзя безопасно использовать', async () => {
    const tokenResponse = fakeLease({ refreshAvailable: false }, { refreshToken: null });
    const { attempt, installer } = setup({ tokenResponse });
    expect(await attempt.complete()).toEqual({ status: 'installed' });
    const record = installer.installIfAbsent.mock.calls[0][0].record;
    expect(parseYandexCredentialRecord(record).accessToken).toBe(access);
    expect(record).not.toContain('refresh');
  });

  it('непроверенное право отбрасывает до чтения токена и до обращения к аккаунту', async () => {
    const tokenResponse = fakeLease({ scope: 'unverified' });
    const { attempt, previewAccount, confirmAccount, installer } = setup({ tokenResponse });
    expect(await attempt.complete()).toEqual({ status: 'scope_unverified' });
    expect(tokenResponse.discard).toHaveBeenCalledOnce();
    expect(tokenResponse.takeSecrets).not.toHaveBeenCalled();
    expect(previewAccount).not.toHaveBeenCalled();
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('не принимает привязку scope Яндекса для Google и неправильный тип результата', () => {
    const normal = setup().options;
    expect(() =>
      createGoogleEnrollmentAttempt({
        ...normal,
        clientId: googleClientId,
        tokenResponse: fakeLease({ provider: 'google', scope: 'request_bound' })
      })
    ).toThrow();
    for (const summary of [
      { provider: 'google' },
      { operation: 'refresh' },
      { refreshExpiresAt: 999_999 },
      { scope: 'unrecognised' },
      { expiresAt: -1 }
    ])
      expect(() => createYandexEnrollmentAttempt({ ...normal, tokenResponse: fakeLease(summary) })).toThrow();
  });

  it.each([
    [{}, { accessToken: 'BAD\r\nPRIVATE_ERROR' }],
    [{}, { accessToken: '' }],
    [{}, { accessToken: 'x'.repeat(8193) }],
    [{ expiresAt: 100_000 }, {}],
    [{ refreshAvailable: false }, { refreshToken: refresh }],
    [{ refreshAvailable: true }, { refreshToken: null }]
  ])('не использует просроченный или некорректный ответ: %#', async (summary, secrets) => {
    const { attempt, installer, previewAccount } = setup({ tokenResponse: fakeLease(summary, secrets) });
    const output = await attempt.complete();
    expect(output).toEqual({ status: 'token_unavailable' });
    noPrivate(output);
    expect(previewAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('при отсутствии логина не предлагает подтверждать неизвестный аккаунт', async () => {
    const { attempt, confirmAccount, installer } = setup({ previewAccount: async () => ({ accountKey, label: null }) });
    expect(await attempt.complete()).toEqual({ status: 'account_label_unavailable' });
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'email', value: 'fake@example.test' },
    { kind: 'login', value: 'fake\u202eevil' },
    { kind: 'login', value: '<script>' },
    { kind: 'login', value: 'fake\nother' },
    { kind: 'login', value: login, extra: 'PRIVATE_ERROR' }
  ])('не показывает неподходящую метку: %#', async badLabel => {
    const { attempt, confirmAccount, installer } = setup({
      previewAccount: async () => ({ accountKey, label: badLabel })
    });
    expect(await attempt.complete()).toEqual({ status: 'identity_unverified' });
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it.each([
    [{ accountKey: 'DIFFERENT_ACCOUNT', label }, 'account_changed'],
    [{ accountKey, label: { kind: 'login', value: 'other-login' } }, 'account_changed'],
    [{ accountKey, label: null }, 'account_changed']
  ])('повторная проверка перед установкой обнаруживает изменение: %#', async (next, status) => {
    const previewAccount = vi.fn().mockResolvedValueOnce({ accountKey, label }).mockResolvedValueOnce(next);
    const { attempt, installer } = setup({ previewAccount });
    expect(await attempt.complete()).toEqual({ status });
    expect(previewAccount).toHaveBeenCalledTimes(2);
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'declined'],
    [null, 'confirmation_unverified'],
    ['yes', 'confirmation_unverified']
  ])('отказ или неопределённое подтверждение не записывает токен: %#', async (answer, status) => {
    const { attempt, previewAccount, installer } = setup({ confirmAccount: async () => answer });
    expect(await attempt.complete()).toEqual({ status });
    expect(previewAccount).toHaveBeenCalledOnce();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('отмена до начала отбрасывает секреты и не запускает работу', async () => {
    const { attempt, tokenResponse, previewAccount } = setup();
    expect(attempt.cancel()).toEqual({ status: 'cancelled' });
    expect(await attempt.complete()).toEqual({ status: 'cancelled' });
    expect(tokenResponse.discard).toHaveBeenCalledOnce();
    expect(tokenResponse.takeSecrets).not.toHaveBeenCalled();
    expect(previewAccount).not.toHaveBeenCalled();
  });

  it('отмена и параллельный вызов при подтверждении не запускают установку', async () => {
    const started = deferred();
    const late = deferred();
    let signal;
    const { attempt, installer } = setup({
      confirmAccount: args => {
        signal = args.signal;
        started.resolve();
        return late.promise;
      }
    });
    const running = attempt.complete();
    await started.promise;
    expect(await attempt.complete()).toEqual({ status: 'busy' });
    expect(attempt.cancel()).toEqual({ status: 'cancelled' });
    expect(signal.aborted).toBe(true);
    expect(await running).toEqual({ status: 'cancelled' });
    late.resolve(true);
    await Promise.resolve();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
    expect(await attempt.complete()).toEqual({ status: 'cancelled' });
  });

  it('таймаут подтверждения игнорирует поздний ответ', async () => {
    const late = deferred();
    let signal;
    const { attempt, installer } = setup({
      confirmAccount: args => {
        signal = args.signal;
        return late.promise;
      },
      options: { confirmationTimeoutMs: 20 }
    });
    expect(await attempt.complete()).toEqual({ status: 'confirmation_unverified' });
    expect(signal.aborted).toBe(true);
    late.resolve(true);
    await Promise.resolve();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('задержка до установки и обратный ход часов блокируют запись', async () => {
    const forward = { value: 100_000 };
    const first = setup({
      clock: forward,
      confirmAccount: async () => {
        forward.value += 60_001;
        return true;
      }
    });
    expect(await first.attempt.complete()).toEqual({ status: 'confirmation_unverified' });
    expect(first.installer.installIfAbsent).not.toHaveBeenCalled();
    const backward = { value: 100_000 };
    const second = setup({
      clock: backward,
      confirmAccount: async () => {
        backward.value -= 1;
        return true;
      }
    });
    expect(await second.attempt.complete()).toEqual({ status: 'confirmation_unverified' });
    expect(second.installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('занятая установка и ошибки записи не выдаются за подключение и не повторяются', async () => {
    for (const [outcome, expected] of [
      ['occupied', 'already_configured'],
      ['bad-reply', 'installation_uncertain'],
      [new Error(`PRIVATE_ERROR ${access}`), 'installation_uncertain']
    ]) {
      const installer = {
        installIfAbsent: vi.fn(async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        }),
        verifyInstallation: vi.fn(async () => true)
      };
      const { attempt } = setup({ installer });
      const result = await attempt.complete();
      expect(result).toEqual({ status: expected });
      noPrivate(result);
      expect(installer.verifyInstallation).not.toHaveBeenCalled();
      expect(await attempt.complete()).toEqual({ status: 'spent' });
      expect(installer.installIfAbsent).toHaveBeenCalledOnce();
    }
  });

  it('таймаут установки и неподтверждённое чтение оставляют неизвестный исход', async () => {
    const pending = deferred();
    const installer = { installIfAbsent: vi.fn(() => pending.promise), verifyInstallation: vi.fn(async () => true) };
    const { attempt } = setup({ installer, options: { installationTimeoutMs: 20 } });
    expect(await attempt.complete()).toEqual({ status: 'installation_uncertain' });
    pending.resolve('installed');
    await Promise.resolve();
    expect(installer.verifyInstallation).not.toHaveBeenCalled();
    expect(await attempt.complete()).toEqual({ status: 'spent' });
    const second = setup({
      installer: { installIfAbsent: vi.fn(async () => 'installed'), verifyInstallation: vi.fn(async () => false) }
    });
    expect(await second.attempt.complete()).toEqual({ status: 'installation_uncertain' });
  });

  it('истечение access token во время установки сообщается отдельно, а не как успех', async () => {
    const clock = { value: 100_000 };
    const installer = {
      installIfAbsent: vi.fn(async () => 'installed'),
      verifyInstallation: vi.fn(async () => {
        clock.value = 100_010;
        return true;
      })
    };
    const { attempt } = setup({ clock, installer, tokenResponse: fakeLease({ expiresAt: 100_010 }) });
    expect(await attempt.complete()).toEqual({ status: 'installed_access_expired' });
    expect(installer.installIfAbsent).toHaveBeenCalledOnce();
    expect(await attempt.complete()).toEqual({ status: 'spent' });
  });

  it('на поддельных IPC и API соединяет PKCE, отсутствие scope, аккаунт и проверку установки', async () => {
    const clock = () => 100_000;
    let opened;
    const flow = await startCloudOAuth({
      provider: 'yandex',
      clientId,
      invoke: async command => {
        if (command === 'cloud_oauth_callback_begin') return { port: 37181 };
        if (command === 'cloud_oauth_callback_poll') return { status: 'code', code: 'FAKE_CODE' };
        if (command === 'cloud_oauth_callback_cancel') return null;
        throw new Error('PRIVATE_ERROR');
      },
      openBrowser: async url => {
        opened = new URL(url);
      },
      cryptoSource: webcrypto,
      now: clock
    });
    expect(opened.searchParams.get('scope')).toBe(OAUTH_PROVIDERS.yandex.scope);
    expect(opened.searchParams.has('optional_scope')).toBe(false);
    expect(await flow.poll()).toEqual({ status: 'code_ready' });
    const fetchImpl = vi.fn(async url => {
      if (url === OAUTH_PROVIDERS.yandex.token) {
        // Официальный вариант без scope: остальные данные только вымышленные.
        return fakeResponse(url, {
          access_token: access,
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: refresh
        });
      }
      if (url === 'https://login.yandex.ru/info?format=json') {
        return fakeResponse(url, { login, id: 'FAKE_PRIVATE_ID', client_id: clientId, psuid: accountKey });
      }
      throw new Error('unexpected');
    });
    const transport = createCloudOAuthTokenTransport({
      provider: 'yandex',
      clientId,
      operation: 'code',
      fetchImpl,
      now: clock
    });
    const tokenResponse = await flow.exchange(transport.send);
    expect(tokenResponse.summary.scope).toBe('request_bound');
    const confirmAccount = vi.fn(async ({ provider, label: shown }) => {
      expect(provider).toBe('yandex');
      expect(shown).toEqual(label);
      return true;
    });
    let installed = null;
    const installer = {
      installIfAbsent: vi.fn(async value => {
        if (installed) return 'occupied';
        installed = value;
        return 'installed';
      }),
      verifyInstallation: vi.fn(async value => installed === value)
    };
    const attempt = createYandexEnrollmentAttempt({
      clientId,
      tokenResponse,
      previewAccount: createYandexAccountPreviewReader({ fetchImpl }),
      confirmAccount,
      installer,
      cryptoSource: webcrypto,
      now: clock
    });
    const result = await attempt.complete();
    expect(result).toEqual({ status: 'installed' });
    noPrivate(result);
    expect(confirmAccount).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(parseYandexCredentialRecord(installed.record).accessToken).toBe(access);
    expect(installed.record).not.toContain(refresh);
  });
});

describe('канонический локальный формат Яндекс OAuth без сохранения', () => {
  it('разбирает только фиксированные поля и не добавляет refresh или метку', () => {
    const raw = prepareYandexCredentialRecord(recordOptions());
    const parsed = parseYandexCredentialRecord(raw);
    expect(parsed).toMatchObject(recordOptions());
    expect(serializeYandexCredentialRecord(parsed)).toBe(raw);
    expect(raw).not.toContain(refresh);
    expect(raw).not.toContain(login);
    expect(raw).not.toContain('refresh');
    expect(raw).not.toContain('label');
  });

  it.each([
    { slotId: revision },
    { slotId: 'not-a-uuid' },
    { revision: 'not-a-uuid' },
    { clientId: googleClientId },
    { accountKey: '' },
    { accountKey: 'bad\nvalue' },
    { accessToken: '' },
    { accessToken: 'bad\r\nheader' },
    { accessToken: 'x'.repeat(8193) },
    { expiresAt: 0 },
    { expiresAt: 1.5 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: '3700000' },
    { refreshToken: refresh },
    { label }
  ])('отклоняет некорректные или лишние поля: %#', changes => {
    try {
      prepareYandexCredentialRecord(recordOptions(changes));
      throw new Error('unexpected success');
    } catch (error) {
      expect(String(error)).toContain('Некорректная запись');
      noPrivate(String(error));
    }
  });

  it('отклоняет дубли, нестандартную сериализацию и поля даже после JSON.parse', () => {
    const raw = prepareYandexCredentialRecord(recordOptions());
    const bad = [
      `${raw} `,
      raw.replace('{', '{"version":1,'),
      raw.replace('"version":1', '"version":1,"\\u0076ersion":1'),
      raw.replace('"accessToken":', '"refreshToken":"FAKE", "accessToken":'),
      raw.replace('"version":1', '"version":2'),
      JSON.stringify({ ...JSON.parse(raw), extra: true }),
      raw.slice(0, -1)
    ];
    for (const value of bad) {
      try {
        parseYandexCredentialRecord(value);
        throw new Error('unexpected success');
      } catch (error) {
        expect(String(error)).toContain('Некорректная запись');
        noPrivate(String(error));
      }
    }
  });

  it('не читает getter и не скрывает неверный формат при сериализации', () => {
    const raw = prepareYandexCredentialRecord(recordOptions());
    const parsed = { ...parseYandexCredentialRecord(raw) };
    const getter = vi.fn(() => access);
    Object.defineProperty(parsed, 'accessToken', { enumerable: true, get: getter });
    expect(() => serializeYandexCredentialRecord(parsed)).toThrow('Некорректная запись');
    expect(getter).not.toHaveBeenCalled();
    expect(() => serializeYandexCredentialRecord({ ...parseYandexCredentialRecord(raw), format: 'wrong' })).toThrow();
  });
});
