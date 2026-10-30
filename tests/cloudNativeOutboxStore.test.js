import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generateRecoveryKey, generateSyncId, encryptSnapshot } from '../js/modules/cloudSync/envelope.js';
import { createNativeOutboxStore } from '../js/modules/cloudSync/providers/nativeOutboxStore.js';

const cryptoSource = webcrypto;
const id = () => generateSyncId(cryptoSource);
const digest = raw => createHash('sha256').update(raw).digest('hex');
let slotId, datasetId, deviceId, revisionId, dataKey, record;

function args(extra = {}) {
  return { slotId, datasetId, deviceId, revisionId, record, ...extra };
}
function ipc() {
  let state = { status: 'empty' };
  const invoke = vi.fn(async (command, input) => {
    if (command === 'cloud_outbox_read') return structuredClone(state);
    if (command === 'cloud_outbox_install_initial') {
      if (state.status !== 'empty') return { status: 'occupied' };
      const { slotId, datasetId, deviceId, revisionId, record } = input.args;
      state = { status: 'ready', slotId, datasetId, deviceId, revisionId, record, sha256: digest(record) };
      return { status: 'installed' };
    }
    if (command === 'cloud_outbox_compare_exchange') {
      const next = input.args;
      if (state.status !== 'ready') return { status: 'blocked' };
      if (next.expectedRevisionId !== state.revisionId || next.expectedSha256 !== state.sha256)
        return { status: 'mismatch' };
      const { slotId, datasetId, deviceId, revisionId, record } = next;
      state = { status: 'ready', slotId, datasetId, deviceId, revisionId, record, sha256: digest(record) };
      return { status: 'swapped' };
    }
    throw new Error('unexpected test IPC');
  });
  return { invoke };
}

beforeEach(async () => {
  slotId = id();
  datasetId = id();
  deviceId = id();
  revisionId = id();
  dataKey = generateRecoveryKey(cryptoSource);
  record = JSON.stringify(
    await encryptSnapshot({
      snapshot: { private: 'ЛИЧНЫЕ ДАННЫЕ' },
      recoveryKey: dataKey,
      datasetId,
      versionId: revisionId,
      cryptoSource
    })
  );
});

