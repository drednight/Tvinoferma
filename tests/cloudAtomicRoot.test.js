import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { sealHistoryVersion } from '../js/modules/cloudSync/history.js';
import { createDurableCloudOutbox } from '../js/modules/cloudSync/durableOutbox.js';

const cryptoSource = webcrypto;
const id = () => generateSyncId(cryptoSource);
const datasetId = id();
const clientIds = {
  google: '123456789-fake_client.apps.googleusercontent.com',
  yandex: '0123456789abcdef0123456789abcdef'
};
let keys, root, otherRoot, child, legacy;

beforeAll(async () => {
  keys = await createKeyBundle({
    datasetId,
    primary: { kind: 'password', secret: 'Синтетический пароль для корня 123!' },
    backup: { kind: 'generated' },
    cryptoSource
  });
  const { ui, ...state } = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero', nick: 'ЛИЧНЫЙ ПЕРСОНАЖ', notes: 'ЛИЧНАЯ ЗАМЕТКА' }]
  });
  const publicSnapshot = buildPublicSnapshot(planSyncIdentities({ snapshot: state, cryptoSource }).snapshot);
  async function seal(parent, portable = true) {
    return sealHistoryVersion({
      publicSnapshot,
      parent,
      recoveryKey: keys.dataKey,
      datasetId,
      versionId: id(),
      ...(portable ? { keyBundle: keys.bundle, keyPin: keys.pin } : {}),
      cryptoSource
    });
  }
  root = await seal(null);
  otherRoot = await seal(null);
  child = await seal(root.pin);
  legacy = await seal(null, false);
}, 30_000);

// Только синтетическое CAS в памяти. Не заменяет проверку Windows и устойчивости при сбое.
function makeStore({ loseInstallResponse = false } = {}) {
  let state = { status: 'empty' };
  return {
    read: vi.fn(async () => structuredClone(state)),
    install: vi.fn(async ({ slotId, datasetId, deviceId, revisionId, record }) => {
      if (state.status !== 'empty') return { status: 'occupied' };
      state = {
        status: 'ready',
        slotId,
        datasetId,
        deviceId,
        revisionId,
        record,
        sha256: createHash('sha256').update(record).digest('hex')
      };
      if (loseInstallResponse) throw new Error('FAKE LOST RESPONSE');
      return { status: 'installed' };
    }),
    installInitial: vi.fn(async function (args) {
      return this.install(args);
    }),
    compareExchange: vi.fn(async ({ expectedRevisionId, expectedSha256, revisionId, record }) => {
      if (state.status !== 'ready' || state.revisionId !== expectedRevisionId || state.sha256 !== expectedSha256)
        return { status: 'mismatch' };
      state = { ...state, revisionId, record, sha256: createHash('sha256').update(record).digest('hex') };
      return { status: 'swapped' };
    }),
    raw: () => structuredClone(state)
  };
}
function setup(provider, store = makeStore(), dataKey = keys.dataKey) {
  const deviceId = id();
  const slotId = id();
  const session = {
    generateFileId: vi.fn(async () => ({ status: 'generated', fileId: 'TEST_FILE_ID' })),
    upload: vi.fn(async () => ({ status: 'accepted' })),
    verify: vi.fn(async () => ({ status: 'verified' }))
  };
  const open = () =>
    createDurableCloudOutbox({
      provider,
      clientId: clientIds[provider],
      accountKey: 'FAKE_ACCOUNT_ID',
      datasetId,
      deviceId,
      slotId,
      dataKey,
      store,
      session,
      cryptoSource,
      ...(provider === 'google' ? { folderId: 'root' } : {})
    });
  return { open, store, session };
}

