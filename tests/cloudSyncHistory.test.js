import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { comparePublicSnapshots } from '../js/modules/cloudSync/compareSnapshots.js';
import { createSelectiveRecordReview } from '../js/modules/cloudSync/selectiveRecordReview.js';
import { encryptSnapshot, generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { sealHistoryVersion, verifyHistory } from '../js/modules/cloudSync/history.js';

const cryptoSource = webcrypto;
const id = () => generateSyncId(cryptoSource);
let datasetId;
let recoveryKey;
let original;

function makePublicSnapshot() {
  const state = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero-1', nick: 'Звеномир' }],
    plannerEntries: [
      {
        id: 'task-1',
        title: 'Задача дня',
        date: '2026-11-01',
        time: '18:00',
        kind: 'task',
        recurrence: 'daily',
        status: 'todo',
        statusByDate: { '2026-11-01': 'todo' }
      },
      { id: 'guild-462', title: 'Клановый поход', date: '2026-11-01', kind: 'event', status: 'done' }
    ]
  });
  const { ui, ...snapshot } = state;
  return buildPublicSnapshot(planSyncIdentities({ snapshot, cryptoSource }).snapshot);
}

const seal = (publicSnapshot = original, parent = null, versionId = id()) =>
  sealHistoryVersion({ publicSnapshot, parent, datasetId, recoveryKey, versionId, cryptoSource });
const verify = (versions, root, extra = {}) =>
  verifyHistory({
    envelopes: versions.map(version => version.envelope),
    expectedDatasetId: datasetId,
    recoveryKey,
    root: root.pin,
    knownPins: [],
    cryptoSource,
    ...extra
  });
const wrapper = (publicSnapshot, parent = null, extra = {}) => ({
  format: 'tvinoferma-public-history',
  version: 1,
  parent,
  publicSnapshot,
  ...extra
});
const forged = async (payload, versionId = id(), otherDataset = datasetId) => ({
  envelope: await encryptSnapshot({ snapshot: payload, recoveryKey, datasetId: otherDataset, versionId, cryptoSource })
});

beforeEach(() => {
  datasetId = id();
  recoveryKey = generateRecoveryKey(cryptoSource);
  original = makePublicSnapshot();
});