it('старый native IPC создания без проверки привязок не зарегистрирован', () => {
  const registration = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const commands = readFileSync('src-tauri/src/commands/cloud_outbox.rs', 'utf8');
  expect(registration).not.toMatch(/commands::cloud_outbox::cloud_outbox_install\s*,/);
  expect(commands).not.toMatch(/pub\s+async\s+fn\s+cloud_outbox_install\s*\(/);
  expect(registration).toContain('commands::cloud_outbox::cloud_outbox_install_initial');
});

describe.each(['google', 'yandex'])('%s native IPC: адаптер журнала', provider => {
  it('вызывает только фиксированные команды и передаёт только зашифрованное тело', async () => {
    const fake = ipc();
    const guard = { accountSlotId: id(), keySlotId: id(), bundleId: id(), fingerprint: 'a'.repeat(64) };
    const store = createNativeOutboxStore({ provider, invoke: fake.invoke, initialGuard: guard });
    expect(await store.read()).toEqual({ status: 'empty' });
    expect(await store.install(args())).toEqual({ status: 'blocked' });
    expect(await store.installInitial(args())).toEqual({ status: 'installed' });
    const current = await store.read();
    expect(current).toEqual({ status: 'ready', ...args(), sha256: digest(record) });
    const nextId = id();
    const nextRecord = JSON.stringify(
      await encryptSnapshot({
        snapshot: { note: 'ДРУГАЯ ЛИЧНАЯ ЗАПИСЬ' },
        recoveryKey: dataKey,
        datasetId,
        versionId: nextId,
        cryptoSource
      })
    );
    expect(
      await store.compareExchange(
        args({ revisionId: nextId, record: nextRecord, expectedRevisionId: revisionId, expectedSha256: current.sha256 })
      )
    ).toEqual({ status: 'swapped' });
    expect((await store.read()).record).toBe(nextRecord);
    expect(fake.invoke.mock.calls.map(call => call[0])).toEqual([
      'cloud_outbox_read',
      'cloud_outbox_install_initial',
      'cloud_outbox_read',
      'cloud_outbox_compare_exchange',
      'cloud_outbox_read'
    ]);
    const requests = JSON.stringify(fake.invoke.mock.calls);
    expect(requests).not.toContain('ЛИЧНЫЕ ДАННЫЕ');
    expect(requests).not.toContain('ДРУГАЯ ЛИЧНАЯ ЗАПИСЬ');
    expect(requests).not.toContain(dataKey);
    expect(fake.invoke.mock.calls.every(call => call[1].provider === provider)).toBe(true);
  });

  it('для первого корня требует отдельную нативную проверку обеих очередей и привязок', async () => {
    const fake = ipc();
    const guard = { accountSlotId: id(), keySlotId: id(), bundleId: id(), fingerprint: 'a'.repeat(64) };
    const noGuard = createNativeOutboxStore({ provider, invoke: fake.invoke });
    expect(() => noGuard.installInitial(args())).toThrow();
    expect(fake.invoke).not.toHaveBeenCalled();
    const store = createNativeOutboxStore({ provider, invoke: fake.invoke, initialGuard: guard });
    guard.fingerprint = 'b'.repeat(64);
    expect(await store.installInitial(args())).toEqual({ status: 'installed' });
    expect(fake.invoke).toHaveBeenCalledWith('cloud_outbox_install_initial', {
      provider,
      args: args(),
      guard: { ...guard, fingerprint: 'a'.repeat(64) }
    });
    expect(await store.read()).toMatchObject({ status: 'ready' });
    expect(() =>
      createNativeOutboxStore({ provider, invoke: fake.invoke, initialGuard: { ...guard, keySlotId: 'bad' } })
    ).toThrow();
  });

  it('не принимает лишние поля, повреждённый конверт, повторные ключи и неправильные ID', async () => {
    const invoke = vi.fn();
    const store = createNativeOutboxStore({ provider, invoke });
    expect(() => store.install(args({ extra: 'PRIVATE' }))).toThrow();
    expect(() => store.install(args({ slotId: datasetId }))).toThrow();
    expect(() => store.install(args({ revisionId: 'bad-id' }))).toThrow();
    expect(() => store.install(args({ record: '{"private":"ЛИЧНОЕ"}' }))).toThrow();
    expect(() => store.install(args({ record: ` ${record}` }))).toThrow();
    expect(() => store.install(args({ record: record.replace('{', '{"version":1,') }))).toThrow();
    expect(() =>
      store.compareExchange(args({ expectedRevisionId: revisionId, expectedSha256: 'a'.repeat(64) }))
    ).toThrow();
    expect(() => store.compareExchange(args({ expectedRevisionId: id(), expectedSha256: 'bad' }))).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('после ошибки или потерянного ответа не повторяет неизвестную запись', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('PRIVATE путь и содержимое');
    });
    const guard = { accountSlotId: id(), keySlotId: id(), bundleId: id(), fingerprint: 'a'.repeat(64) };
    const store = createNativeOutboxStore({ provider, invoke, initialGuard: guard });
    await expect(store.installInitial(args())).rejects.not.toThrow('PRIVATE');
    await expect(store.read()).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('таймаут не объявляет native-запись отменённой и запрещает работу экземпляра', async () => {
    const invoke = vi.fn(() => new Promise(() => {}));
    const guard = { accountSlotId: id(), keySlotId: id(), bundleId: id(), fingerprint: 'a'.repeat(64) };
    const store = createNativeOutboxStore({ provider, invoke, timeoutMs: 20, initialGuard: guard });
    await expect(store.installInitial(args())).rejects.toThrow();
    await expect(store.read()).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('не принимает лишние данные или некорректный результат native-команды', async () => {
    const invoke = vi.fn(async () => ({ status: 'empty', record: 'PRIVATE' }));
    const store = createNativeOutboxStore({ provider, invoke });
    await expect(store.read()).rejects.not.toThrow('PRIVATE');
    await expect(store.read()).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('не блокирует экземпляр при подтверждённом конфликте CAS', async () => {
    const invoke = vi.fn(async command =>
      command === 'cloud_outbox_compare_exchange' ? { status: 'mismatch' } : { status: 'empty' }
    );
    const store = createNativeOutboxStore({ provider, invoke });
    expect(await store.compareExchange(args({ expectedRevisionId: id(), expectedSha256: 'a'.repeat(64) }))).toEqual({
      status: 'mismatch'
    });
    expect(await store.read()).toEqual({ status: 'empty' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
