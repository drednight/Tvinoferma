import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createGoogleEnrollmentAttempt } from '../js/modules/cloudSync/providers/oauthCredentialEnrollment.js';
import { createGoogleEncryptedCredentialStore } from '../js/modules/cloudSync/providers/oauthCredentialCipherStore.js';
import { parseGoogleCredentialRecord } from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { createGoogleCredentialRotation } from '../js/modules/cloudSync/providers/oauthCredentialRotation.js';
import { createCloudOAuthTokenTransport } from '../js/modules/cloudSync/providers/oauthTokenTransport.js';
import { startCloudOAuth } from '../js/modules/cloudSync/providers/oauthPkce.js';
import {
  createGoogleAccountIdentityReader,
  createGoogleAccountPreviewReader
} from '../js/modules/cloudSync/providers/oauthAccountIdentity.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const clientId = '123456789-test_client.apps.googleusercontent.com';
const accountKey = 'FAKE_PRIVATE_ACCOUNT_123';
const access = 'FAKE_PRIVATE_ACCESS_123';
const refresh = 'FAKE_PRIVATE_REFRESH:456';
const label = Object.freeze({ kind: 'email', value: 'fake_account@example.test' });
const googleAbout = 'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%2CemailAddress%29';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function tokenLease(summaryChanges = {}, secretChanges = {}) {
  let spent = false;
  return Object.freeze({
    summary: Object.freeze({
      provider: 'google',
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
function base(extra = {}) {
  const clock = extra.clock || { value: 100_000 };
  const tokenResponse = extra.tokenResponse || tokenLease();
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
    now: () => clock.value,
    cryptoSource: webcrypto,
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
    attempt: createGoogleEnrollmentAttempt(options)
  };
}
function noPrivate(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const text of [access, refresh, accountKey, label.value, 'PRIVATE_ERROR'])
    expect(serialized).not.toContain(text);
}
function reply(url, body) {
  const response = new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('отключённое первое подключение Google с доверенными callbacks', () => {
  it('дважды проверяет ID и метку, требует подтверждения и только затем вызывает installer', async () => {
    const { attempt, tokenResponse, previewAccount, confirmAccount, installer } = base();
    previewAccount.mockImplementation(async args => {
      expect(args).toMatchObject({ clientId, accessToken: access });
      expect(args.signal).toBeInstanceOf(AbortSignal);
      expect(installer.installIfAbsent).not.toHaveBeenCalled();
      return { accountKey, label };
    });
    confirmAccount.mockImplementation(async args => {
      expect(args).toMatchObject({ provider: 'google', clientId, label });
      expect(JSON.stringify(args)).not.toContain(accountKey);
      expect(Object.isFrozen(args.label)).toBe(true);
      expect(args.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(args)).not.toContain(access);
      expect(JSON.stringify(args)).not.toContain(refresh);
      expect(installer.installIfAbsent).not.toHaveBeenCalled();
      return true;
    });
    const result = await attempt.complete();
    expect(result).toEqual({ status: 'installed' });
    noPrivate(result);
    expect(previewAccount).toHaveBeenCalledTimes(2);
    expect(confirmAccount).toHaveBeenCalledOnce();
    expect(tokenResponse.takeSecrets).toHaveBeenCalledOnce();
    expect(installer.installIfAbsent).toHaveBeenCalledOnce();
    expect(installer.verifyInstallation).toHaveBeenCalledOnce();
    const installed = installer.installIfAbsent.mock.calls[0][0];
    expect(Object.isFrozen(installed)).toBe(true);
    expect(JSON.stringify(installed)).not.toContain(label.value);
    expect(JSON.stringify(installer.verifyInstallation.mock.calls[0][0])).not.toContain(label.value);
    expect(installed.accountKey).toBe(accountKey);
    expect(installed.slotId).not.toBe(parseGoogleCredentialRecord(installed.record).revision);
    expect(parseGoogleCredentialRecord(installed.record)).toMatchObject({
      phase: 'ready',
      refreshToken: refresh,
      accountKey
    });
    expect(await attempt.complete()).toEqual({ status: 'spent' });
  });

  it.each([
    [{ scope: 'unverified' }, 'scope_unverified'],
    [{ refreshAvailable: false }, 'refresh_missing']
  ])('без нужных данных отбрасывает lease до обращения к секретам: %#', async (changes, status) => {
    const tokenResponse = tokenLease(changes);
    const { attempt, previewAccount, confirmAccount, installer } = base({ tokenResponse });
    expect(await attempt.complete()).toEqual({ status });
    expect(tokenResponse.discard).toHaveBeenCalledOnce();
    expect(tokenResponse.takeSecrets).not.toHaveBeenCalled();
    expect(previewAccount).not.toHaveBeenCalled();
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it.each([
    [{}, { refreshToken: null }],
    [{}, { accessToken: 'TOKEN\r\nPRIVATE_ERROR' }],
    [{ expiresAt: 100_000 }, {}],
    [{ refreshExpiresAt: 100_000 }, {}]
  ])('не устанавливает просроченные или некорректные токены: %#', async (summary, secrets) => {
    const { attempt, installer, previewAccount } = base({ tokenResponse: tokenLease(summary, secrets) });
    const output = await attempt.complete();
    expect(output).toEqual({ status: 'token_unavailable' });
    noPrivate(output);
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
    expect(previewAccount).not.toHaveBeenCalled();
  });

  it.each([
    [async () => ({ accountKey: '' })],
    [async () => ({ accountKey, email: 'PRIVATE_EMAIL' })],
    [
      async () => {
        throw new Error(`PRIVATE_ERROR ${access}`);
      }
    ]
  ])('не подтверждает ошибочный или неоднозначный ID: %#', async previewAccount => {
    const { attempt, confirmAccount, installer } = base({ previewAccount });
    const output = await attempt.complete();
    expect(output).toEqual({ status: 'identity_unverified' });
    noPrivate(output);
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('отсутствующий email не позволяет автоматически подтвердить подключение', async () => {
    const previewAccount = vi.fn(async () => ({ accountKey, label: null }));
    const { attempt, confirmAccount, installer } = base({ previewAccount });
    const output = await attempt.complete();
    expect(output).toEqual({ status: 'account_label_unavailable' });
    noPrivate(output);
    expect(previewAccount).toHaveBeenCalledOnce();
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
    expect(await attempt.complete()).toEqual({ status: 'spent' });
  });

  it.each([
    { kind: 'email', value: '' },
    { kind: 'email', value: 'victim@example.test\u202eevil' },
    { kind: 'email', value: 'victim@example.test\nattacker@example.test' },
    { kind: 'email', value: '<img src=x>@example.test' },
    { kind: 'email', value: 'x'.repeat(65) + '@example.test' },
    { kind: 'email', value: 'victim@example.test', extra: 'PRIVATE' },
    { kind: 'login', value: 'victim' },
    'victim@example.test'
  ])('не показывает неподходящую метку и ничего не сохраняет: %#', async badLabel => {
    const previewAccount = vi.fn(async () => ({ accountKey, label: badLabel }));
    const { attempt, confirmAccount, installer } = base({ previewAccount });
    const output = await attempt.complete();
    expect(output).toEqual({ status: 'identity_unverified' });
    noPrivate(output);
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('не исполняет getter метки и не передаёт её в подтверждение', async () => {
    const getter = vi.fn(() => label.value);
    const suspicious = { kind: 'email' };
    Object.defineProperty(suspicious, 'value', { enumerable: true, get: getter });
    const { attempt, confirmAccount, installer } = base({
      previewAccount: async () => ({ accountKey, label: suspicious })
    });
    expect(await attempt.complete()).toEqual({ status: 'identity_unverified' });
    expect(getter).not.toHaveBeenCalled();
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('пользователь может отказаться; при ином значении подтверждение не выдумывается', async () => {
    for (const [answer, status] of [
      [false, 'declined'],
      [null, 'confirmation_unverified'],
      ['yes', 'confirmation_unverified']
    ]) {
      const { attempt, installer, previewAccount } = base({ confirmAccount: async () => answer });
      expect(await attempt.complete()).toEqual({ status });
      expect(previewAccount).toHaveBeenCalledOnce();
      expect(installer.installIfAbsent).not.toHaveBeenCalled();
    }
  });

  it('после согласия повторно сверяет ID и не сохраняет другой аккаунт', async () => {
    const previewAccount = vi
      .fn()
      .mockResolvedValueOnce({ accountKey, label })
      .mockResolvedValueOnce({ accountKey: 'DIFFERENT_ACCOUNT', label });
    const { attempt, installer } = base({ previewAccount });
    expect(await attempt.complete()).toEqual({ status: 'account_changed' });
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'email', value: 'another@example.test' },
    { kind: 'email', value: 'FAKE_account@example.test' },
    null
  ])('не устанавливает запись, если после согласия изменилась или исчезла метка: %#', async nextLabel => {
    const previewAccount = vi
      .fn()
      .mockResolvedValueOnce({ accountKey, label })
      .mockResolvedValueOnce({ accountKey, label: nextLabel });
    const { attempt, confirmAccount, installer } = base({ previewAccount });
    const output = await attempt.complete();
    expect(output).toEqual({ status: 'account_changed' });
    noPrivate(output);
    expect(confirmAccount).toHaveBeenCalledOnce();
    expect(previewAccount).toHaveBeenCalledTimes(2);
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('снимок показанной метки нельзя подменить изменением объекта во время подтверждения', async () => {
    const mutable = { kind: 'email', value: label.value };
    const started = deferred();
    const approved = deferred();
    const previewAccount = vi.fn(async () => ({ accountKey, label: mutable }));
    const confirmAccount = vi.fn(args => {
      expect(args.label).not.toBe(mutable);
      expect(Object.isFrozen(args.label)).toBe(true);
      expect(args.label.value).toBe(label.value);
      started.resolve();
      return approved.promise;
    });
    const { attempt, installer } = base({ previewAccount, confirmAccount });
    const pending = attempt.complete();
    await started.promise;
    mutable.value = 'another@example.test';
    approved.resolve(true);
    expect(await pending).toEqual({ status: 'account_changed' });
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('отмена до начала отбрасывает lease; обмен не запускается при повторе', async () => {
    const { attempt, tokenResponse, previewAccount } = base();
    expect(attempt.cancel()).toEqual({ status: 'cancelled' });
    expect(await attempt.complete()).toEqual({ status: 'cancelled' });
    expect(tokenResponse.discard).toHaveBeenCalledOnce();
    expect(tokenResponse.takeSecrets).not.toHaveBeenCalled();
    expect(previewAccount).not.toHaveBeenCalled();
  });

  it('отмена во время проверки игнорирует поздний ответ и не начинает установку', async () => {
    const started = deferred();
    const late = deferred();
    let signal;
    const previewAccount = vi.fn(args => {
      signal = args.signal;
      started.resolve();
      return late.promise;
    });
    const { attempt, confirmAccount, installer } = base({ previewAccount });
    const waiting = attempt.complete();
    await started.promise;
    expect(await attempt.complete()).toEqual({ status: 'busy' });
    expect(attempt.cancel()).toEqual({ status: 'cancelled' });
    expect(signal.aborted).toBe(true);
    expect(await waiting).toEqual({ status: 'cancelled' });
    late.resolve({ accountKey, label });
    await Promise.resolve();
    expect(confirmAccount).not.toHaveBeenCalled();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
    expect(await attempt.complete()).toEqual({ status: 'cancelled' });
  });

  it('при зависшем подтверждении срок истекает, поздний ответ не сохраняет токен', async () => {
    const late = deferred();
    let signal;
    const confirmAccount = vi.fn(args => {
      signal = args.signal;
      return late.promise;
    });
    const { attempt, installer } = base({ confirmAccount, options: { confirmationTimeoutMs: 20 } });
    expect(await attempt.complete()).toEqual({ status: 'confirmation_unverified' });
    expect(signal.aborted).toBe(true);
    late.resolve(true);
    await Promise.resolve();
    expect(installer.installIfAbsent).not.toHaveBeenCalled();
    expect(await attempt.complete()).toEqual({ status: 'spent' });
  });

  it('не устанавливает при истечении времени или обратном ходе часов до записи', async () => {
    const forward = { value: 100_000 };
    const first = base({
      clock: forward,
      confirmAccount: async () => {
        forward.value += 60_000;
        return true;
      }
    });
    expect(await first.attempt.complete()).toEqual({ status: 'confirmation_unverified' });
    expect(first.installer.installIfAbsent).not.toHaveBeenCalled();
    const backward = { value: 100_000 };
    const second = base({
      clock: backward,
      confirmAccount: async () => {
        backward.value -= 1;
        return true;
      }
    });
    expect(await second.attempt.complete()).toEqual({ status: 'confirmation_unverified' });
    expect(second.installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('даже повторная отмена во время генерации ID не начинает запись', async () => {
    let attempt;
    const crypto = {
      subtle: webcrypto.subtle,
      getRandomValues(bytes) {
        attempt.cancel();
        return webcrypto.getRandomValues(bytes);
      }
    };
    const fixture = base({ options: { cryptoSource: crypto } });
    attempt = fixture.attempt;
    expect(await attempt.complete()).toEqual({ status: 'cancelled' });
    expect(fixture.installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('время может истечь при генерации ID: установка не начинается', async () => {
    const clock = { value: 100_000 };
    const crypto = {
      subtle: webcrypto.subtle,
      getRandomValues(bytes) {
        clock.value = 160_000;
        return webcrypto.getRandomValues(bytes);
      }
    };
    const fixture = base({ clock, options: { cryptoSource: crypto } });
    expect(await fixture.attempt.complete()).toEqual({ status: 'token_unavailable' });
    expect(fixture.installer.installIfAbsent).not.toHaveBeenCalled();
  });

  it('две явные попытки не заменяют друг друга при атомарном доверенном installer', async () => {
    const started = deferred();
    const release = deferred();
    let occupied = false;
    const installer = {
      installIfAbsent: vi.fn(async () => {
        if (occupied) return 'occupied';
        occupied = true; // только имитация атомарной резервации
        started.resolve();
        await release.promise;
        return 'installed';
      }),
      verifyInstallation: vi.fn(async () => true)
    };
    const first = base({ installer });
    const second = base({ installer });
    const waiting = first.attempt.complete();
    await started.promise;
    expect(await second.attempt.complete()).toEqual({ status: 'already_configured' });
    release.resolve();
    expect(await waiting).toEqual({ status: 'installed' });
    expect(installer.installIfAbsent).toHaveBeenCalledTimes(2);
    expect(installer.verifyInstallation).toHaveBeenCalledOnce();
  });

  it('не перезаписывает занятое подключение', async () => {
    const installer = { installIfAbsent: vi.fn(async () => 'occupied'), verifyInstallation: vi.fn() };
    const { attempt } = base({ installer });
    expect(await attempt.complete()).toEqual({ status: 'already_configured' });
    expect(installer.verifyInstallation).not.toHaveBeenCalled();
    expect(await attempt.complete()).toEqual({ status: 'spent' });
  });

  it('ошибка записи и неподтверждённое перечитывание считаются неизвестным исходом, без повтора', async () => {
    for (const behavior of ['throw', 'wrong', 'verify-throw', 'verify-false']) {
      const installer = {
        installIfAbsent: vi.fn(async () => {
          if (behavior === 'throw') throw new Error(`PRIVATE_ERROR ${refresh}`);
          return behavior === 'wrong' ? 'unknown' : 'installed';
        }),
        verifyInstallation: vi.fn(async () => {
          if (behavior === 'verify-throw') throw new Error(`PRIVATE_ERROR ${refresh}`);
          return behavior !== 'verify-false';
        })
      };
      const { attempt } = base({ installer });
      const output = await attempt.complete();
      expect(output).toEqual({ status: 'installation_uncertain' });
      noPrivate(output);
      expect(await attempt.complete()).toEqual({ status: 'spent' });
      expect(installer.installIfAbsent).toHaveBeenCalledOnce();
    }
  });

  it('таймаут установки не выдаёт успех и не принимает поздний ответ как подтверждение', async () => {
    const late = deferred();
    const installer = { installIfAbsent: vi.fn(() => late.promise), verifyInstallation: vi.fn(async () => true) };
    const { attempt } = base({ installer, options: { installationTimeoutMs: 20 } });
    expect(await attempt.complete()).toEqual({ status: 'installation_uncertain' });
    late.resolve('installed');
    await Promise.resolve();
    expect(installer.verifyInstallation).not.toHaveBeenCalled();
    expect(await attempt.complete()).toEqual({ status: 'spent' });
  });

  it('после начала установки отмена не объявляет её отменённой', async () => {
    const started = deferred();
    const late = deferred();
    const installer = {
      installIfAbsent: vi.fn(() => {
        started.resolve();
        return late.promise;
      }),
      verifyInstallation: vi.fn(async () => true)
    };
    const { attempt } = base({ installer });
    const waiting = attempt.complete();
    await started.promise;
    expect(attempt.cancel()).toEqual({ status: 'installation_in_progress' });
    late.resolve('installed');
    expect(await waiting).toEqual({ status: 'installed' });
  });

  it('сообщает об истечении refresh во время установки, не выдавая access', async () => {
    const clock = { value: 100_000 };
    const installer = {
      installIfAbsent: vi.fn(async () => {
        clock.value = 101_000;
        return 'installed';
      }),
      verifyInstallation: vi.fn(async () => true)
    };
    const { attempt } = base({ clock, installer, tokenResponse: tokenLease({ refreshExpiresAt: 101_000 }) });
    const output = await attempt.complete();
    expect(output).toEqual({ status: 'installed_refresh_expired' });
    noPrivate(output);
  });

  it('отклоняет неполную или изменяемую конфигурацию до вызова пользовательских callbacks', () => {
    const { options } = base();
    for (const change of [
      { clientId: 'bad' },
      { tokenResponse: tokenLease({ provider: 'yandex' }) },
      { tokenResponse: tokenLease({ operation: 'refresh' }) },
      { tokenResponse: tokenLease({ scope: 'unexpected' }) },
      { installer: {} },
      { confirmAccount: null },
      { options: true },
      { identityTimeoutMs: 1 }
    ])
      expect(() => createGoogleEnrollmentAttempt({ ...options, ...change })).toThrow('Не удалось подготовить');
    const getter = vi.fn(() => clientId);
    const candidate = { ...options };
    Object.defineProperty(candidate, 'clientId', { enumerable: true, get: getter });
    expect(() => createGoogleEnrollmentAttempt(candidate)).toThrow('Не удалось подготовить');
    expect(getter).not.toHaveBeenCalled();
  });

  it('связывает PKCE, POST, about.get, подтверждение и шифрованный fake-store без настоящей сети', async () => {
    const now = () => 100_000;
    const invoke = vi.fn(async command => {
      if (command === 'cloud_oauth_callback_begin') return { port: 42424 };
      if (command === 'cloud_oauth_callback_poll') return { status: 'code', code: 'FAKE_CODE' };
      if (command === 'cloud_oauth_callback_cancel') return null;
      throw new Error('unexpected command');
    });
    const openBrowser = vi.fn(async () => {});
    const oauth = await startCloudOAuth({
      provider: 'google',
      clientId,
      invoke,
      openBrowser,
      cryptoSource: webcrypto,
      now
    });
    expect(await oauth.poll()).toEqual({ status: 'code_ready' });
    const fetchImpl = vi.fn(async url => {
      if (url === OAUTH_PROVIDERS.google.token)
        return reply(url, {
          access_token: access,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: OAUTH_PROVIDERS.google.scope,
          refresh_token: refresh
        });
      if (url === googleAbout) return reply(url, { user: { permissionId: accountKey, emailAddress: label.value } });
      throw new Error('unexpected URL');
    });
    const transport = createCloudOAuthTokenTransport({
      provider: 'google',
      clientId,
      operation: 'code',
      fetchImpl,
      now
    });
    const tokenResponse = await oauth.exchange(request => transport.send(request));
    const previewAccount = createGoogleAccountPreviewReader({ fetchImpl });
    const verifyAccount = createGoogleAccountIdentityReader({ fetchImpl });
    const cryptoKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt'
    ]);
    let cipher = null;
    let pin = null;
    let active = false;
    const backend = {
      read: async () => cipher,
      compareExchange: async (expected, next) => {
        if (cipher !== expected) return 'mismatch';
        cipher = next;
        return 'swapped';
      }
    };
    // Это только имитация совместной атомарной установки pin/key/ciphertext.
    const installer = {
      installIfAbsent: vi.fn(async args => {
        if (pin || active) return 'occupied';
        active = true;
        const store = createGoogleEncryptedCredentialStore({
          slotId: args.slotId,
          clientId: args.clientId,
          accountKey: args.accountKey,
          key: cryptoKey,
          backend,
          cryptoSource: webcrypto
        });
        if ((await store.compareExchange(null, args.record)) !== 'swapped') return 'occupied';
        pin = { slotId: args.slotId, clientId: args.clientId, accountKey: args.accountKey, store };
        return 'installed';
      }),
      verifyInstallation: vi.fn(async args => !!pin && (await pin.store.read()) === args.record)
    };
    const confirmAccount = vi.fn(async () => true); // НЕ подтверждение реальным пользователем.
    const attempt = createGoogleEnrollmentAttempt({
      clientId,
      tokenResponse,
      previewAccount,
      confirmAccount,
      installer,
      cryptoSource: webcrypto,
      now
    });
    expect(await attempt.complete()).toEqual({ status: 'installed' });
    expect(openBrowser).toHaveBeenCalledOnce();
    expect(confirmAccount).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([OAUTH_PROVIDERS.google.token, googleAbout, googleAbout]);
    noPrivate(cipher);
    const coordinator = createGoogleCredentialRotation({
      ...pin,
      fetchImpl,
      verifyAccount,
      cryptoSource: webcrypto,
      now
    });
    expect((await coordinator.inspect()).status).toBe('ready');
  });
});
