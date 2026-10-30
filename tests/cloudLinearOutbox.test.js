import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { decryptSnapshot, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { sealHistoryVersion } from '../js/modules/cloudSync/history.js';
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
    characters: [{ id: 'hero', nick: 'ЛИЧНЫЙ ПЕРСОНАЖ', notes: 'ЛИЧНАЯ ЗАМЕТКА' }]
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
