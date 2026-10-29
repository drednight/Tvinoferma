import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createGoogleCredentialRotation } from '../js/modules/cloudSync/providers/oauthCredentialRotation.js';
import { OAUTH_PROVIDERS } from '../js/modules/cloudSync/providers/oauthCommon.js';

const slotId = 'aa8b55c7-f70e-4db4-bce2-9fe520a71936';
const revision = 'd2041a21-99a5-427c-9db7-b8ca59e22b34';
const otherRevision = '6fcced31-c105-4fbd-a67b-b95f51c2c967';
const clientId = '123456789-test_client.apps.googleusercontent.com';
const accountKey = 'FAKE_ACCOUNT_ID_726';
const oldRefresh = 'FAKE_OLD_REFRESH:123';
const newRefresh = 'FAKE_NEW_REFRESH:456';
const access = 'FAKE_ACCESS_TOKEN_789';

function record(changes = {}) {
  return JSON.stringify({
    format: 'tvinoferma-google-oauth-credential',
    version: 1,
    slotId,
    clientId,
    accountKey,
    revision,
    phase: 'ready',
    attemptId: null,
    refreshToken: oldRefresh,
    refreshExpiresAt: null,
    ...changes
  });
}
function reply(fields = {}, options = {}) {
  const payload = {
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: OAUTH_PROVIDERS.google.scope,
    ...fields
  };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
  const response = new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
  Object.defineProperty(response, 'url', { value: OAUTH_PROVIDERS.google.token });
  return response;
}
function fixture(initial = record()) {
  let value = initial;
  const faults = { failRead: 0, failBefore: 0, failAfter: 0, badReadback: 0, fakeSwap: 0, onWrite: null };
  const reads = vi.fn(async () => {
    if (reads.mock.calls.length === faults.failRead) throw new Error(`PRIVATE_READ ${oldRefresh}`);
    if (reads.mock.calls.length === faults.badReadback) return 'PRIVATE_WRONG_READBACK';
    return value;
  });
  const swaps = vi.fn(async (expected, next) => {
    const call = swaps.mock.calls.length;
    if (call === faults.failBefore) throw new Error(`PRIVATE_BEFORE ${oldRefresh}`);
    if (value !== expected) return 'mismatch';
    if (call !== faults.fakeSwap) value = next;
    faults.onWrite?.(call, next);
    if (call === faults.failAfter) throw new Error(`PRIVATE_AFTER ${oldRefresh}`);
    return 'swapped';
  });
  return {
    store: { read: reads, compareExchange: swaps },
    faults,
    reads,
    swaps,
    get: () => value,
    replace: next => {
      value = next;
    }
  };
}
function setup(extra = {}) {
  const backing = extra.backing || fixture();
  const clock = extra.clock || { time: 100_000 };
  const fetchImpl = extra.fetchImpl || vi.fn(async () => reply({ refresh_token: newRefresh }));
  const verifyAccount = extra.verifyAccount || vi.fn(async () => ({ accountKey }));
  const base = {
    slotId,
    clientId,
    accountKey,
    store: backing.store,
    cryptoSource: webcrypto,
    now: () => clock.time,
    fetchImpl,
    verifyAccount,
    timeoutMs: 1000,
    identityTimeoutMs: 1000,
    ...(extra.options || {})
  };
  return { backing, clock, fetchImpl, verifyAccount, base, coordinator: createGoogleCredentialRotation(base) };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function containsNoSecret(value) {
  const text = JSON.stringify(value);
  for (const item of [access, oldRefresh, newRefresh, accountKey, 'PRIVATE_']) expect(text).not.toContain(item);
}

afterEach(() => vi.useRealTimers());

describe('отключённая модель согласования Google refresh с доверенным атомарным store', () => {
  it('до POST записывает pending без старого токена, после проверки аккаунта заменяет refresh и выдаёт access один раз', async () => {
    const { backing, coordinator, fetchImpl, verifyAccount } = setup();
    const ticket = await coordinator.inspect();
    expect(ticket).toEqual({ status: 'ready', revision });
    fetchImpl.mockImplementation(async (url, init) => {
      expect(url).toBe(OAUTH_PROVIDERS.google.token);
      expect(new URLSearchParams(init.body).get('refresh_token')).toBe(oldRefresh);
      const pending = JSON.parse(backing.get());
      expect(pending).toMatchObject({ phase: 'pending', refreshToken: null, refreshExpiresAt: null });
      expect(backing.get()).not.toContain(oldRefresh);
      expect(pending.attemptId).not.toBe(pending.revision);
      return reply({ refresh_token: newRefresh, refresh_token_expires_in: 7200 });
    });
    verifyAccount.mockImplementation(async args => {
      expect(args.accessToken).toBe(access);
      expect(args.clientId).toBe(clientId);
      expect(args.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(backing.get()).phase).toBe('pending');
      return { accountKey };
    });
    const outcome = await coordinator.refresh({ expectedRevision: ticket.revision });
    expect(outcome.status).toBe('refreshed');
    containsNoSecret(outcome);
    expect(outcome.access.summary).toEqual({ provider: 'google', expiresAt: 3_700_000 });
    expect(outcome.access.takeAccessToken()).toBe(access);
    expect(() => outcome.access.takeAccessToken()).toThrow('недоступны');
    const saved = JSON.parse(backing.get());
    expect(saved).toMatchObject({
      phase: 'ready',
      attemptId: null,
      refreshToken: newRefresh,
      refreshExpiresAt: 7_300_000
    });
    expect(saved.revision).not.toBe(revision);
    expect(backing.get()).not.toContain(oldRefresh);
    expect(backing.get()).not.toContain(access);
    expect(backing.swaps).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(verifyAccount).toHaveBeenCalledOnce();
    expect((await coordinator.inspect()).revision).toBe(saved.revision);
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'changed' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('при успешном ответе без нового refresh сохраняет прежний и его срок, не увеличивая срок', async () => {
    const backing = fixture(record({ refreshExpiresAt: 500_000 }));
    const fetchImpl = vi.fn(async () => reply());
    const { coordinator } = setup({ backing, fetchImpl });
    const outcome = await coordinator.refresh({ expectedRevision: revision });
    expect(outcome.status).toBe('refreshed');
    outcome.access.discard();
    expect(() => outcome.access.takeAccessToken()).toThrow();
    const saved = JSON.parse(backing.get());
    expect(saved.refreshToken).toBe(oldRefresh);
    expect(saved.refreshExpiresAt).toBe(500_000);
    expect(saved.revision).not.toBe(revision);
  });

  it('при новом refresh без срока не выдаёт старый срок за срок нового', async () => {
    const backing = fixture(record({ refreshExpiresAt: 500_000 }));
    const { coordinator } = setup({ backing });
    const outcome = await coordinator.refresh({ expectedRevision: revision });
    expect(outcome.status).toBe('refreshed');
    outcome.access.discard();
    expect(JSON.parse(backing.get())).toMatchObject({ refreshToken: newRefresh, refreshExpiresAt: null });
  });

  it('две параллельные попытки с одной ревизией выполняют ровно один POST при атомарном CAS', async () => {
    const first = setup();
    const second = createGoogleCredentialRotation(first.base);
    const outcomes = await Promise.all([
      first.coordinator.refresh({ expectedRevision: revision }),
      second.refresh({ expectedRevision: revision })
    ]);
    expect(outcomes.map(item => item.status).sort()).toEqual(['changed', 'refreshed']);
    outcomes.find(item => item.status === 'refreshed').access.discard();
    expect(first.fetchImpl).toHaveBeenCalledOnce();
  });

  it('во время POST второй экземпляр видит pending и не отправляет старый токен', async () => {
    const started = deferred();
    const network = deferred();
    const fetchImpl = vi.fn(() => {
      started.resolve();
      return network.promise;
    });
    const first = setup({ fetchImpl });
    const second = createGoogleCredentialRotation(first.base);
    const waiting = first.coordinator.refresh({ expectedRevision: revision });
    await started.promise;
    expect(await first.coordinator.inspect()).toEqual({ status: 'busy' });
    expect(await second.inspect()).toEqual({ status: 'blocked_pending' });
    expect(await second.refresh({ expectedRevision: revision })).toEqual({ status: 'blocked_pending' });
    network.resolve(reply({ refresh_token: newRefresh }));
    const outcome = await waiting;
    expect(outcome.status).toBe('refreshed');
    outcome.access.discard();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(['failBefore', 'failAfter', 'badReadback', 'fakeSwap'])(
    'не делает POST при неподтверждённой записи pending: %s',
    async fault => {
      const { backing, coordinator, fetchImpl, base } = setup();
      backing.faults[fault] = fault === 'badReadback' ? 2 : 1;
      const outcome = await coordinator.refresh({ expectedRevision: revision });
      expect(outcome).toEqual({ status: 'begin_uncertain' });
      containsNoSecret(outcome);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await coordinator.inspect()).toEqual({ status: 'blocked_in_session' });
      backing.faults[fault] = 0;
      const restarted = createGoogleCredentialRotation(base);
      const state = await restarted.inspect();
      // Только тестовый adapter знает, совершена ли замена при потере ответа.
      expect(state.status).toBe(fault === 'failBefore' || fault === 'fakeSwap' ? 'ready' : 'blocked_pending');
    }
  );

  it('повреждённая, отсутствующая, неподходящая или чужая запись никогда не перезаписывается', async () => {
    const samples = [
      [null, 'blocked_missing'],
      ['{broken', 'blocked_record'],
      ['x'.repeat(16 * 1024 + 1), 'blocked_record'],
      [record().replace('"version":1', '"version":1,"version":1'), 'blocked_record'],
      [record().replace('"version":1', '"version":1,"\\u0076ersion":1'), 'blocked_record'],
      [JSON.stringify(JSON.parse(record()), null, 2), 'blocked_record'],
      [record({ unexpected: 'PRIVATE_FIELD' }), 'blocked_record'],
      [record({ refreshToken: '' }), 'blocked_record'],
      [record({ refreshToken: 'TOKEN\r\nInjected' }), 'blocked_record'],
      [record({ refreshExpiresAt: -1 }), 'blocked_record'],
      [record({ phase: 'pending', attemptId: otherRevision }), 'blocked_record'],
      [record({ accountKey: 'someone@example.test' }), 'blocked_record'],
      [record({ accountKey: 'OTHER_ACCOUNT' }), 'blocked_binding'],
      [record({ clientId: '987654321-other.apps.googleusercontent.com' }), 'blocked_binding'],
      [record({ slotId: 'b72c802c-b319-4000-86a1-d1c303777452' }), 'blocked_binding'],
      [record({ revision: slotId }), 'blocked_record']
    ];
    for (const [raw, expected] of samples) {
      const backing = fixture(raw);
      const { coordinator, fetchImpl } = setup({ backing });
      expect((await coordinator.inspect()).status).toBe(expected);
      expect((await coordinator.refresh({ expectedRevision: revision })).status).toBe(expected);
      expect(backing.get()).toBe(raw);
      expect(backing.swaps).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('чужой ожидаемый revision и истёкший refresh не инициируют запись или сеть', async () => {
    const { backing, coordinator, fetchImpl } = setup();
    expect(await coordinator.refresh({ expectedRevision: otherRevision })).toEqual({ status: 'changed' });
    expect(backing.swaps).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    const expired = fixture(record({ refreshExpiresAt: 99_999 }));
    const second = setup({ backing: expired });
    expect(await second.coordinator.inspect()).toEqual({ status: 'refresh_expired' });
    expect(await second.coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'refresh_expired' });
    expect(expired.swaps).not.toHaveBeenCalled();
    expect(second.fetchImpl).not.toHaveBeenCalled();
  });

  it('если часы изменились или срок вышел после pending, POST не отправляется, запись остаётся заблокированной', async () => {
    for (const nextTime of [99_999, 101_000]) {
      const backing = fixture(record({ refreshExpiresAt: 100_500 }));
      const clock = { time: 100_000 };
      backing.faults.onWrite = () => {
        clock.time = nextTime;
      };
      const { coordinator, fetchImpl } = setup({ backing, clock });
      expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'exchange_uncertain' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(JSON.parse(backing.get()).phase).toBe('pending');
    }
  });

  it('не повторяет неизвестный сетевой исход даже после создания нового координатора', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`PRIVATE_NETWORK ${oldRefresh} ${access}`);
    });
    const { coordinator, backing, base, verifyAccount } = setup({ fetchImpl });
    const outcome = await coordinator.refresh({ expectedRevision: revision });
    expect(outcome).toEqual({ status: 'exchange_uncertain' });
    containsNoSecret(outcome);
    expect(JSON.parse(backing.get())).toMatchObject({ phase: 'pending', refreshToken: null });
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'blocked_in_session' });
    const restarted = createGoogleCredentialRotation(base);
    expect(await restarted.inspect()).toEqual({ status: 'blocked_pending' });
    expect(await restarted.refresh({ expectedRevision: revision })).toEqual({ status: 'blocked_pending' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(verifyAccount).not.toHaveBeenCalled();
  });

  it('таймаут с поздним ответом не проводит проверку аккаунта и не снимает pending', async () => {
    const network = deferred();
    const fetchImpl = vi.fn(() => network.promise);
    const { coordinator, backing, verifyAccount } = setup({ fetchImpl, options: { timeoutMs: 20 } });
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'exchange_uncertain' });
    network.resolve(reply({ refresh_token: newRefresh }));
    await Promise.resolve();
    await Promise.resolve();
    expect(verifyAccount).not.toHaveBeenCalled();
    expect(JSON.parse(backing.get()).phase).toBe('pending');
    expect(backing.swaps).toHaveBeenCalledOnce();
  });

  it('не выдаёт токен и не считает отсутствие scope подтверждением прав', async () => {
    const fetchImpl = vi.fn(async () => reply({ scope: undefined, refresh_token: newRefresh }));
    const { coordinator, verifyAccount, backing, base } = setup({ fetchImpl });
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'scope_unverified' });
    expect(verifyAccount).not.toHaveBeenCalled();
    expect(JSON.parse(backing.get())).toMatchObject({ phase: 'pending', refreshToken: null });
    expect(await createGoogleCredentialRotation(base).inspect()).toEqual({ status: 'blocked_pending' });
  });

  it.each([
    [async () => ({ accountKey: 'DIFFERENT_ACCOUNT' }), 'account_changed'],
    [async () => ({ accountKey: '' }), 'identity_unverified'],
    [async () => ({ accountKey, email: 'PRIVATE_EMAIL' }), 'identity_unverified'],
    [
      async () => {
        throw new Error('PRIVATE_IDENTITY');
      },
      'identity_unverified'
    ]
  ])('не завершает ротацию при неподтверждённом аккаунте: %#', async (verifyAccount, expected) => {
    const { coordinator, backing, base } = setup({ verifyAccount });
    const outcome = await coordinator.refresh({ expectedRevision: revision });
    expect(outcome).toEqual({ status: expected });
    containsNoSecret(outcome);
    expect(JSON.parse(backing.get())).toMatchObject({ phase: 'pending', refreshToken: null });
    expect(await createGoogleCredentialRotation(base).inspect()).toEqual({ status: 'blocked_pending' });
    expect(backing.swaps).toHaveBeenCalledOnce();
  });

  it('прерывает зависшую проверку аккаунта и не использует поздний ответ', async () => {
    const verification = deferred();
    let signal;
    const verifyAccount = vi.fn(args => {
      signal = args.signal;
      return verification.promise;
    });
    const { coordinator, backing } = setup({ verifyAccount, options: { identityTimeoutMs: 20 } });
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'identity_unverified' });
    expect(signal.aborted).toBe(true);
    verification.resolve({ accountKey });
    await Promise.resolve();
    expect(JSON.parse(backing.get()).phase).toBe('pending');
    expect(backing.swaps).toHaveBeenCalledOnce();
  });

  it('не перезаписывает запись, заменённую во время проверки аккаунта', async () => {
    const backing = fixture();
    const changed = record({ revision: otherRevision, accountKey: 'EXTERNAL_ACCOUNT' });
    const verifyAccount = async () => {
      backing.replace(changed);
      return { accountKey };
    };
    const { coordinator } = setup({ backing, verifyAccount });
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'finish_uncertain' });
    expect(backing.get()).toBe(changed);
    expect(await coordinator.inspect()).toEqual({ status: 'blocked_in_session' });
  });

  it.each(['failBefore', 'failAfter', 'badReadback', 'fakeSwap'])(
    'не выдаёт access при неподтверждённом сохранении ротации: %s',
    async fault => {
      const { backing, coordinator, base } = setup();
      backing.faults[fault] = fault === 'badReadback' ? 3 : 2;
      const outcome = await coordinator.refresh({ expectedRevision: revision });
      expect(outcome).toEqual({ status: 'finish_uncertain' });
      containsNoSecret(outcome);
      expect(await coordinator.inspect()).toEqual({ status: 'blocked_in_session' });
      backing.faults[fault] = 0;
      const restarted = createGoogleCredentialRotation(base);
      const persisted = await restarted.inspect();
      expect(persisted.status).toBe(fault === 'failAfter' || fault === 'badReadback' ? 'ready' : 'blocked_pending');
      if (persisted.status === 'ready') {
        expect(JSON.parse(backing.get()).refreshToken).toBe(newRefresh);
        expect(persisted.revision).not.toBe(revision);
      }
    }
  );

  it('не завершает ротацию, если заявленный срок refresh истёк во время проверки аккаунта', async () => {
    for (const newToken of [false, true]) {
      const clock = { time: 100_000 };
      const backing = fixture(record({ refreshExpiresAt: 101_000 }));
      const fetchImpl = vi.fn(async () =>
        reply(newToken ? { refresh_token: newRefresh, refresh_token_expires_in: 1 } : {})
      );
      const verifyAccount = async () => {
        clock.time = 101_000;
        return { accountKey };
      };
      const { coordinator } = setup({ clock, backing, fetchImpl, verifyAccount });
      expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'identity_unverified' });
      expect(JSON.parse(backing.get())).toMatchObject({ phase: 'pending', refreshToken: null });
    }
  });

  it('не выдаёт access, если срок нового refresh закончился во время сохранения', async () => {
    const clock = { time: 100_000 };
    const backing = fixture();
    backing.faults.onWrite = call => {
      if (call === 2) clock.time = 101_000;
    };
    const fetchImpl = vi.fn(async () => reply({ refresh_token: newRefresh, refresh_token_expires_in: 1 }));
    const { coordinator } = setup({ clock, backing, fetchImpl });
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'refresh_expired' });
    expect(JSON.parse(backing.get())).toMatchObject({ phase: 'ready', refreshToken: newRefresh });
    expect(await coordinator.inspect()).toEqual({ status: 'refresh_expired' });
  });

  it('если access истёк во время сохранения, оставляет новый refresh, но не выдаёт access', async () => {
    const clock = { time: 100_000 };
    const backing = fixture();
    backing.faults.onWrite = call => {
      if (call === 2) clock.time = 160_000;
    };
    const { coordinator } = setup({ backing, clock });
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'refreshed_access_expired' });
    expect(JSON.parse(backing.get())).toMatchObject({ phase: 'ready', refreshToken: newRefresh });
  });

  it('не выдаёт access при откате часов относительно более позднего измерения', async () => {
    const clock = { time: 100_000 };
    const backing = fixture();
    backing.faults.onWrite = call => {
      if (call === 2) clock.time = 100_020;
    };
    const verifyAccount = async () => {
      clock.time = 100_050;
      return { accountKey };
    };
    const { coordinator } = setup({ backing, clock, verifyAccount });
    expect(await coordinator.refresh({ expectedRevision: revision })).toEqual({ status: 'refreshed_access_expired' });
    expect(JSON.parse(backing.get()).phase).toBe('ready');
  });

  it('ограничивает жизнь выданного access и учитывает сдвиг часов назад', async () => {
    vi.useFakeTimers();
    const first = setup();
    const result = await first.coordinator.refresh({ expectedRevision: revision });
    expect(result.status).toBe('refreshed');
    first.clock.time += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(() => result.access.takeAccessToken()).toThrow('недоступны');
    const second = setup();
    const other = await second.coordinator.refresh({ expectedRevision: revision });
    second.clock.time--;
    expect(() => other.access.takeAccessToken()).toThrow('недоступны');
  });

  it('намеренно демонстрирует границу модели: откат всей записи к старой ready не распознаётся', async () => {
    const initial = record();
    const fetchImpl = vi.fn(async () => {
      throw new Error('PRIVATE_NETWORK');
    });
    const { coordinator, backing, base } = setup({ fetchImpl });
    expect((await coordinator.refresh({ expectedRevision: revision })).status).toBe('exchange_uncertain');
    expect(JSON.parse(backing.get()).phase).toBe('pending');
    backing.replace(initial); // НАРУШЕНИЕ контракта хранилища: внешний откат старой записи.
    expect(await createGoogleCredentialRotation(base).inspect()).toEqual({ status: 'ready', revision });
  });

  it('отклоняет небезопасную конфигурацию, getters и не раскрывает ошибки адаптеров', async () => {
    const { base } = setup();
    for (const options of [
      { ...base, slotId: '00000000-0000-0000-0000-000000000000' },
      { ...base, accountKey: 'mail@example.test' },
      { ...base, clientId: 'bad' },
      { ...base, now: null },
      { ...base, cryptoSource: null },
      { ...base, timeoutMs: 1 },
      { ...base, identityTimeoutMs: 1 },
      { ...base, store: { read: base.store.read } },
      { ...base, unexpected: 'PRIVATE_EXTRA' }
    ])
      expect(() => createGoogleCredentialRotation(options)).toThrow('Некорректная конфигурация');
    const getter = vi.fn(() => base.accountKey);
    const invalid = { ...base };
    Object.defineProperty(invalid, 'accountKey', { enumerable: true, get: getter });
    expect(() => createGoogleCredentialRotation(invalid)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const broken = setup();
    broken.backing.faults.failRead = 1;
    const outcome = await broken.coordinator.inspect();
    expect(outcome).toEqual({ status: 'store_unavailable' });
    containsNoSecret(outcome);
  });
});
