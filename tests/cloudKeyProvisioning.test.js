// Только синтетический IPC: WebCrypto/scrypt настоящие, ОС и диск поддельные.
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createKeyProvisioner } from '../js/modules/cloudSync/keyProvisioning.js';
import { createNativeKeyStateStore } from '../js/modules/cloudSync/providers/nativeKeyStateStore.js';
import { createKeyStateRecord, parseKeyStateRecord } from '../js/modules/cloudSync/keyStateRecord.js';
import {
  openKeyBundle,
  rewrapKeyBundleFromDataKey,
  verifyKeyBundleDataKey
} from '../js/modules/cloudSync/keyBundle.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';

const cryptoSource = webcrypto;
const primary = { kind: 'password', secret: 'Синтетический пароль для проверки 135!' };
const customBackup = { kind: 'custom', secret: 'Синтетический запасной ключ 97531!' };
function fakeIPC() {
  let current = null;
  let failAfterInstall = false;
  const invoke = vi.fn(async (command, args) => {
    if (command === 'cloud_key_state_read') {
      if (!current) return { status: 'empty' };
      return { status: 'ready', slotId: current.slotId, record: current.record };
    }
    if (command === 'cloud_key_state_install') {
      if (current) return { status: 'occupied' };
      current = { slotId: args.slotId, record: args.record };
      if (failAfterInstall) throw new Error('PRIVATE lost response');
      return { status: 'installed' };
    }
    if (command === 'cloud_key_state_compare_exchange') {
      if (!current || current.slotId !== args.slotId || current.record !== args.expected) return { status: 'mismatch' };
      current.record = args.next;
      return { status: 'swapped' };
    }
    if (command === 'cloud_key_state_forget' && args.confirmed === true) {
      current = null;
      return { status: 'forgotten' };
    }
    throw new Error('PRIVATE unexpected command');
  });
  return {
    invoke,
    loseInstallResponse() {
      failAfterInstall = true;
    },
    corrupt(transform) {
      current.record = transform(current.record);
    },
    record() {
      return current?.record ?? null;
    }
  };
}
function store(ipc) {
  return createNativeKeyStateStore({ invoke: ipc.invoke, cryptoSource });
}

async function prepare(ipc, backup = { kind: 'generated' }) {
  const native = store(ipc);
  const provisioner = createKeyProvisioner({ store: native, cryptoSource });
  const attempt = await provisioner.begin({ primary, backup, newDatasetConfirmed: true });
  expect(attempt.status).toBe('prepared');
  return { native, provisioner, attempt };
}

