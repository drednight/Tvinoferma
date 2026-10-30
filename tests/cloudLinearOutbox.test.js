import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { decryptSnapshot, encryptSnapshot, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { MAX_HISTORY_VERSIONS, sealHistoryVersion } from '../js/modules/cloudSync/history.js';
import { prepareCloudReview } from '../js/modules/cloudSync/cloudReview.js';
import { createDurableCloudOutbox } from '../js/modules/cloudSync/durableOutbox.js';

// Это синтетический CAS и синтетический диск: тесты не подтверждают fsync,
// Credential Manager, полноту реального списка или поведение API провайдеров.
const cryptoSource = webcrypto;
const id = () => generateSyncId(cryptoSource);
const datasetId = id();
const clients = {
  google: '123456789-fake_client.apps.googleusercontent.com',
  yandex: '0123456789abcdef0123456789abcdef'
};
let keys, root, base;

beforeAll(async () => {
  keys = await createKeyBundle({
    datasetId,
    primary: { kind: 'password', secret: 'Синтетический пароль для теста 123!' },
    backup: { kind: 'generated' },
    cryptoSource
  });
  const { ui, ...state } = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero', nick: 'ЛИЧНЫЙ ПЕРСОНАЖ', notes: 'ЛИЧНАЯ ЗАМЕТКА' }],
    plannerEntries: [{ id: 'task', title: 'ЛИЧНАЯ ЗАДАЧА', date: '2026-11-01', kind: 'task' }]
  });
  base = buildPublicSnapshot(planSyncIdentities({ snapshot: state, cryptoSource }).snapshot);
  root = await sealHistoryVersion({
    publicSnapshot: base,
    parent: null,
    recoveryKey: keys.dataKey,
    datasetId,
    versionId: id(),
    keyBundle: keys.bundle,
    keyPin: keys.pin,
    cryptoSource
  });
}, 30_000);

