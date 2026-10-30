import { describe, expect, it, vi } from 'vitest';
import {
  createNativeCredentialInstaller,
  createNativeGoogleCredentialStore,
  forgetNativeCredential,
  forgetUnboundNativeCredential,
  inspectNativeCredential,
  readNativeCredentialBinding
} from '../js/modules/cloudSync/providers/nativeCredentialStore.js';
import {
  parseGoogleCredentialRecord,
  prepareGoogleCredentialRecord,
  serializeGoogleCredentialRecord
} from '../js/modules/cloudSync/providers/oauthCredentialRecord.js';
import { prepareYandexCredentialRecord } from '../js/modules/cloudSync/providers/oauthYandexCredentialRecord.js';

const SLOT = '01234567-89ab-4cde-8f01-23456789abcd';
const REV1 = '11234567-89ab-4cde-8f01-23456789abcd';
const REV2 = '21234567-89ab-4cde-8f01-23456789abcd';
const REV3 = '31234567-89ab-4cde-8f01-23456789abcd';
const ATTEMPT = '41234567-89ab-4cde-8f01-23456789abcd';
const CLIENTS = { google: 'fake-client.apps.googleusercontent.com', yandex: '0123456789abcdef' };
const ACCOUNT = 'FAKE_PRIVATE_ACCOUNT';
const REFRESH = 'FAKE_PRIVATE_REFRESH';
const ACCESS = 'FAKE_PRIVATE_ACCESS';

function fixture(provider = 'google') {
  const base = { slotId: SLOT, clientId: CLIENTS[provider], accountKey: ACCOUNT };
  const record =
    provider === 'google'
      ? prepareGoogleCredentialRecord({ ...base, revision: REV1, refreshToken: REFRESH, refreshExpiresAt: null })
      : prepareYandexCredentialRecord({ ...base, revision: REV1, accessToken: ACCESS, expiresAt: 1800000000000 });
  return { ...base, record };
}
function pending(raw) {
  return serializeGoogleCredentialRecord({
    ...parseGoogleCredentialRecord(raw),
    revision: REV2,
    phase: 'pending',
    attemptId: ATTEMPT,
    refreshToken: null,
    refreshExpiresAt: null
  });
}
function nextReady(raw) {
  return serializeGoogleCredentialRecord({
    ...parseGoogleCredentialRecord(raw),
    revision: REV3,
    phase: 'ready',
    attemptId: null,
    refreshToken: 'FAKE_NEW_REFRESH',
    refreshExpiresAt: null
  });
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
function native() {
  const slots = new Map();
  const invoke = vi.fn(async (command, args) => {
    const current = slots.get(args.provider);
    if (command === 'cloud_credential_read') return current || { status: 'empty' };
    if (command === 'cloud_credential_install') {
      if (current) return { status: 'occupied' };
      slots.set(args.provider, { status: 'ready', slotId: args.slotId, record: args.record });
      return { status: 'installed' };
    }
    if (command === 'cloud_credential_compare_exchange') {
      if (!current || current.slotId !== args.slotId || current.record !== args.expected) return { status: 'mismatch' };
      slots.set(args.provider, { status: 'ready', slotId: args.slotId, record: args.next });
      return { status: 'swapped' };
    }
    if (command === 'cloud_credential_forget') {
      slots.delete(args.provider);
      return { status: 'forgotten' };
    }
    throw new Error('FAKE_PRIVATE_NATIVE_ERROR');
  });
  return { slots, invoke };
}
function assertNoPrivate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [ACCOUNT, REFRESH, ACCESS, 'FAKE_PRIVATE_NATIVE_ERROR']) expect(text).not.toContain(secret);
}

