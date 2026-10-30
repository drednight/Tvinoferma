import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import {
  encryptSnapshot,
  decryptSnapshot,
  generateRecoveryKey,
  generateSyncId
} from '../js/modules/cloudSync/envelope.js';
import { sealHistoryVersion } from '../js/modules/cloudSync/history.js';
import { createDurableCloudOutbox } from '../js/modules/cloudSync/durableOutbox.js';

const cryptoSource = webcrypto;
const id = () => generateSyncId(cryptoSource);
const digest = raw => createHash('sha256').update(raw).digest('hex');
const clientIds = {
  google: '123456789-fake_client.apps.googleusercontent.com',
  yandex: '0123456789abcdef0123456789abcdef'
};
let datasetId, deviceId, slotId, dataKey, publicSnapshot;

// Только тестовый кооперативный CAS в памяти. Он не имитирует Windows, fsync,
// повреждения файловой системы или устойчивость к откату и не подходит приложению.
function makeStore() {
  let state = { status: 'empty' };
  let swaps = 0;
  let failAt = null;
  let lostAt = null;
  return {
    async read() {
      return structuredClone(state);
    },
    async install({ slotId, datasetId, deviceId, revisionId, record }) {
      if (state.status === 'pending' || state.status === 'blocked') return { status: 'blocked' };
      if (state.status !== 'empty') return { status: 'occupied' };
      state = { status: 'ready', slotId, datasetId, deviceId, revisionId, sha256: digest(record), record };
      return { status: 'installed' };
    },
    async compareExchange({ slotId, datasetId, deviceId, expectedRevisionId, expectedSha256, revisionId, record }) {
      swaps++;
      if (state.status === 'pending' || state.status === 'blocked') return { status: 'blocked' };
      if (
        state.status !== 'ready' ||
        state.slotId !== slotId ||
        state.datasetId !== datasetId ||
        state.deviceId !== deviceId ||
        state.revisionId !== expectedRevisionId ||
        state.sha256 !== expectedSha256
      )
        return { status: 'mismatch' };
      if (swaps === failAt) {
        state = { status: 'pending' };
        throw new Error('PRIVATE failing write may have happened');
      }
      state = { status: 'ready', slotId, datasetId, deviceId, revisionId, sha256: digest(record), record };
      if (swaps === lostAt) throw new Error('PRIVATE response was lost after write');
      return { status: 'swapped' };
    },
    failSwap(number) {
      failAt = number;
    },
    loseSwapReply(number) {
      lostAt = number;
    },
    mutate(fn) {
      state = fn(structuredClone(state));
    },
    async raw() {
      return structuredClone(state);
    },
    getSwaps() {
      return swaps;
    }
  };
}
function makeSession(overrides = {}) {
  let allocated = 0;
  return {
    generateFileId: vi.fn(async () => ({
      status: 'generated',
      fileId: allocated++ === 0 ? 'allocated_TEST_ID' : `allocated_TEST_ID_${allocated}`
    })),
    upload: vi.fn(async () => ({ status: 'accepted' })),
    verify: vi.fn(async () => ({ status: 'verified' })),
    ...overrides
  };
}
function create(provider, store, session, overrides = {}) {
  return createDurableCloudOutbox({
    provider,
    datasetId,
    deviceId,
    slotId,
    clientId: clientIds[provider],
    accountKey: 'FAKE_PRIVATE_ACCOUNT_KEY',
    dataKey,
    store,
    session,
    cryptoSource,
    ...(provider === 'google' ? { folderId: 'FAKE_PRIVATE_FOLDER_ID' } : {}),
    ...overrides
  });
}
async function sealedVersion() {
  return sealHistoryVersion({
    publicSnapshot,
    parent: null,
    datasetId,
    recoveryKey: dataKey,
    versionId: id(),
    cryptoSource
  });
}

// Меняет только синтетический journal, чтобы испытать миграцию и повреждения.
async function alterSyntheticJournal(store, change) {
  const current = await store.raw();
  const master = Buffer.from(dataKey.slice(4), 'base64url');
  const baseKey = await cryptoSource.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const bits = await cryptoSource.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('tvinoferma-durable-outbox-key-v1'),
      info: new TextEncoder().encode(JSON.stringify([datasetId, deviceId, slotId]))
    },
    baseKey,
    256
  );
  const journalKey = `TF1-${Buffer.from(bits).toString('base64url')}`;
  const state = await decryptSnapshot({
    envelope: JSON.parse(current.record),
    recoveryKey: journalKey,
    expectedDatasetId: datasetId,
    cryptoSource
  });
  change(state);
  const envelope = await encryptSnapshot({
    snapshot: state,
    recoveryKey: journalKey,
    datasetId,
    versionId: current.revisionId,
    cryptoSource
  });
  const record = JSON.stringify(envelope);
  store.mutate(previous => ({ ...previous, record, sha256: digest(record) }));
}