describe.each(['google', 'yandex'])('%s: атомарная подготовка корня', provider => {
  it('сохраняет корень и намерение за один install; после перезапуска возвращает тот же pin без сети', async () => {
    const { open, store, session } = setup(provider);
    const first = open();
    await expect(first.initializeWithRoot(root.envelope, false)).rejects.toThrow();
    expect(await first.initializeWithRoot(root.envelope, true)).toEqual({ status: 'initialized', rootPin: root.pin });
    expect(store.install).toHaveBeenCalledTimes(1);
    expect(store.compareExchange).not.toHaveBeenCalled();
    expect(await open().pendingInitializationRoot(keys.pin)).toEqual({ status: 'ready', rootPin: root.pin });
    expect(await open().pendingInitializationRoot({ ...keys.pin, sha256: 'f'.repeat(64) })).toEqual({
      status: 'invalid_root'
    });
    expect(await open().initializeWithRoot(otherRoot.envelope, true)).toEqual({ status: 'already_initialized' });
    expect(await open().status()).toEqual({
      status: 'ready',
      counts: { queued: 1, prepared: 0, attempting: 0, confirmed: 0 }
    });
    const stored = JSON.stringify(store.raw());
    for (const secret of ['ЛИЧНЫЙ ПЕРСОНАЖ', 'ЛИЧНАЯ ЗАМЕТКА', 'FAKE_ACCOUNT_ID', keys.dataKey]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).not.toContain(root.envelope.ciphertext);
    expect(session.generateFileId).not.toHaveBeenCalled();
    expect(session.upload).not.toHaveBeenCalled();
  });

  it('после утерянного ответа не создаёт второй корень; новый экземпляр читает сохранённый', async () => {
    const { open, session } = setup(provider, makeStore({ loseInstallResponse: true }));
    const first = open();
    expect(await first.initializeWithRoot(root.envelope, true)).toEqual({ status: 'journal_uncertain' });
    expect(await first.initializeWithRoot(otherRoot.envelope, true)).toEqual({ status: 'journal_uncertain' });
    const restarted = open();
    expect(await restarted.pendingInitializationRoot(keys.pin)).toEqual({ status: 'ready', rootPin: root.pin });
    expect(await restarted.initializeWithRoot(otherRoot.envelope, true)).toEqual({ status: 'already_initialized' });
    expect(session.upload).not.toHaveBeenCalled();
  });

  it('два конкурирующих установщика не сохраняют два разных корня', async () => {
    const { open, store, session } = setup(provider);
    const outcomes = await Promise.all([
      open().initializeWithRoot(root.envelope, true),
      open().initializeWithRoot(otherRoot.envelope, true)
    ]);
    expect(outcomes.filter(value => value.status === 'initialized')).toHaveLength(1);
    expect(outcomes.every(value => ['initialized', 'changed', 'already_initialized'].includes(value.status))).toBe(
      true
    );
    const winningPin = outcomes.find(value => value.status === 'initialized').rootPin;
    expect(await open().pendingInitializationRoot(keys.pin)).toEqual({ status: 'ready', rootPin: winningPin });
    expect(store.install.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(store.install.mock.calls.length).toBeLessThanOrEqual(2);
    expect(session.upload).not.toHaveBeenCalled();
  });

  it('не принимает потомка, старый v1, чужой ключ или уже пустой журнал как новый корень', async () => {
    const { open, store, session } = setup(provider);
    const outbox = open();
    expect(await outbox.initializeWithRoot(child.envelope, true)).toEqual({ status: 'invalid_root' });
    await expect(outbox.initializeWithRoot(legacy.envelope, true)).rejects.toThrow();
    const foreign = setup(provider, makeStore(), generateRecoveryKey(cryptoSource));
    expect(await foreign.open().initializeWithRoot(root.envelope, true)).toEqual({ status: 'invalid_root' });
    expect(foreign.store.install).not.toHaveBeenCalled();
    expect(store.install).not.toHaveBeenCalled();
    expect(await outbox.initialize(true)).toEqual({ status: 'initialized' });
    expect(await open().pendingInitializationRoot(keys.pin)).toEqual({ status: 'not_initial_root' });
    expect(await open().initializeWithRoot(root.envelope, true)).toEqual({ status: 'already_initialized' });
    expect(session.upload).not.toHaveBeenCalled();
  });

  it('не позволяет продолжить первичную привязку после начатой отправки', async () => {
    const { open, session } = setup(provider);
    const outbox = open();
    expect((await outbox.initializeWithRoot(root.envelope, true)).status).toBe('initialized');
    expect(await outbox.sendNext()).toEqual({ status: 'needs_verification' });
    expect(await open().pendingInitializationRoot(keys.pin)).toEqual({ status: 'not_initial_root' });
    expect(session.upload).toHaveBeenCalledTimes(1);
  });
});