describe('локальный pin привязки через fake IPC', () => {
  it.each(['google', 'yandex'])('%s: возвращает только ожидаемые проверенные метаданные', async provider => {
    const value = fixture(provider);
    const invoke = vi.fn(async () => ({
      status: 'ready',
      slotId: SLOT,
      clientId: value.clientId,
      accountKey: ACCOUNT
    }));
    const result = await readNativeCredentialBinding({ provider, invoke });
    expect(result).toEqual({
      status: 'ready',
      binding: { slotId: SLOT, clientId: value.clientId, accountKey: ACCOUNT }
    });
    expect(JSON.stringify(result)).not.toContain(REFRESH);
    expect(JSON.stringify(result)).not.toContain(ACCESS);
    expect(invoke).toHaveBeenCalledWith('cloud_credential_binding_read', { provider });
  });

  it('отвергает лишние поля, повреждённые ID и скрывает ошибки IPC', async () => {
    const args = { provider: 'google', invoke: vi.fn() };
    for (const reply of [
      { status: 'empty', slotId: SLOT },
      { status: 'pending', accountKey: ACCOUNT },
      { status: 'blocked', record: REFRESH },
      { status: 'ready', slotId: 'wrong', clientId: CLIENTS.google, accountKey: ACCOUNT },
      { status: 'ready', slotId: SLOT, clientId: CLIENTS.yandex, accountKey: ACCOUNT },
      { status: 'ready', slotId: SLOT, clientId: CLIENTS.google, accountKey: 'contains space' },
      { status: 'ready', slotId: SLOT, clientId: CLIENTS.google, accountKey: ACCOUNT, record: REFRESH },
      { status: 'ready', slotId: SLOT, clientId: CLIENTS.google },
      { status: 'future' }
    ]) {
      args.invoke.mockResolvedValue(reply);
      await expect(readNativeCredentialBinding(args)).rejects.not.toThrow(REFRESH);
    }
    args.invoke.mockRejectedValue(new Error(`FAKE_PRIVATE_NATIVE_ERROR ${REFRESH}`));
    await expect(readNativeCredentialBinding(args)).rejects.not.toThrow(REFRESH);
    await expect(readNativeCredentialBinding({ ...args, provider: 'other' })).rejects.toThrow();
  });
});