function fakeStore() {
  let saved = { status: 'empty' };
  let loseNext = false;
  return {
    read: vi.fn(async () => structuredClone(saved)),
    installInitial: vi.fn(async ({ slotId, datasetId, deviceId, revisionId, record }) => {
      if (saved.status !== 'empty') return { status: 'occupied' };
      saved = { status: 'ready', slotId, datasetId, deviceId, revisionId, record, sha256: digest(record) };
      return { status: 'installed' };
    }),
    install: vi.fn(async () => ({ status: 'blocked' })),
    compareExchange: vi.fn(async ({ expectedRevisionId, expectedSha256, revisionId, record }) => {
      if (saved.status !== 'ready' || saved.revisionId !== expectedRevisionId || saved.sha256 !== expectedSha256)
        return { status: 'mismatch' };
      saved = { ...saved, revisionId, record, sha256: digest(record) };
      if (loseNext) {
        loseNext = false;
        throw new Error('FAKE LOST RESPONSE');
      }
      return { status: 'swapped' };
    }),
    loseNextResponse() {
      loseNext = true;
    },
    // Намеренно пересоздаём допустимый шифротекст с повреждённой внутренней
    // моделью, чтобы проверить валидатор, а не только защиту GCM.
    async corruptPlaintext(change) {
      const material = await cryptoSource.subtle.importKey(
        'raw',
        Buffer.from(keys.dataKey.slice(4), 'base64url'),
        'HKDF',
        false,
        ['deriveBits']
      );
      const bits = await cryptoSource.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode('tvinoferma-durable-outbox-key-v1'),
          info: new TextEncoder().encode(JSON.stringify([saved.datasetId, saved.deviceId, saved.slotId]))
        },
        material,
        256
      );
      const recoveryKey = `TF1-${Buffer.from(bits).toString('base64url')}`;
      const plain = await decryptSnapshot({
        envelope: JSON.parse(saved.record),
        recoveryKey,
        expectedDatasetId: saved.datasetId,
        cryptoSource
      });
      change(plain);
      const next = await encryptSnapshot({
        snapshot: plain,
        recoveryKey,
        datasetId: saved.datasetId,
        versionId: saved.revisionId,
        cryptoSource
      });
      const record = JSON.stringify(next);
      saved = { ...saved, record, sha256: digest(record) };
    },
    raw: () => structuredClone(saved)
  };
}
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function snapshot(note) {
  const next = structuredClone(base);
  next.sections.characters.records[0].fields.notes = note;
  return next;
}
function addCharacter(source) {
  const next = structuredClone(source);
  const copy = structuredClone(next.sections.characters.records[0]);
  copy.id = id();
  copy.fields.nick = 'НОВЫЙ ПЕРСОНАЖ';
  next.sections.characters.records.push(copy);
  next.sections.characters.order.active.push(copy.id);
  return next;
}
function removeCharacter(source) {
  const next = structuredClone(source);
  next.sections.characters.records = [];
  next.sections.characters.order.active = [];
  next.sections.characters.order.archived = [];
  return next;
}
function setup(provider) {
  const store = fakeStore();
  const slotId = id();
  const deviceId = id();
  const received = new Map();
  let nextFile = 0;
  let loseUploadResponse = false;
  const session = {
    generateFileId: vi.fn(async () => ({ status: 'generated', fileId: `FILE_${++nextFile}` })),
    upload: vi.fn(async ({ envelope }) => {
      received.set(envelope.versionId, structuredClone(envelope));
      if (loseUploadResponse) {
        loseUploadResponse = false;
        throw new Error('FAKE LOST RESPONSE');
      }
      return { status: 'accepted' };
    }),
    verify: vi.fn(async ({ envelope }) => ({
      status: JSON.stringify(received.get(envelope.versionId)) === JSON.stringify(envelope) ? 'verified' : 'unavailable'
    }))
  };
  const open = () =>
    createDurableCloudOutbox({
      provider,
      datasetId,
      deviceId,
      slotId,
      clientId: clients[provider],
      accountKey: 'FAKE_ACCOUNT_ID',
      dataKey: keys.dataKey,
      store,
      session,
      cryptoSource,
      ...(provider === 'google' ? { folderId: 'root' } : {})
    });
  const pins = { expectedRootPin: root.pin, expectedKeyPin: keys.pin };
  const queue = (outbox, publicSnapshot) =>
    outbox.queueLinearSnapshot({ ...pins, keyBundle: keys.bundle, publicSnapshot });
  const inspect = outbox => outbox.inspectLinearHead(pins);
  const send = async (outbox, head) =>
    outbox.sendLinearNext({
      ...pins,
      expectedConfirmedPin: head.confirmedPin,
      expectedNextPin: head.nextPin,
      expectedRevisionId: head.revisionId
    });
  async function confirmedRoot() {
    const outbox = open();
    expect((await outbox.initializeWithRoot(root.envelope, true)).status).toBe('initialized');
    expect(await outbox.sendNext()).toEqual({ status: 'needs_verification' });
    expect(await outbox.verifyNext()).toEqual({ status: 'confirmed' });
    return outbox;
  }
  return {
    store,
    session,
    received,
    open,
    pins,
    queue,
    inspect,
    send,
    confirmedRoot,
    loseUploadResponse: () => (loseUploadResponse = true)
  };
}