beforeEach(() => {
  datasetId = id();
  deviceId = id();
  slotId = id();
  dataKey = generateRecoveryKey(cryptoSource);
  const state = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero', nick: 'ЛИЧНЫЙ ПЕРСОНАЖ' }],
    plannerEntries: [{ id: 'task', title: 'ЛИЧНАЯ ЗАДАЧА', date: '2026-11-01', kind: 'task' }]
  });
  const { ui, ...snapshot } = state;
  publicSnapshot = buildPublicSnapshot(planSyncIdentities({ snapshot, cryptoSource }).snapshot);
});

describe.each(['google', 'yandex'])('%s: зашифрованный журнал и восстановление попытки', provider => {
  it('отдельно создаёт журнал, сохраняет версию и не раскрывает значения в хранилище', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await expect(outbox.initialize(false)).rejects.toThrow();
    expect(await outbox.status()).toEqual({ status: 'not_initialized' });
    expect(await outbox.initialize(true)).toEqual({ status: 'initialized' });
    expect(await outbox.initialize(true)).toEqual({ status: 'already_initialized' });
    const version = await sealedVersion();
    expect(await outbox.enqueue(version.envelope)).toEqual({ status: 'queued' });
    expect(await outbox.enqueue(version.envelope)).toEqual({ status: 'duplicate' });
    expect(await outbox.status()).toEqual({
      status: 'ready',
      counts: { queued: 1, prepared: 0, attempting: 0, confirmed: 0 }
    });
    const stored = JSON.stringify(await store.raw());
    for (const secret of ['ЛИЧНЫЙ ПЕРСОНАЖ', 'ЛИЧНАЯ ЗАДАЧА', 'FAKE_PRIVATE_ACCOUNT_KEY', dataKey]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).not.toContain(version.envelope.ciphertext);
    expect(session.upload).not.toHaveBeenCalled();
  });

  it('сохраняет намерение до отправки, после рестарта не повторяет POST и подтверждает только точной сверкой', async () => {
    const store = makeStore();
    let second;
    const session = makeSession({
      upload: vi.fn(async () => {
        // Другой экземпляр видит зафиксированную попытку ещё ДО вызова сети.
        expect(await second.status()).toEqual({
          status: 'ready',
          counts: { queued: 0, prepared: 0, attempting: 1, confirmed: 0 }
        });
        throw new Error('PRIVATE network response lost');
      }),
      verify: vi.fn(async () => ({ status: 'not_found' }))
    });
    const first = create(provider, store, session);
    second = create(provider, store, session);
    expect(await first.initialize(true)).toEqual({ status: 'initialized' });
    const version = await sealedVersion();
    expect(await first.enqueue(version.envelope)).toEqual({ status: 'queued' });
    expect(await first.sendNext()).toEqual({ status: 'needs_verification' });
    expect(session.upload).toHaveBeenCalledTimes(1);
    expect(session.upload.mock.calls[0][0]).toEqual({
      envelope: version.envelope,
      ...(provider === 'google' ? { fileId: 'allocated_TEST_ID' } : {})
    });
    if (provider === 'google') expect(session.generateFileId).toHaveBeenCalledTimes(1);
    else expect(session.generateFileId).not.toHaveBeenCalled();
    const afterRestart = create(provider, store, session);
    expect(await afterRestart.sendNext()).toEqual({ status: 'needs_verification' });
    expect(await afterRestart.verifyNext()).toEqual({ status: 'unavailable' });
    expect(session.upload).toHaveBeenCalledTimes(1);
    session.verify.mockResolvedValue({ status: 'verified' });
    expect(await afterRestart.verifyNext()).toEqual({ status: 'confirmed' });
    expect(await afterRestart.status()).toEqual({
      status: 'ready',
      counts: { queued: 0, prepared: 0, attempting: 0, confirmed: 1 }
    });
    expect(await afterRestart.sendNext()).toEqual({ status: 'idle' });
    // Подтверждённая версия пока остаётся в журнале, не удаляется по ответу сервиса.
    expect((await store.raw()).record).toBeTruthy();
    expect(session.upload).toHaveBeenCalledTimes(1);
  });

  it('повторяет позже только подтверждённо не начавшуюся запись, сохраняя прежний ID файла', async () => {
    const store = makeStore();
    const session = makeSession({
      upload: vi.fn().mockResolvedValueOnce({ status: 'not_sent' }).mockResolvedValueOnce({ status: 'accepted' })
    });
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const version = await sealedVersion();
    await outbox.enqueue(version.envelope);
    expect(await outbox.sendNext()).toEqual({ status: 'deferred' });
    expect((await outbox.status()).counts).toEqual({ queued: 0, prepared: 1, attempting: 0, confirmed: 0 });
    expect(await create(provider, store, session).sendNext()).toEqual({ status: 'needs_verification' });
    expect(session.upload).toHaveBeenCalledTimes(2);
    if (provider === 'google') {
      expect(session.generateFileId).toHaveBeenCalledTimes(1);
      expect(session.upload.mock.calls[0][0].fileId).toBe('allocated_TEST_ID');
      expect(session.upload.mock.calls[1][0].fileId).toBe('allocated_TEST_ID');
    }
    expect(await outbox.sendNext()).toEqual({ status: 'needs_verification' });
    expect(session.upload).toHaveBeenCalledTimes(2);
  });

  it('занятую цель не считает подтверждённым отсутствием записи и не повторяет отправку', async () => {
    const store = makeStore();
    const session = makeSession({ upload: vi.fn(async () => ({ status: 'conflict' })) });
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const version = await sealedVersion();
    await outbox.enqueue(version.envelope);
    expect(await outbox.sendNext()).toEqual({ status: 'needs_verification' });
    expect(await create(provider, store, session).sendNext()).toEqual({ status: 'needs_verification' });
    expect(session.upload).toHaveBeenCalledTimes(1);
  });

  it('повреждение контрольной отметки или неподходящий ключ блокируют отправку', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const version = await sealedVersion();
    await outbox.enqueue(version.envelope);
    const wrongKey = create(provider, store, session, { dataKey: generateRecoveryKey(cryptoSource) });
    expect(await wrongKey.sendNext()).toEqual({ status: 'journal_blocked' });
    expect(session.upload).not.toHaveBeenCalled();
    store.mutate(value => ({ ...value, sha256: 'a'.repeat(64) }));
    const changed = create(provider, store, session);
    expect(await changed.sendNext()).toEqual({ status: 'journal_blocked' });
    expect(await changed.sendNext()).toEqual({ status: 'journal_uncertain' });
    expect(session.upload).not.toHaveBeenCalled();
  });

  it('не принимает конверт с другим ключом или неподходящим содержимым', async () => {
    const store = makeStore();
    const outbox = create(provider, store, makeSession());
    await outbox.initialize(true);
    const otherKeyEnvelope = await encryptSnapshot({
      snapshot: { format: 'not-history', private: 'ЛИЧНОЕ' },
      recoveryKey: generateRecoveryKey(cryptoSource),
      datasetId,
      versionId: id(),
      cryptoSource
    });
    expect(await outbox.enqueue(otherKeyEnvelope)).toEqual({ status: 'invalid_version' });
    const unrelated = await encryptSnapshot({
      snapshot: { format: 'not-history', private: 'ЛИЧНОЕ' },
      recoveryKey: dataKey,
      datasetId,
      versionId: id(),
      cryptoSource
    });
    expect(await outbox.enqueue(unrelated)).toEqual({ status: 'invalid_version' });
    expect((await outbox.status()).counts.queued).toBe(0);
  });

  it('при неизвестном исходе записи попытки не начинает сеть ни до, ни после перезапуска', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const version = await sealedVersion();
    await outbox.enqueue(version.envelope);
    // После enqueue: prepared — следующий swap, attempting — ещё один.
    store.failSwap(store.getSwaps() + 2);
    expect(await outbox.sendNext()).toEqual({ status: 'journal_uncertain' });
    expect(session.upload).not.toHaveBeenCalled();
    expect(await outbox.sendNext()).toEqual({ status: 'journal_uncertain' });
    expect(await create(provider, store, session).sendNext()).toEqual({ status: 'journal_blocked' });
    expect(session.upload).not.toHaveBeenCalled();
  });

  it('утерянный ответ после сохранения попытки не приводит к повтору сети', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const version = await sealedVersion();
    await outbox.enqueue(version.envelope);
    store.loseSwapReply(store.getSwaps() + 2);
    expect(await outbox.sendNext()).toEqual({ status: 'journal_uncertain' });
    expect(session.upload).not.toHaveBeenCalled();
    const afterRestart = create(provider, store, session);
    expect(await afterRestart.sendNext()).toEqual({ status: 'needs_verification' });
    expect(session.upload).not.toHaveBeenCalled();
  });

  it('конкурирующие экземпляры CAS не отправляют одну и ту же версию дважды', async () => {
    const store = makeStore();
    const session = makeSession();
    const a = create(provider, store, session);
    const b = create(provider, store, session);
    await a.initialize(true);
    const version = await sealedVersion();
    await a.enqueue(version.envelope);
    const results = await Promise.all([a.sendNext(), b.sendNext()]);
    expect(results.some(result => result.status === 'needs_verification')).toBe(true);
    expect(session.upload).toHaveBeenCalledTimes(1);
    expect(['changed', 'needs_verification', 'journal_uncertain']).toContain(
      results.find(result => result.status !== 'needs_verification')?.status ?? 'needs_verification'
    );
    expect(await create(provider, store, session).sendNext()).toEqual({ status: 'needs_verification' });
    expect(session.upload).toHaveBeenCalledTimes(1);
  });

  it('сворачивает подтверждённые версии, сохраняя пины и защиту от повторного enqueue после рестарта', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const versions = [];
    for (let i = 0; i < 16; i++) {
      const version = await sealedVersion();
      versions.push(version);
      expect(await outbox.enqueue(version.envelope)).toEqual({ status: 'queued' });
      expect(await outbox.sendNext()).toEqual({ status: 'needs_verification' });
      expect(await outbox.verifyNext()).toEqual({ status: 'confirmed' });
    }
    const later = await sealedVersion();
    expect(await outbox.enqueue(later.envelope)).toEqual({ status: 'full' });
    expect(await outbox.confirmedPins()).toEqual({ status: 'ready', pins: versions.map(value => value.pin) });
    expect(await outbox.compactConfirmed()).toEqual({ status: 'compacted', count: 16 });
    const reopened = create(provider, store, session);
    expect(await reopened.status()).toEqual({
      status: 'ready',
      counts: { queued: 0, prepared: 0, attempting: 0, confirmed: 0 }
    });
    expect(await reopened.confirmedPins()).toEqual({ status: 'ready', pins: versions.map(value => value.pin) });
    expect(await reopened.enqueue(versions[0].envelope)).toEqual({ status: 'duplicate' });
    expect(await reopened.enqueue(later.envelope)).toEqual({ status: 'queued' });
    expect(await reopened.sendNext()).toEqual({ status: 'needs_verification' });
    expect(session.upload).toHaveBeenCalledTimes(17);
    const raw = JSON.stringify(await store.raw());
    expect(raw).not.toContain(versions[0].pin.sha256);
    expect(raw).not.toContain('FAKE_PRIVATE_ACCOUNT_KEY');
  });

  it('не сворачивает неподтверждённую попытку и не даёт повторить её после ошибки сверки', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const first = await sealedVersion();
    const second = await sealedVersion();
    await outbox.enqueue(first.envelope);
    await outbox.sendNext();
    await outbox.verifyNext();
    await outbox.enqueue(second.envelope);
    await outbox.sendNext();
    expect(await outbox.compactConfirmed()).toEqual({ status: 'compacted', count: 1 });
    const reopened = create(provider, store, session);
    expect(await reopened.confirmedPins()).toEqual({ status: 'ready', pins: [first.pin] });
    expect(await reopened.sendNext()).toEqual({ status: 'needs_verification' });
    expect(session.upload).toHaveBeenCalledTimes(2);
    expect((await reopened.status()).counts).toEqual({ queued: 0, prepared: 0, attempting: 1, confirmed: 0 });
  });

  it('не теряет пин при потерянном ответе на сворачивание и не повторяет передачу', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const version = await sealedVersion();
    await outbox.enqueue(version.envelope);
    await outbox.sendNext();
    await outbox.verifyNext();
    store.loseSwapReply(store.getSwaps() + 1);
    expect(await outbox.compactConfirmed()).toEqual({ status: 'journal_uncertain' });
    expect(await outbox.compactConfirmed()).toEqual({ status: 'journal_uncertain' });
    const reopened = create(provider, store, session);
    expect(await reopened.confirmedPins()).toEqual({ status: 'ready', pins: [version.pin] });
    expect(await reopened.compactConfirmed()).toEqual({ status: 'idle' });
    expect(await reopened.enqueue(version.envelope)).toEqual({ status: 'duplicate' });
    expect(session.upload).toHaveBeenCalledTimes(1);
  });

  it('конкурирующие сворачивания не теряют подтверждение и не вызывают сеть', async () => {
    const store = makeStore();
    const session = makeSession();
    const a = create(provider, store, session);
    const b = create(provider, store, session);
    await a.initialize(true);
    const version = await sealedVersion();
    await a.enqueue(version.envelope);
    await a.sendNext();
    await a.verifyNext();
    const outcomes = await Promise.all([a.compactConfirmed(), b.compactConfirmed()]);
    expect(outcomes.some(value => value.status === 'compacted')).toBe(true);
    expect(outcomes.every(value => ['compacted', 'changed', 'idle'].includes(value.status))).toBe(true);
    expect(await create(provider, store, session).confirmedPins()).toEqual({ status: 'ready', pins: [version.pin] });
    expect(session.upload).toHaveBeenCalledTimes(1);
  });

  it('читает старый v1 журнал и переводит его в v2 при следующей записи', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const version = await sealedVersion();
    await outbox.enqueue(version.envelope);
    await alterSyntheticJournal(store, state => {
      state.version = 1;
      delete state.confirmedReceipts;
    });
    const reopened = create(provider, store, session);
    expect((await reopened.status()).counts.queued).toBe(1);
    expect(await reopened.sendNext()).toEqual({ status: 'needs_verification' });
    expect(await reopened.verifyNext()).toEqual({ status: 'confirmed' });
    expect(await reopened.compactConfirmed()).toEqual({ status: 'compacted', count: 1 });
    expect(await reopened.confirmedPins()).toEqual({ status: 'ready', pins: [version.pin] });
    await alterSyntheticJournal(store, state => {
      expect(state.version).toBe(2);
      expect(state.confirmedReceipts).toHaveLength(1);
    });
  });

  it('дубликат ID в квитанции блокирует чтение до сети', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const version = await sealedVersion();
    await outbox.enqueue(version.envelope);
    await alterSyntheticJournal(store, state =>
      state.confirmedReceipts.push({
        ...version.pin,
        fileId: provider === 'google' ? 'FAKE_FILE' : null,
        attemptId: id()
      })
    );
    const reopened = create(provider, store, session);
    expect(await reopened.sendNext()).toEqual({ status: 'journal_blocked' });
    expect(session.upload).not.toHaveBeenCalled();
  });

  it('останавливается на пределе квитанций, не удаляя даже подтверждённый элемент', async () => {
    const store = makeStore();
    const session = makeSession();
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const version = await sealedVersion();
    await outbox.enqueue(version.envelope);
    await outbox.sendNext();
    await outbox.verifyNext();
    await alterSyntheticJournal(store, state => {
      state.confirmedReceipts = Array.from({ length: 128 }, (_, i) => ({
        versionId: id(),
        sha256: 'a'.repeat(64),
        fileId: provider === 'google' ? `FAKE_FILE_${i}` : null,
        attemptId: id()
      }));
    });
    const reopened = create(provider, store, session);
    expect(await reopened.compactConfirmed()).toEqual({ status: 'receipt_limit' });
    expect(await reopened.confirmedPins()).toEqual({ status: 'receipt_limit' });
    expect((await reopened.status()).counts.confirmed).toBe(1);
    expect(await reopened.enqueue(version.envelope)).toEqual({ status: 'duplicate' });
    expect(session.upload).toHaveBeenCalledTimes(1);
  });

  it('не пропускает первую неподтверждённую запись ради более новой', async () => {
    const store = makeStore();
    const session = makeSession({ verify: vi.fn(async () => ({ status: 'mismatch' })) });
    const outbox = create(provider, store, session);
    await outbox.initialize(true);
    const first = await sealedVersion();
    const second = await sealedVersion();
    await outbox.enqueue(first.envelope);
    await outbox.enqueue(second.envelope);
    expect(await outbox.sendNext()).toEqual({ status: 'needs_verification' });
    expect(await outbox.verifyNext()).toEqual({ status: 'needs_review' });
    expect(await outbox.sendNext()).toEqual({ status: 'needs_verification' });
    expect(session.upload).toHaveBeenCalledTimes(1);
    expect(session.upload.mock.calls[0][0].envelope.versionId).toBe(first.envelope.versionId);
  });
});