describe('экспериментальный мост локальной установки — только поддельный IPC', () => {
  it.each(['google', 'yandex'])(
    '%s: однократная установка, подтверждение чтением и проверка без токенов',
    async provider => {
      const { invoke } = native();
      const args = fixture(provider);
      const installer = createNativeCredentialInstaller({ provider, invoke });
      expect(await inspectNativeCredential({ provider, invoke })).toEqual({ status: 'empty' });
      expect(await installer.installIfAbsent(args)).toBe('installed');
      expect(await installer.verifyInstallation(args)).toBe(true);
      const result = await inspectNativeCredential({ provider, invoke });
      expect(result).toEqual({ status: 'configured' });
      assertNoPrivate(result);
      await expect(installer.installIfAbsent(args)).rejects.toThrow('Не удалось безопасно');
      await expect(installer.verifyInstallation(args)).rejects.toThrow('Не удалось безопасно');
    }
  );

  it('не принимает неверную привязку, pending или чужой provider до IPC', async () => {
    const { invoke } = native();
    const installer = createNativeCredentialInstaller({ provider: 'google', invoke });
    const args = fixture();
    for (const invalid of [
      { ...args, slotId: REV3 },
      { ...args, accountKey: 'OTHER' },
      { ...args, clientId: 'other.apps.googleusercontent.com' },
      { ...args, record: pending(args.record) },
      fixture('yandex')
    ])
      await expect(installer.installIfAbsent(invalid)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(await installer.installIfAbsent(args)).toBe('installed');
  });

  it('не заменяет занятую запись и не считает её своей установкой', async () => {
    const n = native();
    const args = fixture();
    const first = createNativeCredentialInstaller({ provider: 'google', invoke: n.invoke });
    expect(await first.installIfAbsent(args)).toBe('installed');
    expect(await first.verifyInstallation(args)).toBe(true);
    const second = createNativeCredentialInstaller({ provider: 'google', invoke: n.invoke });
    expect(await second.installIfAbsent(args)).toBe('occupied');
    await expect(second.verifyInstallation(args)).rejects.toThrow();
    expect(n.slots.get('google').record).toBe(args.record);
  });

  it('повреждённый ответ или ошибка не возвращают секреты и блокируют повтор в экземпляре', async () => {
    const args = fixture();
    for (const value of [{ status: 'blocked' }, { status: 'installed', record: REFRESH }, { status: 'wat' }]) {
      const invoke = vi.fn(async () => value);
      const installer = createNativeCredentialInstaller({ provider: 'google', invoke });
      let error;
      try {
        await installer.installIfAbsent(args);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      assertNoPrivate(error.message);
      await expect(installer.installIfAbsent(args)).rejects.toThrow();
      expect(invoke).toHaveBeenCalledTimes(1);
    }
    const invoke = vi.fn(async () => {
      throw new Error(`FAKE_PRIVATE_NATIVE_ERROR ${REFRESH}`);
    });
    const installer = createNativeCredentialInstaller({ provider: 'google', invoke });
    await expect(installer.installIfAbsent(args)).rejects.not.toThrow('FAKE_PRIVATE_NATIVE_ERROR');
  });

  it('ошибка или расхождение при повторном чтении не превращаются в успех', async () => {
    const args = fixture();
    const invoke = vi.fn(async command =>
      command === 'cloud_credential_install'
        ? { status: 'installed' }
        : { status: 'ready', slotId: SLOT, record: `${args.record} ` }
    );
    const installer = createNativeCredentialInstaller({ provider: 'google', invoke });
    expect(await installer.installIfAbsent(args)).toBe('installed');
    expect(await installer.verifyInstallation(args)).toBe(false);
    await expect(installer.verifyInstallation(args)).rejects.toThrow();
  });

  it('таймаут записи блокирует повтор даже после позднего результата IPC', async () => {
    const gate = deferred();
    const invoke = vi.fn(() => gate.promise);
    const installer = createNativeCredentialInstaller({ provider: 'yandex', invoke, timeoutMs: 20 });
    const args = fixture('yandex');
    const request = installer.installIfAbsent(args);
    await expect(request).rejects.toThrow();
    gate.resolve({ status: 'installed' });
    await Promise.resolve();
    await expect(installer.installIfAbsent(args)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('локальный статус не выдаёт идентификатор или токен и не маскирует повреждение', async () => {
    const n = native();
    const args = fixture();
    n.slots.set('google', { status: 'ready', slotId: SLOT, record: pending(args.record) });
    const status = await inspectNativeCredential({ provider: 'google', invoke: n.invoke });
    expect(status).toEqual({ status: 'pending' });
    assertNoPrivate(status);
    n.slots.set('google', { status: 'ready', slotId: REV3, record: args.record });
    expect(await inspectNativeCredential({ provider: 'google', invoke: n.invoke })).toEqual({ status: 'blocked' });
    n.slots.set('google', { status: 'ready', slotId: SLOT, record: 'broken' });
    await expect(inspectNativeCredential({ provider: 'google', invoke: n.invoke })).rejects.toThrow();
  });
});

describe('экспериментальный Google CAS через поддельный IPC', () => {
  it('читает сохранённый pin и допускает только переход ready → pending → ready', async () => {
    const n = native();
    const args = fixture();
    const inst = createNativeCredentialInstaller({ provider: 'google', invoke: n.invoke });
    expect(await inst.installIfAbsent(args)).toBe('installed');
    expect(await inst.verifyInstallation(args)).toBe(true);
    const { record: _record, ...binding } = args;
    const store = createNativeGoogleCredentialStore({ ...binding, invoke: n.invoke });
    expect(await store.read()).toBe(args.record);
    const p = pending(args.record);
    const next = nextReady(p);
    expect(await store.compareExchange(args.record, p)).toBe('swapped');
    expect(await store.read()).toBe(p);
    expect(await store.compareExchange(p, next)).toBe('swapped');
    expect(await store.read()).toBe(next);
  });

  it('отклоняет лишние аргументы, смену аккаунта, повторные ревизии и замену готового токена до IPC', async () => {
    const n = native();
    const args = fixture();
    expect(() => createNativeGoogleCredentialStore({ ...args, invoke: n.invoke })).toThrow();
    const { record, ...binding } = args;
    const store = createNativeGoogleCredentialStore({ ...binding, invoke: n.invoke });
    const p = pending(record);
    for (const candidate of [
      nextReady(p),
      p.replace(ACCOUNT, 'OTHER'),
      p.replace(REV2, REV1),
      p.replace(ATTEMPT, REV1)
    ])
      await expect(store.compareExchange(record, candidate)).rejects.toThrow();
    expect(n.invoke).not.toHaveBeenCalled();
  });

  it('ошибка или потерянный ответ CAS блокирует чтение и повтор; ошибки скрыты', async () => {
    const args = fixture();
    const { record, ...binding } = args;
    const invoke = vi.fn(async () => {
      throw new Error(`FAKE_PRIVATE_NATIVE_ERROR ${REFRESH}`);
    });
    const store = createNativeGoogleCredentialStore({ ...binding, invoke });
    let error;
    try {
      await store.compareExchange(record, pending(record));
    } catch (caught) {
      error = caught;
    }
    assertNoPrivate(error.message);
    await expect(store.compareExchange(record, pending(record))).rejects.toThrow();
    await expect(store.read()).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('не допускает перекрытие чтения и записи в одном экземпляре', async () => {
    const gate = deferred();
    const invoke = vi.fn(() => gate.promise);
    const { record, ...binding } = fixture();
    const store = createNativeGoogleCredentialStore({ ...binding, invoke });
    const reading = store.read();
    await expect(store.compareExchange(record, pending(record))).rejects.toThrow();
    gate.resolve({ status: 'ready', slotId: SLOT, record });
    expect(await reading).toBe(record);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('mismatch не повторяет запись и не блокирует следующее ручное чтение', async () => {
    const { record, ...binding } = fixture();
    const invoke = vi.fn(async command =>
      command === 'cloud_credential_compare_exchange'
        ? { status: 'mismatch' }
        : { status: 'ready', slotId: SLOT, record }
    );
    const store = createNativeGoogleCredentialStore({ ...binding, invoke });
    expect(await store.compareExchange(record, pending(record))).toBe('mismatch');
    expect(await store.read()).toBe(record);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('явное локальное забывание', () => {
  it('требует отдельного подтверждения и не вызывает сетевые команды', async () => {
    const n = native();
    await expect(forgetNativeCredential({ provider: 'yandex', invoke: n.invoke, confirmed: false })).rejects.toThrow();
    expect(n.invoke).not.toHaveBeenCalled();
    expect(await forgetNativeCredential({ provider: 'yandex', invoke: n.invoke, confirmed: true })).toBe(true);
    expect(n.invoke).toHaveBeenCalledOnce();
    expect(n.invoke).toHaveBeenCalledWith('cloud_credential_forget', { provider: 'yandex', confirmed: true });
  });
});

describe('проверяемое локальное отключение без pin набора', () => {
  it.each(['google', 'yandex'])(
    '%s: отправляет только подтверждение и проверенный slot, не токены и не ключ',
    async provider => {
      for (const status of ['forgotten', 'blocked', 'mismatch']) {
        const invoke = vi.fn(async () => ({ status }));
        expect(await forgetUnboundNativeCredential({ provider, slotId: SLOT, invoke, confirmed: true })).toBe(status);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith('cloud_credential_forget_if_unbound', {
          provider,
          expectedSlot: SLOT,
          confirmed: true
        });
        assertNoPrivate(invoke.mock.calls);
      }
    }
  );

  it('без явного подтверждения и при неверных аргументах не вызывает IPC', async () => {
    const invoke = vi.fn();
    const args = { provider: 'google', slotId: SLOT, invoke, confirmed: true };
    for (const input of [
      { ...args, confirmed: false },
      { ...args, provider: 'other' },
      { ...args, slotId: `${SLOT}\n` },
      { ...args, slotId: 'not-a-uuid' },
      { ...args, timeoutMs: 1 }
    ]) {
      await expect(forgetUnboundNativeCredential(input)).rejects.toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ошибка, таймаут и неожиданный ответ не раскрывают секреты и не вызывают повтор', async () => {
    const args = { provider: 'google', slotId: SLOT, confirmed: true, timeoutMs: 20 };
    for (const invoke of [
      vi.fn(async () => ({ status: 'forgotten', record: REFRESH })),
      vi.fn(async () => ({ status: 'empty' })),
      vi.fn(async () => {
        throw new Error(`PRIVATE_ERROR ${REFRESH}`);
      }),
      vi.fn(() => new Promise(() => {}))
    ]) {
      let error;
      try {
        await forgetUnboundNativeCredential({ ...args, invoke });
      } catch (value) {
        error = value;
      }
      expect(error).toBeInstanceOf(Error);
      assertNoPrivate(String(error));
      expect(invoke).toHaveBeenCalledOnce();
    }
  });
});