describe.each(['google', 'yandex'])('%s: последующая локальная линейная очередь', provider => {
  it('подтверждает точные удаления календаря, удерживает отметки после перезапуска и следующих отправок', async () => {
    const a = setup(provider);
    let box = await a.confirmedRoot();
    const next = structuredClone(base);
    const taskId = next.sections.planner.records[0].id;
    next.sections.planner.records = [];
    next.sections.planner.order = [];
    expect((await a.queue(box, next)).status).toBe('deletions_need_review');
    const head = await a.inspect(box);
    const preview = await box.inspectPlannerDeletions({
      ...a.pins,
      publicSnapshot: next,
      expectedRevisionId: head.revisionId
    });
    expect(preview).toMatchObject({
      status: 'deletion_review',
      parentPin: root.pin,
      records: [{ id: taskId, label: 'ЛИЧНАЯ ЗАДАЧА' }]
    });
    expect(
      (
        await box.queueLinearSnapshot({
          ...a.pins,
          keyBundle: keys.bundle,
          publicSnapshot: next,
          expectedRevisionId: preview.revisionId,
          plannerDeletionApproval: { parentPin: preview.parentPin, ids: [taskId] }
        })
      ).status
    ).toBe('queued');
    box = a.open();
    const edited = structuredClone(next);
    edited.sections.characters.records[0].fields.notes = 'После подтверждения удаления';
    expect((await a.queue(box, edited)).status).toBe('coalesced');
    expect((await a.send(box, await a.inspect(box))).status).toBe('needs_verification');
    expect((await box.verifyNext()).status).toBe('confirmed');
    box = a.open();
    const later = structuredClone(edited);
    later.sections.characters.records[0].fields.notes = 'Следующая версия';
    expect((await a.queue(box, later)).status).toBe('queued');
    expect((await a.send(box, await a.inspect(box))).status).toBe('needs_verification');
    expect((await box.verifyNext()).status).toBe('confirmed');
    const { verifyHistory } = await import('../js/modules/cloudSync/history.js');
    const history = await verifyHistory({
      envelopes: [...a.received.values()],
      expectedDatasetId: datasetId,
      recoveryKey: keys.dataKey,
      root: root.pin,
      knownPins: [root.pin],
      cryptoSource
    });
    expect(history.plannerTombstones((await a.inspect(box)).tailPin)).toEqual([taskId]);
    expect(history.publicSnapshot((await a.inspect(box)).tailPin)).toEqual(later);
    const resurrect = structuredClone(later);
    resurrect.sections.planner = structuredClone(base.sections.planner);
    expect((await a.queue(box, resurrect)).status).toBe('deleted_identity_resurrection');
    expect(a.session.upload).toHaveBeenCalledTimes(3);
  });

  it('не принимает устаревшее или не то подтверждение удаления и не удаляет персонажа', async () => {
    const a = setup(provider);
    const box = await a.confirmedRoot();
    const next = structuredClone(base);
    next.sections.planner.records = [];
    next.sections.planner.order = [];
    const head = await a.inspect(box);
    const preview = await box.inspectPlannerDeletions({
      ...a.pins,
      publicSnapshot: next,
      expectedRevisionId: head.revisionId
    });
    const before = a.store.raw();
    const args = { ...a.pins, keyBundle: keys.bundle, publicSnapshot: next, expectedRevisionId: preview.revisionId };
    expect(
      (
        await box.queueLinearSnapshot({
          ...args,
          plannerDeletionApproval: { parentPin: preview.parentPin, ids: [id()] }
        })
      ).status
    ).toBe('deletion_review_changed');
    expect(a.store.raw()).toEqual(before);
    expect((await a.queue(box, snapshot('Локальная правка'))).status).toBe('queued');
    expect(
      (
        await box.queueLinearSnapshot({
          ...args,
          plannerDeletionApproval: { parentPin: preview.parentPin, ids: preview.records.map(row => row.id) }
        })
      ).status
    ).toBe('changed');
    const updated = await a.inspect(box);
    const missingBoth = removeCharacter(next);
    expect(
      (
        await box.inspectPlannerDeletions({
          ...a.pins,
          publicSnapshot: missingBoth,
          expectedRevisionId: updated.revisionId
        })
      ).status
    ).toBe('other_deletions_need_review');
    expect(a.session.upload).toHaveBeenCalledTimes(1);
  });

  it('не принимает поддельное доказательство принятой облачной базы', async () => {
    const a = setup(provider);
    const box = a.open();
    await box.initializeRecovered(true);
    await expect(
      box.adoptReviewedBase({
        ...a.pins,
        proof: {
          status: 'ready_for_adoption',
          provider,
          datasetId,
          rootPin: root.pin,
          pin: root.pin,
          envelope: root.envelope
        }
      })
    ).rejects.toThrow();
    expect(await a.inspect(box)).toEqual({ status: 'no_local_lineage' });
    expect(a.session.upload).not.toHaveBeenCalled();
  });

  it('capability точного совпадения и её линия неизменяемы; копия не считается доказательством', async () => {
    const a = setup(provider);
    const box = a.open();
    await box.initializeRecovered(true);
    const checked = await prepareCloudReview({
      provider,
      datasetId,
      dataKey: keys.dataKey,
      rootPin: root.pin,
      knownPins: [root.pin],
      localSnapshot: base,
      localSavedAt: null,
      cryptoSource,
      session: {
        listWithDates: async () => ({
          status: 'listed',
          versions: [{ versionId: root.pin.versionId, modifiedAt: null }]
        }),
        read: async () => ({ status: 'found', envelope: root.envelope })
      }
    });
    const proof = checked.prepareExactAdoption(root.pin, {});
    expect(proof.status).toBe('ready_for_adoption');
    expect(Object.isFrozen(proof.lineage)).toBe(true);
    expect(Object.isFrozen(proof.lineage[0])).toBe(true);
    expect(() => proof.lineage.push({ ...root.pin })).toThrow();
    expect(() => (proof.lineage[0].sha256 = 'a'.repeat(64))).toThrow();
    await expect(box.adoptReviewedBase({ ...a.pins, proof: structuredClone(proof) })).rejects.toThrow();
    expect((await box.adoptReviewedBase({ ...a.pins, proof })).status).toBe('adopted');
  });

  it('продолжает читать ранее сохранённую принятую очередь v3', async () => {
    const a = setup(provider);
    const box = a.open();
    await box.initializeRecovered(true);
    const review = await prepareCloudReview({
      provider,
      datasetId,
      dataKey: keys.dataKey,
      rootPin: root.pin,
      knownPins: [root.pin],
      localSnapshot: base,
      localSavedAt: null,
      cryptoSource,
      session: {
        listWithDates: async () => ({
          status: 'listed',
          versions: [{ versionId: root.pin.versionId, modifiedAt: null }]
        }),
        read: async () => ({ status: 'found', envelope: root.envelope })
      }
    });
    const proof = review.prepareExactAdoption(root.pin, {});
    expect((await box.adoptReviewedBase({ ...a.pins, proof })).status).toBe('adopted');
    await a.store.corruptPlaintext(value => {
      value.version = 3;
      delete value.entries[0].lineage;
      delete value.entries[0].priorReceiptCount;
      delete value.entries[0].previousBase;
    });
    const reopened = a.open();
    expect((await a.inspect(reopened)).confirmedPin).toEqual(root.pin);
    expect((await a.queue(reopened, snapshot('ПОСЛЕ ОБНОВЛЕНИЯ'))).status).toBe('queued');
    expect(await a.send(reopened, await a.inspect(reopened))).toEqual({ status: 'needs_verification' });
    expect(await reopened.verifyNext()).toEqual({ status: 'confirmed' });
    expect((await a.inspect(a.open())).pendingCount).toBe(0);
  });

  it('не выбирает родителя из пустой восстановленной очереди и ждёт подтверждения корня', async () => {
    const a = setup(provider);
    const empty = a.open();
    expect((await empty.initializeRecovered(true)).status).toBe('initialized');
    expect(await a.inspect(empty)).toEqual({ status: 'no_local_lineage' });
    expect(await a.queue(empty, snapshot('правка'))).toEqual({ status: 'no_local_lineage' });
    expect(a.session.upload).not.toHaveBeenCalled();

    const b = setup(provider);
    const pending = b.open();
    await pending.initializeWithRoot(root.envelope, true);
    expect((await b.inspect(pending)).confirmedPin).toBeNull();
    expect(await b.queue(pending, snapshot('правка'))).toEqual({ status: 'root_unconfirmed' });
    expect(b.session.upload).not.toHaveBeenCalled();
  });

  it('сохраняет потомка зашифрованным и после перезапуска отправляет выбранную revision', async () => {
    const a = setup(provider);
    const first = await a.confirmedRoot();
    const queued = await a.queue(first, snapshot('НОВАЯ ЛИЧНАЯ ЗАМЕТКА'));
    expect(queued.status).toBe('queued');
    for (const secret of ['ЛИЧНЫЙ ПЕРСОНАЖ', 'НОВАЯ ЛИЧНАЯ ЗАМЕТКА', keys.dataKey, 'FAKE_ACCOUNT_ID'])
      expect(JSON.stringify(a.store.raw())).not.toContain(secret);
    const restarted = a.open();
    const head = await a.inspect(restarted);
    expect(head.confirmedPin).toEqual(root.pin);
    expect(head.nextPin).toEqual(queued.pin);
    expect(head.pendingCount).toBe(1);
    expect(await a.send(restarted, head)).toEqual({ status: 'needs_verification' });
    expect(await restarted.verifyNext()).toEqual({ status: 'confirmed' });
    const payload = await decryptSnapshot({
      envelope: a.received.get(queued.pin.versionId),
      recoveryKey: keys.dataKey,
      expectedDatasetId: datasetId,
      cryptoSource
    });
    expect(payload.parent).toEqual(root.pin);
    expect(payload.publicSnapshot.sections.characters.records[0].fields.notes).toBe('НОВАЯ ЛИЧНАЯ ЗАМЕТКА');
    expect((await a.inspect(a.open())).confirmedPin).toEqual(queued.pin);
    expect((await a.queue(a.open(), snapshot('НОВАЯ ЛИЧНАЯ ЗАМЕТКА'))).status).toBe('unchanged');
  });

  it('объединяет только неотправленную последнюю версию и не принимает устаревшую revision', async () => {
    const a = setup(provider);
    const box = await a.confirmedRoot();
    const first = await a.queue(box, snapshot('один'));
    const oldHead = await a.inspect(box);
    const second = await a.queue(box, snapshot('два'));
    expect(second.status).toBe('coalesced');
    expect(second.pin).not.toEqual(first.pin);
    expect(await a.send(box, oldHead)).toEqual({ status: 'changed' });
    expect(a.session.upload).toHaveBeenCalledTimes(1); // только корень
    const current = await a.inspect(a.open());
    expect(current.nextPin).toEqual(second.pin);
    expect(current.pendingCount).toBe(1);
    expect(await a.send(box, current)).toEqual({ status: 'needs_verification' });
    expect(await box.verifyNext()).toEqual({ status: 'confirmed' });
    expect(a.received.has(first.pin.versionId)).toBe(false);
  });

  it('не готовит снимок по устаревшей revision даже при гонке двух локальных клиентов', async () => {
    const a = setup(provider);
    const box = await a.confirmedRoot();
    const checked = await a.inspect(box);
    const request = {
      ...a.pins,
      keyBundle: keys.bundle,
      expectedRevisionId: checked.revisionId,
      publicSnapshot: snapshot('первая сохранённая правка')
    };
    const first = await box.queueLinearSnapshot(request);
    expect(first.status).toBe('queued');
    expect(await a.open().queueLinearSnapshot({ ...request, publicSnapshot: snapshot('устаревшая правка') })).toEqual({
      status: 'changed'
    });
    const current = await a.inspect(a.open());
    expect(current.nextPin).toEqual(first.pin);
    expect(current.pendingCount).toBe(1);
    await expect(box.queueLinearSnapshot({ ...request, expectedRevisionId: '' })).rejects.toThrow();
  });

  it('не повторяет отправку с потерянным ответом, а новые сохранения ставит после неё', async () => {
    const a = setup(provider);
    const box = await a.confirmedRoot();
    const attempted = await a.queue(box, snapshot('отправка с потерянным ответом'));
    const head = await a.inspect(box);
    a.loseUploadResponse();
    expect(await a.send(box, head)).toEqual({ status: 'needs_verification' });
    const later = await a.queue(a.open(), snapshot('сохранение после отправки'));
    expect(later.status).toBe('queued');
    const latest = await a.queue(a.open(), snapshot('ещё одно сохранение'));
    expect(latest.status).toBe('coalesced');
    expect((await a.inspect(a.open())).pendingCount).toBe(2);
    expect(await box.sendNext()).toEqual({ status: 'needs_verification' });
    expect(a.session.upload).toHaveBeenCalledTimes(2); // root + ровно одна попытка
    expect(await a.open().verifyNext()).toEqual({ status: 'confirmed' });
    const nextHead = await a.inspect(a.open());
    expect(nextHead.confirmedPin).toEqual(attempted.pin);
    expect(nextHead.nextPin).toEqual(latest.pin);
    expect(await a.send(a.open(), nextHead)).toEqual({ status: 'needs_verification' });
    expect(await a.open().verifyNext()).toEqual({ status: 'confirmed' });
    const payload = await decryptSnapshot({
      envelope: a.received.get(latest.pin.versionId),
      recoveryKey: keys.dataKey,
      expectedDatasetId: datasetId,
      cryptoSource
    });
    expect(payload.parent).toEqual(attempted.pin);
    expect(a.received.has(later.pin.versionId)).toBe(false);
    expect(a.session.upload).toHaveBeenCalledTimes(3);
  });

  it('не отправляет исчезновение опубликованной сущности; отменяет ещё не опубликованное добавление', async () => {
    const a = setup(provider);
    const box = await a.confirmedRoot();
    const withAddition = addCharacter(base);
    expect((await a.queue(box, withAddition)).status).toBe('queued');
    expect((await a.queue(box, base)).status).toBe('discarded_unpublished');
    expect((await a.inspect(box)).pendingCount).toBe(0);
    expect(await a.queue(box, removeCharacter(base))).toEqual({ status: 'deletions_need_review' });
    expect(a.session.upload).toHaveBeenCalledTimes(1);
  });

  it('две одновременные подготовки не подменяют сохранённую версию', async () => {
    const a = setup(provider);
    await a.confirmedRoot();
    const outcomes = await Promise.all([a.queue(a.open(), snapshot('A')), a.queue(a.open(), snapshot('B'))]);
    expect(outcomes.filter(item => item.status === 'queued')).toHaveLength(1);
    expect(outcomes.filter(item => item.status === 'changed')).toHaveLength(1);
    expect((await a.inspect(a.open())).nextPin).toEqual(outcomes.find(item => item.status === 'queued').pin);
    expect(a.session.upload).toHaveBeenCalledTimes(1);
  });

  it('после потерянного ответа записи продолжает только новый экземпляр, перечитав журнал', async () => {
    const a = setup(provider);
    const box = await a.confirmedRoot();
    a.store.loseNextResponse();
    expect(await a.queue(box, snapshot('сохранено до потери ответа'))).toEqual({ status: 'journal_uncertain' });
    expect(await a.queue(box, snapshot('не делать повтор'))).toEqual({ status: 'journal_uncertain' });
    const restarted = a.open();
    expect((await a.inspect(restarted)).pendingCount).toBe(1);
    expect((await a.queue(restarted, snapshot('после перезапуска'))).status).toBe('coalesced');
    expect(a.session.upload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['потеря корня', value => value.entries[0].lineage.shift()],
    ['повторный предок', value => (value.entries[0].lineage[1] = { ...value.entries[0].lineage[0] })],
    ['подмена отпечатка родителя', value => (value.entries[0].lineage[1].sha256 = 'f'.repeat(64))],
    ['повреждённая квитанция', value => (value.confirmedReceipts[0].sha256 = 'f'.repeat(64))],
    ['неверное количество квитанций', value => (value.entries[0].priorReceiptCount = 999)]
  ])('блокирует повреждённую принятую линию: %s', async (_name, corrupt) => {
    const a = setup(provider);
    const box = await a.confirmedRoot();
    const first = await sealHistoryVersion({
      publicSnapshot: snapshot('ОБЛАЧНОЕ ИЗМЕНЕНИЕ'),
      parent: root.pin,
      recoveryKey: keys.dataKey,
      datasetId,
      versionId: id(),
      keyBundle: keys.bundle,
      keyPin: keys.pin,
      cryptoSource
    });
    const second = await sealHistoryVersion({
      publicSnapshot: snapshot('ОБЛАЧНОЕ ИЗМЕНЕНИЕ'),
      parent: first.pin,
      recoveryKey: keys.dataKey,
      datasetId,
      versionId: id(),
      keyBundle: keys.bundle,
      keyPin: keys.pin,
      cryptoSource
    });
    const line = [root, first, second];
    const review = await prepareCloudReview({
      provider,
      datasetId,
      dataKey: keys.dataKey,
      rootPin: root.pin,
      knownPins: [root.pin],
      localSnapshot: snapshot('ОБЛАЧНОЕ ИЗМЕНЕНИЕ'),
      localSavedAt: null,
      cryptoSource,
      session: {
        listWithDates: async () => ({
          status: 'listed',
          versions: line.map(value => ({ versionId: value.pin.versionId, modifiedAt: null }))
        }),
        read: async versionId => ({
          status: 'found',
          envelope: line.find(value => value.pin.versionId === versionId)?.envelope
        })
      }
    });
    const proof = review.prepareExactAdoption(second.pin, {});
    expect((await box.adoptReviewedBase({ ...a.pins, proof })).status).toBe('adopted');
    expect((await a.inspect(a.open())).confirmedPin).toEqual(second.pin);
    await a.store.corruptPlaintext(corrupt);
    const stored = a.store.raw();
    expect(await a.inspect(a.open())).toEqual({ status: 'journal_blocked' });
    expect(await a.queue(a.open(), snapshot('НЕ ДОЛЖНА СОХРАНИТЬСЯ'))).toEqual({ status: 'journal_blocked' });
    expect(a.store.raw()).toEqual(stored);
    expect(a.session.upload).toHaveBeenCalledTimes(1); // только корень
  });

  it('учитывает всю принятую линию при пределе истории, а не только локальные квитанции', async () => {
    const versions = [root];
    for (let i = 1; i < MAX_HISTORY_VERSIONS; i++) {
      versions.push(
        await sealHistoryVersion({
          publicSnapshot: snapshot('ОБЛАЧНАЯ ЛИНИЯ'),
          parent: versions.at(-1).pin,
          recoveryKey: keys.dataKey,
          datasetId,
          versionId: id(),
          keyBundle: keys.bundle,
          keyPin: keys.pin,
          cryptoSource
        })
      );
    }
    async function adoptionFor(line) {
      const byId = new Map(line.map(version => [version.pin.versionId, version.envelope]));
      const review = await prepareCloudReview({
        provider,
        datasetId,
        dataKey: keys.dataKey,
        rootPin: root.pin,
        knownPins: [root.pin],
        localSnapshot: snapshot('ОБЛАЧНАЯ ЛИНИЯ'),
        localSavedAt: null,
        cryptoSource,
        session: {
          listWithDates: async () => ({
            status: 'listed',
            versions: line.map(version => ({ versionId: version.pin.versionId, modifiedAt: null }))
          }),
          read: async versionId => ({ status: 'found', envelope: byId.get(versionId) })
        }
      });
      expect(review.status).toBe('ready_for_review');
      return review.prepareExactAdoption(line.at(-1).pin, {});
    }
    // 127 подтверждённых версий: ещё одну можно поставить и заменить до отправки.
    const atBoundary = setup(provider);
    const before = await atBoundary.confirmedRoot();
    const proof127 = await adoptionFor(versions.slice(0, MAX_HISTORY_VERSIONS - 1));
    expect((await before.adoptReviewedBase({ ...atBoundary.pins, proof: proof127 })).status).toBe('adopted');
    expect((await atBoundary.queue(before, snapshot('ПОСЛЕДНЯЯ ДОПУСТИМАЯ'))).status).toBe('queued');
    expect((await atBoundary.queue(before, snapshot('ЗАМЕНА ЕЩЁ НЕ ОТПРАВЛЕННОЙ'))).status).toBe('coalesced');

    // 128 подтверждённых версий: новый потомок не должен занимать очередь.
    const full = setup(provider);
    const after = await full.confirmedRoot();
    const proof128 = await adoptionFor(versions);
    expect((await after.adoptReviewedBase({ ...full.pins, proof: proof128 })).status).toBe('adopted');
    const stored = full.store.raw();
    expect(await full.queue(after, snapshot('СВЕРХ ПРЕДЕЛА'))).toEqual({ status: 'history_limit' });
    expect(full.store.raw()).toEqual(stored);
    expect(full.session.upload).toHaveBeenCalledTimes(1); // только корень

    // То же ограничение действует при первом принятии на восстановленном ПК:
    // его очередь была пуста, но известные облачные предки не должны исчезнуть.
    const recovered = setup(provider);
    const empty = recovered.open();
    expect(await empty.initializeRecovered(true)).toEqual({ status: 'initialized' });
    expect((await empty.adoptReviewedBase({ ...recovered.pins, proof: proof128 })).status).toBe('adopted');
    expect((await empty.confirmedPins()).pins).toHaveLength(MAX_HISTORY_VERSIONS);
    const saved = recovered.store.raw();
    expect(await recovered.queue(empty, snapshot('СВЕРХ ПРЕДЕЛА'))).toEqual({ status: 'history_limit' });
    expect(recovered.store.raw()).toEqual(saved);
    expect(recovered.session.upload).not.toHaveBeenCalled();
  }, 30_000);

  it('сжимает подтверждённые версии, сохраняя последний конверт и все отпечатки', async () => {
    const a = setup(provider);
    const box = await a.confirmedRoot();
    let last;
    for (let i = 1; i <= 17; i++) {
      const queued = await a.queue(box, snapshot(`правка ${i}`));
      expect(queued.status).toBe('queued');
      const head = await a.inspect(box);
      expect(await a.send(box, head)).toEqual({ status: 'needs_verification' });
      expect(await box.verifyNext()).toEqual({ status: 'confirmed' });
      last = queued.pin;
    }
    const restarted = await a.inspect(a.open());
    expect(restarted.status).toBe('ready');
    expect(restarted.confirmedPin).toEqual(last);
    expect(restarted.confirmedPins).toHaveLength(18);
    expect(restarted.confirmedPins[0]).toEqual(root.pin);
    expect((await a.queue(a.open(), snapshot('после сжатия'))).status).toBe('queued');
  }, 30_000);
});