describe('изолированная история зашифрованных публичных версий', () => {
  it('связывает общий предок двух веток и работает с выбором отметки события без записи данных', async () => {
    const root = await seal();
    const sharedSnapshot = structuredClone(original);
    sharedSnapshot.sections.planner.records[1].fields.status = 'doing';
    const shared = await seal(sharedSnapshot, root.pin);
    const localSnapshot = structuredClone(sharedSnapshot);
    localSnapshot.sections.planner.records[0].fields.title = 'Моя задача дня';
    const cloudSnapshot = structuredClone(sharedSnapshot);
    cloudSnapshot.sections.planner.records[0].fields.statusByDate['2026-11-01'] = 'done';
    cloudSnapshot.sections.planner.records[0].fields.time = '20:30';
    const local = await seal(localSnapshot, shared.pin);
    const cloud = await seal(cloudSnapshot, shared.pin);
    const tree = await verify([cloud, root, local, shared], root, { knownPins: [root.pin, shared.pin] });
    expect(tree.observedHeads()).toEqual([cloud.pin, local.pin].sort((a, b) => a.versionId.localeCompare(b.versionId)));
    expect(tree.commonAncestor(local.pin, cloud.pin)).toEqual(shared.pin);
    expect(tree.commonAncestor(root.pin, cloud.pin)).toEqual(root.pin);
    expect(tree.commonAncestor(local.pin, local.pin)).toEqual(local.pin);

    const compared = comparePublicSnapshots({
      local: tree.publicSnapshot(local.pin),
      cloud: tree.publicSnapshot(cloud.pin)
    });
    expect(compared.entries.find(item => item.type === 'plannerEntry').changes).toEqual(
      expect.arrayContaining([
        { path: ['time'], local: { present: true, value: '18:00' }, cloud: { present: true, value: '20:30' } },
        {
          path: ['statusByDate', '2026-11-01'],
          local: { present: true, value: 'todo' },
          cloud: { present: true, value: 'done' }
        }
      ])
    );
    const record = pin => ({ deleted: false, fields: tree.publicSnapshot(pin).sections.planner.records[0].fields });
    const review = createSelectiveRecordReview({
      base: record(shared.pin),
      local: record(local.pin),
      remote: record(cloud.pin)
    });
    const candidate = review.plan({ selected: [['statusByDate', '2026-11-01']] });
    expect(candidate.record.fields).toMatchObject({
      title: 'Моя задача дня',
      time: '18:00',
      statusByDate: { '2026-11-01': 'done' }
    });
    expect(candidate.pending).toContainEqual({ path: ['time'], kind: 'change_field' });
    expect(tree.publicSnapshot(local.pin)).toEqual(localSnapshot);
  });

  it('считает SHA-256 по каноническому зашифрованному конверту, а не по открытым данным', async () => {
    const version = await seal();
    const e = version.envelope;
    const independent = createHash('sha256')
      .update(
        JSON.stringify([
          'tvinoferma-encrypted-envelope-sha256-v1',
          e.format,
          e.version,
          e.algorithm,
          e.datasetId,
          e.versionId,
          e.iv,
          e.ciphertext
        ])
      )
      .digest('hex');
    expect(version.pin).toEqual({ versionId: e.versionId, sha256: independent });
    expect(JSON.stringify(e)).not.toContain('Задача дня');
    expect(JSON.stringify(e)).not.toContain('Клановый поход');
    expect(JSON.stringify(e)).not.toContain(recoveryKey);
    const reordered = {
      ciphertext: e.ciphertext,
      iv: e.iv,
      versionId: e.versionId,
      datasetId: e.datasetId,
      algorithm: e.algorithm,
      version: e.version,
      format: e.format
    };
    const tree = await verify([{ envelope: reordered }], version);
    expect(tree.publicSnapshot(version.pin)).toEqual(original);
  });

  it('отличает реально переданные вершины от предположения о полноте облака', async () => {
    const root = await seal();
    const remote = await seal(original, root.pin);
    const observedOnlyRoot = await verify([root], root);
    expect(observedOnlyRoot.observedHeads()).toEqual([root.pin]);
    // При наличии сохранённой отметки исчезнувшая ветка обнаруживается.
    await expect(verify([root], root, { knownPins: [remote.pin] })).rejects.toThrow('ранее известная версия');
  });

  it('отклоняет отсутствие родителя, несовпадение его отпечатка и несколько корней', async () => {
    const root = await seal();
    const missingPin = { versionId: id(), sha256: '0'.repeat(64) };
    const missing = await forged(wrapper(original, missingPin));
    await expect(verify([root, missing], root)).rejects.toThrow('отсутствует родительская версия');
    const wrong = await forged(wrapper(original, { ...root.pin, sha256: '1'.repeat(64) }));
    await expect(verify([wrong, root], root)).rejects.toThrow('не совпадает с её отпечатком');
    const extraRoot = await seal();
    await expect(verify([root, extraRoot], root)).rejects.toThrow('история синхронизации');
  });

  it('не принимает повторный идентификатор, даже если дубликаты содержат одинаковый файл', async () => {
    const root = await seal();
    await expect(verify([root, root], root)).rejects.toThrow('история синхронизации');
    const sameIdDifferentCiphertext = await seal(original, null, root.pin.versionId);
    expect(sameIdDifferentCiphertext.pin.sha256).not.toBe(root.pin.sha256);
    await expect(verify([root, sameIdDifferentCiphertext], root)).rejects.toThrow('история синхронизации');
  });

  it('обнаруживает замену доверенного корня и ранее известной версии с тем же ID', async () => {
    const root = await seal();
    const replacement = await seal(original, null, root.pin.versionId);
    await expect(verify([replacement], root)).rejects.toThrow('корневая версия');
    const child = await seal(original, root.pin);
    const replacedChild = await seal(original, root.pin, child.pin.versionId);
    await expect(verify([root, replacedChild], root, { knownPins: [child.pin] })).rejects.toThrow(
      'ранее известная версия'
    );
  });

  it('отклоняет пропавший или чужой корень и некорректные сохранённые отпечатки', async () => {
    const root = await seal();
    await expect(verify([], root)).rejects.toThrow('корневая версия');
    const second = await seal();
    await expect(verify([second], root)).rejects.toThrow('корневая версия');
    await expect(verify([root], root, { root: { ...root.pin, sha256: 'not-a-hash' } })).rejects.toThrow();
    await expect(verify([root], root, { knownPins: [root.pin, root.pin] })).rejects.toThrow();
    await expect(verify([root], root, { knownPins: [{ ...root.pin, secret: 'private' }] })).rejects.toThrow();
    await expect(verify([root], root, { knownPins: undefined })).rejects.toThrow();
  });

  it('проверяет AES-GCM, набор, ключ и неподдерживаемую схему до возвращения истории', async () => {
    const root = await seal();
    await expect(verify([root], root, { recoveryKey: generateRecoveryKey(cryptoSource) })).rejects.toThrow('проверить');
    await expect(verify([root], root, { expectedDatasetId: id() })).rejects.toThrow();
    const ciphertext = Buffer.from(root.envelope.ciphertext, 'base64url');
    ciphertext[0] ^= 1;
    const altered = { envelope: { ...root.envelope, ciphertext: ciphertext.toString('base64url') } };
    await expect(verify([altered], root)).rejects.toThrow('проверить');
    const foreign = await forged(wrapper(original), id(), id());
    await expect(verify([foreign], root)).rejects.toThrow();
    const wrongVersion = await forged(wrapper(original, root.pin, { version: 2 }));
    await expect(verify([root, wrongVersion], root)).rejects.toThrow('проверить');
    const extraField = await forged(wrapper(original, root.pin, { token: 'private' }));
    await expect(verify([root, extraField], root)).rejects.toThrow('проверить');
  });

  it('не разрешает несколько родителей, самоциклы и замкнутые циклы', async () => {
    const root = await seal();
    await expect(seal(original, [root.pin])).rejects.toThrow();
    const merge = await forged(wrapper(original, [root.pin]));
    await expect(verify([root, merge], root)).rejects.toThrow('проверить');
    const cycleA = id();
    const cycleB = id();
    const a = await forged(wrapper(original, { versionId: cycleB, sha256: '1'.repeat(64) }), cycleA);
    const b = await forged(wrapper(original, { versionId: cycleA, sha256: '2'.repeat(64) }), cycleB);
    await expect(verify([root, a, b], root)).rejects.toThrow('цикл');
    await expect(seal(original, { versionId: cycleA, sha256: '0'.repeat(64) }, cycleA)).rejects.toThrow();
    const self = await forged(wrapper(original, { versionId: cycleA, sha256: '0'.repeat(64) }), cycleA);
    await expect(verify([root, self], root)).rejects.toThrow('проверить');
  });

  it('отклоняет личные поля и повреждённую структуру, не позволяя считать её публичным снимком', async () => {
    const root = await seal();
    const privateSnapshot = structuredClone(original);
    privateSnapshot.sections.planner.records[0].fields.password = 'PRIVATE_PASSWORD';
    await expect(seal(privateSnapshot, root.pin)).rejects.toThrow('история синхронизации');
    const privateVersion = await forged(wrapper(privateSnapshot, root.pin));
    await expect(verify([root, privateVersion], root)).rejects.toThrow('проверить');
    const incomplete = structuredClone(original);
    delete incomplete.sections.planner;
    await expect(seal(incomplete)).rejects.toThrow('история синхронизации');
    const invalidId = structuredClone(original);
    invalidId.sections.planner.records[0].id = 'invalid';
    await expect(seal(invalidId)).rejects.toThrow();
  });

  it('не позволяет использовать один sync-ID для разных типов сущностей в разных версиях', async () => {
    const root = await seal();
    const changedType = structuredClone(original);
    const characterId = changedType.sections.characters.records[0].id;
    changedType.sections.characters.records = [];
    changedType.sections.characters.order.active = [];
    changedType.sections.planner.records[0].id = characterId;
    changedType.sections.planner.order[0] = characterId;
    // Каждый снимок по отдельности структурно допустим, но идентичность в истории несовместима.
    const child = await seal(changedType, root.pin);
    await expect(verify([root, child], root)).rejects.toThrow('проверить');
  });

  it('отклоняет неизвестные версии и неправильно привязанные отпечатки при чтении', async () => {
    const root = await seal();
    const tree = await verify([root], root);
    const fake = { versionId: id(), sha256: '0'.repeat(64) };
    const changed = { ...root.pin, sha256: '0'.repeat(64) };
    expect(() => tree.publicSnapshot(fake)).toThrow('Версия не найдена');
    expect(() => tree.publicSnapshot(changed)).toThrow('Версия не найдена');
    expect(() => tree.commonAncestor(root.pin, changed)).toThrow('Версия не найдена');
  });

  it('копирует входы до первого await и не отдаёт изменяемые внутренние данные', async () => {
    const root = await seal();
    const child = await seal(original, root.pin);
    const rootPin = { ...root.pin };
    const childPin = { ...child.pin };
    const inputs = [structuredClone(root.envelope), structuredClone(child.envelope)];
    const knownPins = [{ ...childPin }];
    const promise = verifyHistory({
      envelopes: inputs,
      expectedDatasetId: datasetId,
      recoveryKey,
      root: rootPin,
      knownPins,
      cryptoSource
    });
    inputs[0].ciphertext = 'tampered';
    inputs[1].versionId = id();
    inputs.push({});
    rootPin.sha256 = '0'.repeat(64);
    knownPins[0].sha256 = '1'.repeat(64);
    const tree = await promise;
    expect(tree.commonAncestor(childPin, root.pin)).toEqual(root.pin);
    const first = tree.publicSnapshot(childPin);
    first.sections.planner.records[0].fields.title = 'изменено после проверки';
    expect(tree.publicSnapshot(childPin)).toEqual(original);
    const heads = tree.observedHeads();
    heads[0].sha256 = '2'.repeat(64);
    expect(tree.observedHeads()).toEqual([childPin]);
  });

  it('фиксирует содержимое снимка и родителя до завершения шифрования', async () => {
    const root = await seal();
    const snapshot = structuredClone(original);
    const parent = { ...root.pin };
    const promise = seal(snapshot, parent);
    snapshot.sections.planner.records[0].fields.title = 'не должно попасть в версию';
    parent.sha256 = '0'.repeat(64);
    const child = await promise;
    const tree = await verify([root, child], root);
    expect(tree.publicSnapshot(child.pin)).toEqual(original);
    expect(tree.commonAncestor(root.pin, child.pin)).toEqual(root.pin);
  });

  it('не вызывает getters, не допускает скрытые поля и не включает секреты в ошибки', async () => {
    const root = await seal();
    const getter = vi.fn(() => 'PRIVATE_TOKEN');
    const untrusted = { ...root.envelope };
    Object.defineProperty(untrusted, 'iv', { enumerable: true, get: getter });
    await expect(verify([{ envelope: untrusted }], root)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const badSnapshot = structuredClone(original);
    Object.defineProperty(badSnapshot.sections.planner.records[0].fields, 'title', { enumerable: true, get: getter });
    await expect(seal(badSnapshot)).rejects.not.toThrow('PRIVATE_TOKEN');
    expect(getter).not.toHaveBeenCalled();
    const extra = { ...root.envelope };
    Object.defineProperty(extra, 'hidden', { value: 'PRIVATE_TOKEN', enumerable: false });
    await expect(verify([{ envelope: extra }], root)).rejects.not.toThrow('PRIVATE_TOKEN');
  });

  it('ограничивает количество файлов и общий объём до декодирования ciphertext', async () => {
    const root = await seal();
    await expect(verify(Array(129).fill(root), root)).rejects.toThrow('история синхронизации');
    const huge = { ...root.envelope, ciphertext: 'A'.repeat(33 * 1024 * 1024) };
    await expect(
      verify(
        [huge, huge, huge].map(envelope => ({ envelope: { ...envelope, versionId: id() } })),
        root
      )
    ).rejects.toThrow('слишком большая');
  });

  it('находит ближайшего общего предка во множестве разветвлений без порядка и часов', async () => {
    const versions = [await seal()];
    const parentIndex = [-1];
    for (let index = 1; index < 32; index++) {
      // Детерминированная структура с несколькими разветвлениями и длинными цепочками.
      const parent = (index * 13 + 5) % index;
      parentIndex.push(parent);
      versions.push(await seal(original, versions[parent].pin));
    }
    const tree = await verify([...versions].reverse(), versions[0]);
    for (let left = 0; left < versions.length; left++) {
      for (let right = 0; right < versions.length; right++) {
        const ancestors = new Set();
        for (let i = left; i >= 0; i = parentIndex[i]) ancestors.add(i);
        let expected = right;
        while (!ancestors.has(expected)) expected = parentIndex[expected];
        expect(tree.commonAncestor(versions[left].pin, versions[right].pin)).toEqual(versions[expected].pin);
      }
    }
  });

  it('не выполняет сетевых вызовов и не сохраняет данные в Web Storage', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    try {
      const root = await seal();
      const child = await seal(original, root.pin);
      const tree = await verify([root, child], root, { knownPins: [root.pin] });
      tree.publicSnapshot(child.pin);
      expect(fetch).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      storage.mockRestore();
    }
  });
});