describe('локальная подготовка ключа (без диска и UI)', () => {
  it('требует отдельное сохранение и повторный ввод backup до защищённой установки', async () => {
    const ipc = fakeIPC();
    const { native, provisioner, attempt } = await prepare(ipc);
    expect(attempt.generatedBackupSecret).toMatch(/^TFB1-/);
    expect(await attempt.confirmBackup({ secret: attempt.generatedBackupSecret, savedSeparately: false })).toEqual({
      status: 'confirmation_required'
    });
    expect(
      await attempt.confirmBackup({ secret: 'неверный синтетический запасной ключ', savedSeparately: true })
    ).toEqual({ status: 'invalid_backup' });
    expect(ipc.record()).toBeNull();
    await expect(
      provisioner.begin({ primary, backup: { kind: 'generated' }, newDatasetConfirmed: true })
    ).rejects.toThrow();
    expect(await attempt.confirmBackup({ secret: attempt.generatedBackupSecret, savedSeparately: true })).toEqual({
      status: 'installed'
    });
    expect(attempt.cancel()).toEqual({ status: 'closed' });
    const stored = await native.read();
    expect(stored.status).toBe('ready');
    expect(stored.state.datasetId).toBe(attempt.datasetId);
    expect(
      await verifyKeyBundleDataKey({
        bundle: stored.state.bundle,
        expectedDatasetId: stored.state.datasetId,
        expectedPin: stored.state.pin,
        dataKey: stored.state.dataKey,
        cryptoSource
      })
    ).toBe(true);
    const main = await openKeyBundle({
      bundle: stored.state.bundle,
      expectedDatasetId: stored.state.datasetId,
      expectedPin: stored.state.pin,
      role: 'main',
      secret: primary.secret,
      cryptoSource
    });
    const backup = await openKeyBundle({
      bundle: stored.state.bundle,
      expectedDatasetId: stored.state.datasetId,
      expectedPin: stored.state.pin,
      role: 'backup',
      secret: attempt.generatedBackupSecret,
      cryptoSource
    });
    expect(main.dataKey).toBe(stored.state.dataKey);
    expect(backup.dataKey).toBe(stored.state.dataKey);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'cloud_key_state_install')).toHaveLength(1);
    expect(await provisioner.begin({ primary, backup: { kind: 'generated' }, newDatasetConfirmed: true })).toEqual({
      status: 'already_configured'
    });
  }, 30_000);

  it('собственный backup можно отменить, без явного согласия запись даже не подготавливается', async () => {
    const ipc = fakeIPC();
    const native = store(ipc);
    const provisioner = createKeyProvisioner({ store: native, cryptoSource });
    await expect(provisioner.begin({ primary, backup: customBackup, newDatasetConfirmed: false })).rejects.toThrow();
    expect(ipc.invoke).not.toHaveBeenCalled();
    const attempt = await provisioner.begin({ primary, backup: customBackup, newDatasetConfirmed: true });
    expect(attempt.generatedBackupSecret).toBeNull();
    expect(attempt.cancel()).toEqual({ status: 'cancelled' });
    await expect(attempt.confirmBackup({ secret: customBackup.secret, savedSeparately: true })).rejects.toThrow();
    expect(ipc.record()).toBeNull();
  }, 30_000);

  it('потерянный ответ установки не повторяет запись и допускает проверку после нового открытия', async () => {
    const ipc = fakeIPC();
    ipc.loseInstallResponse();
    const { native, attempt } = await prepare(ipc, customBackup);
    expect(await attempt.confirmBackup({ secret: customBackup.secret, savedSeparately: true })).toEqual({
      status: 'installation_uncertain'
    });
    await expect(native.read()).rejects.not.toThrow('PRIVATE');
    const reopened = await store(ipc).read();
    expect(reopened.status).toBe('ready');
    expect(reopened.state.datasetId).toBe(attempt.datasetId);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'cloud_key_state_install')).toHaveLength(1);
  }, 30_000);

  it('перепривязка меняет обёртки, но не внутренний ключ; устаревший CAS не перезаписывает данные', async () => {
    const ipc = fakeIPC();
    const { native, attempt } = await prepare(ipc, customBackup);
    expect(await attempt.confirmBackup({ secret: customBackup.secret, savedSeparately: true })).toEqual({
      status: 'installed'
    });
    const before = await native.read();
    const changed = await rewrapKeyBundleFromDataKey({
      bundle: before.state.bundle,
      expectedDatasetId: before.state.datasetId,
      expectedPin: before.state.pin,
      dataKey: before.state.dataKey,
      primary: { kind: 'custom', secret: 'Другая основная фраза 874321!' },
      backup: { kind: 'custom', secret: 'Другая запасная фраза 135798!' },
      cryptoSource
    });
    const next = { ...before.state, revision: generateSyncId(cryptoSource), bundle: changed.bundle, pin: changed.pin };
    expect(await native.compareExchange({ expected: before.raw, next })).toEqual({ status: 'swapped' });
    expect(await native.compareExchange({ expected: before.raw, next })).toEqual({ status: 'mismatch' });
    const after = await native.read();
    expect(after.state.dataKey).toBe(before.state.dataKey);
    expect(after.state.bundle.bundleId).not.toBe(before.state.bundle.bundleId);
    await expect(
      native.compareExchange({
        expected: after.raw,
        next: { ...next, dataKey: 'TF1-' + 'A'.repeat(43), revision: generateSyncId(cryptoSource) }
      })
    ).rejects.toThrow();
  }, 30_000);

  it('отмена во время проверки backup не начинает установку', async () => {
    const ipc = fakeIPC();
    const { attempt } = await prepare(ipc, customBackup);
    const confirming = attempt.confirmBackup({ secret: customBackup.secret, savedSeparately: true });
    expect(attempt.cancel()).toEqual({ status: 'cancelled' });
    expect(await confirming).toEqual({ status: 'cancelled' });
    expect(ipc.record()).toBeNull();
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'cloud_key_state_install')).toHaveLength(0);
  }, 30_000);

  it('отмена во время установки не выдаёт ложной отмены и не повторяет запись', async () => {
    let releaseInstall;
    let announceInstall;
    let raw = null;
    const started = new Promise(resolve => {
      announceInstall = resolve;
    });
    const gate = new Promise(resolve => {
      releaseInstall = resolve;
    });
    const protectedStore = {
      read: vi.fn(async () => (raw === null ? { status: 'empty' } : { status: 'ready', raw })),
      install: vi.fn(async value => {
        raw = (await createKeyStateRecord(value, cryptoSource)).raw;
        announceInstall();
        await gate;
        return { status: 'installed' };
      })
    };
    const provisioner = createKeyProvisioner({ store: protectedStore, cryptoSource });
    const attempt = await provisioner.begin({ primary, backup: customBackup, newDatasetConfirmed: true });
    const confirming = attempt.confirmBackup({ secret: customBackup.secret, savedSeparately: true });
    await started;
    expect(attempt.cancel()).toEqual({ status: 'installation_in_progress' });
    releaseInstall();
    expect(await confirming).toEqual({ status: 'installed' });
    expect(protectedStore.install).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('сбой контрольного чтения после записи возвращает неизвестный результат без автоматического повтора', async () => {
    let reads = 0;
    const protectedStore = {
      read: vi.fn(async () => {
        if (++reads === 1) return { status: 'empty' };
        throw new Error('PRIVATE readback');
      }),
      install: vi.fn(async () => ({ status: 'installed' }))
    };
    const provisioner = createKeyProvisioner({ store: protectedStore, cryptoSource });
    const attempt = await provisioner.begin({ primary, backup: customBackup, newDatasetConfirmed: true });
    expect(await attempt.confirmBackup({ secret: customBackup.secret, savedSeparately: true })).toEqual({
      status: 'installation_uncertain'
    });
    expect(protectedStore.install).toHaveBeenCalledTimes(1);
    await expect(attempt.confirmBackup({ secret: customBackup.secret, savedSeparately: true })).rejects.toThrow();
  }, 30_000);

  it('повреждённые, перепривязанные и неканонические записи не становятся готовыми', async () => {
    const ipc = fakeIPC();
    const { native, attempt } = await prepare(ipc, customBackup);
    await attempt.confirmBackup({ secret: customBackup.secret, savedSeparately: true });
    const ready = await native.read();
    const parsed = await parseKeyStateRecord(ready.raw, cryptoSource);
    expect(parsed.raw).toBe(ready.raw);
    const wrong = JSON.parse(ready.raw);
    wrong.dataKey = 'TF1-' + 'A'.repeat(43);
    await expect(parseKeyStateRecord(JSON.stringify(wrong), cryptoSource)).rejects.not.toThrow(wrong.dataKey);
    await expect(parseKeyStateRecord(ready.raw + ' ', cryptoSource)).rejects.toThrow();
    await expect(
      createKeyStateRecord({ ...ready.state, datasetId: generateSyncId(cryptoSource) }, cryptoSource)
    ).rejects.toThrow();
    ipc.corrupt(raw => raw.replace('"version":1', '"version":2'));
    const fresh = store(ipc);
    await expect(fresh.read()).rejects.not.toThrow('PRIVATE');
    await expect(fresh.read()).rejects.toThrow();
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'cloud_key_state_forget')).toHaveLength(0);
  }, 30_000);
});
