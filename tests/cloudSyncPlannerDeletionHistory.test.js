// Проверка явных меток удаления в экспериментальном дереве, без файлов и облака.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { prepareCloudReview } from '../js/modules/cloudSync/cloudReview.js';
import { encryptSnapshot, generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import {
  sealHistoryVersion,
  sealHistoryVersionWithPlannerDeletions,
  sealHistoryChildWithPlannerTombstones,
  verifyHistory
} from '../js/modules/cloudSync/history.js';

const id = () => generateSyncId(webcrypto);
let datasetId, recoveryKey, initial, initialState, taskId, secondId, root;
const seal = (snapshot, parent = null) =>
  sealHistoryVersion({
    publicSnapshot: snapshot,
    parent,
    datasetId,
    versionId: id(),
    recoveryKey,
    cryptoSource: webcrypto
  });
const verify = versions =>
  verifyHistory({
    envelopes: versions.map(item => item.envelope),
    expectedDatasetId: datasetId,
    root: root.pin,
    knownPins: [root.pin],
    recoveryKey,
    cryptoSource: webcrypto
  });
const without = (snapshot, ...ids) => {
  const result = structuredClone(snapshot);
  result.sections.planner.records = result.sections.planner.records.filter(item => !ids.includes(item.id));
  result.sections.planner.order = result.sections.planner.order.filter(item => !ids.includes(item));
  return result;
};
const review = async (versions, localSnapshot) => {
  const files = new Map(versions.map(item => [item.envelope.versionId, item.envelope]));
  return prepareCloudReview({
    provider: 'yandex',
    datasetId,
    dataKey: recoveryKey,
    rootPin: root.pin,
    knownPins: [root.pin],
    localSnapshot,
    localSavedAt: null,
    cryptoSource: webcrypto,
    session: {
      listWithDates: async () => ({
        status: 'listed',
        versions: [...files.keys()].map(versionId => ({ versionId, modifiedAt: null }))
      }),
      read: async versionId => ({ status: 'found', envelope: files.get(versionId) })
    }
  });
};
const deletionOptions = (history, changes = {}) => ({
  history,
  publicSnapshot: without(initial, taskId),
  parent: root.pin,
  deletedIds: [taskId],
  confirmedDeletion: true,
  datasetId,
  versionId: id(),
  recoveryKey,
  cryptoSource: webcrypto,
  ...changes
});
const forge = async (payload, versionId = id()) => ({
  envelope: await encryptSnapshot({ snapshot: payload, datasetId, recoveryKey, versionId, cryptoSource: webcrypto })
});
const v2 = (changes = {}) => ({
  format: 'tvinoferma-public-history',
  version: 2,
  parent: root.pin,
  publicSnapshot: without(initial, taskId),
  plannerDeletedIds: [taskId],
  ...changes
});

beforeEach(async () => {
  datasetId = id();
  recoveryKey = generateRecoveryKey(webcrypto);
  const state = normalizeState({
    schemaVersion: 10,
    plannerEntries: [
      { id: 'one', title: 'Личное событие', date: '2026-11-01', time: '18:00', recurrence: 'weekly' },
      { id: 'two', title: 'Невыбранная задача', date: '2026-11-02', time: '20:00' }
    ]
  });
  const { ui, ...snapshot } = state;
  const planned = planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot;
  taskId = planned.plannerEntries[0].syncId;
  secondId = planned.plannerEntries[1].syncId;
  initialState = planned;
  initial = buildPublicSnapshot(planned);
  root = await seal(initial);
});

describe('явное удаление в проверяемой экспериментальной истории', () => {
  it('применяет только явно выбранную v3-метку, а отсутствие, legacy и ветви не разрешают удаление', async () => {
    const child = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot: without(initial, taskId),
      parent: root.pin,
      parentSnapshot: initial,
      previousTombstones: [],
      deletedIds: [taskId],
      confirmedDeletion: true,
      datasetId,
      versionId: id(),
      recoveryKey,
      cryptoSource: webcrypto
    });
    const checked = await review([root, child], initial);
    const choices = {
      localState: initialState,
      selectedRecords: [],
      selectedPlannerDeletions: [taskId],
      cryptoSource: webcrypto
    };
    expect(checked.compare(child.pin).differences.entries).toContainEqual(
      expect.objectContaining({ id: taskId, deletionSelectable: true })
    );
    const plan = checked.prepareApply(child.pin, choices);
    expect(plan.candidateState().plannerEntries.map(entry => entry.syncId)).toEqual([secondId]);
    expect(plan.selectedCount).toBe(1);
    expect(initialState.plannerEntries).toHaveLength(2);
    expect(() => checked.prepareApply(child.pin, { ...choices, selectedPlannerDeletions: [secondId] })).toThrow();
    const absent = await seal(without(initial, taskId), root.pin);
    const absentReview = await review([root, absent], initial);
    expect(() => absentReview.prepareApply(absent.pin, choices)).toThrow();
    const legacy = await sealHistoryVersionWithPlannerDeletions(deletionOptions(await verify([root])));
    const legacyReview = await review([root, legacy], initial);
    expect(() => legacyReview.prepareApply(legacy.pin, choices)).toThrow();
    const branched = await review([root, child, absent], initial);
    expect(() => branched.prepareApply(child.pin, choices)).toThrow();
    expect(branched.compare(child.pin).differences.entries).toContainEqual(
      expect.objectContaining({ id: taskId, deletionSelectable: false })
    );
  });

  it('сохраняет накопленные отметки удаления во всех последующих версиях', async () => {
    const child = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot: without(initial, taskId),
      parent: root.pin,
      parentSnapshot: initial,
      previousTombstones: [],
      deletedIds: [taskId],
      confirmedDeletion: true,
      datasetId,
      versionId: id(),
      recoveryKey,
      cryptoSource: webcrypto
    });
    const descendant = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot: without(initial, taskId),
      parent: child.pin,
      parentSnapshot: without(initial, taskId),
      previousTombstones: [taskId],
      deletedIds: [],
      confirmedDeletion: false,
      datasetId,
      versionId: id(),
      recoveryKey,
      cryptoSource: webcrypto
    });
    const second = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot: without(initial, taskId, secondId),
      parent: descendant.pin,
      parentSnapshot: without(initial, taskId),
      previousTombstones: [taskId],
      deletedIds: [secondId],
      confirmedDeletion: true,
      datasetId,
      versionId: id(),
      recoveryKey,
      cryptoSource: webcrypto
    });
    const verified = await verify([second, root, descendant, child]);
    expect(verified.plannerDeletions(child.pin)).toEqual([taskId]);
    expect(verified.plannerDeletions(descendant.pin)).toEqual([]);
    expect(verified.plannerTombstones(descendant.pin)).toEqual([taskId]);
    expect(verified.plannerTombstones(second.pin)).toEqual([taskId, secondId].sort());
    expect(JSON.stringify(second.envelope)).not.toContain(taskId);
    expect(JSON.stringify(second.envelope)).not.toContain('Личное событие');
    const checked = await review([root, child, descendant, second], initial);
    expect(
      checked.compare(second.pin).differences.entries.filter(entry => entry.kind === 'marked_cloud_deletion')
    ).toHaveLength(2);
  });

  it('не создаёт потомка с потерянной отметкой, неподтверждённым удалением или восстановленным ID', async () => {
    const args = {
      publicSnapshot: without(initial, taskId),
      parent: root.pin,
      parentSnapshot: initial,
      previousTombstones: [],
      deletedIds: [taskId],
      confirmedDeletion: true,
      datasetId,
      recoveryKey,
      cryptoSource: webcrypto
    };
    for (const changes of [
      { confirmedDeletion: false },
      { deletedIds: [] },
      { deletedIds: [secondId] },
      { previousTombstones: [taskId] },
      { publicSnapshot: without(initial, taskId, secondId) },
      {
        parentSnapshot: without(initial, taskId),
        publicSnapshot: initial,
        previousTombstones: [taskId],
        deletedIds: []
      }
    ])
      await expect(sealHistoryChildWithPlannerTombstones({ ...args, ...changes, versionId: id() })).rejects.toThrow();
  });

  it('не доверяет подмене накопленных меток, пропущенному удалению или старому формату потомка', async () => {
    const child = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot: without(initial, taskId),
      parent: root.pin,
      parentSnapshot: initial,
      previousTombstones: [],
      deletedIds: [taskId],
      confirmedDeletion: true,
      datasetId,
      versionId: id(),
      recoveryKey,
      cryptoSource: webcrypto
    });
    const current = without(initial, taskId);
    const payload = {
      format: 'tvinoferma-public-history',
      version: 3,
      parent: child.pin,
      publicSnapshot: current,
      plannerDeletedIds: [],
      plannerTombstones: [taskId]
    };
    for (const changes of [
      { plannerTombstones: [] },
      { plannerTombstones: [secondId] },
      { plannerTombstones: [taskId, secondId].sort() },
      { publicSnapshot: initial },
      { publicSnapshot: without(initial, taskId, secondId) },
      { plannerDeletedIds: [secondId] }
    ]) {
      const forged = await forge({ ...payload, ...changes });
      await expect(verify([root, child, forged])).rejects.toThrow();
    }
    const old = await seal(current, child.pin);
    await expect(verify([root, child, old])).rejects.toThrow();
  });

  it('хранит ID внутри шифрования и связывает удаление с непосредственным родителем', async () => {
    const history = await verify([root]);
    const deletion = await sealHistoryVersionWithPlannerDeletions(deletionOptions(history));
    const verified = await verify([deletion, root]);
    expect(verified.lineage(deletion.pin)).toEqual([root.pin, deletion.pin]);
    expect(verified.plannerRecord(root.pin, taskId).fields.title).toBe('Личное событие');
    expect(verified.plannerRecord(deletion.pin, taskId)).toBeNull();
    expect(verified.plannerRecord(deletion.pin, secondId).fields.title).toBe('Невыбранная задача');
    expect(verified.plannerDeletions(root.pin)).toEqual([]);
    expect(verified.plannerDeletions(deletion.pin)).toEqual([taskId]);
    expect(JSON.stringify(deletion.envelope)).not.toContain('Личное событие');
    expect(JSON.stringify(deletion.envelope)).not.toContain(taskId);
    const leaked = verified.plannerDeletions(deletion.pin);
    leaked[0] = id();
    const order = verified.plannerOrder(deletion.pin);
    order.length = 0;
    const pins = verified.pins();
    pins[0].sha256 = '0'.repeat(64);
    expect(verified.plannerDeletions(deletion.pin)).toEqual([taskId]);
    expect(verified.plannerOrder(deletion.pin)).toEqual([secondId]);
    expect(verified.pins()).not.toContainEqual(pins[0]);
  });

  it('показывает отметку удаления только в выбранной проверенной линии и не применяет её', async () => {
    const history = await verify([root]);
    const deletion = await sealHistoryVersionWithPlannerDeletions(deletionOptions(history));
    const descendant = await seal(without(initial, taskId), deletion.pin);
    // Другая ветвь может не содержать запись без подтверждённой отметки.
    const sibling = await seal(without(initial, taskId), root.pin);
    const checked = await review([root, deletion, descendant, sibling], initial);
    expect(checked.status).toBe('ready_for_review');
    expect(checked.compare(root.pin).differences.entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'marked_cloud_deletion' })])
    );
    for (const pin of [deletion.pin, descendant.pin]) {
      const comparison = checked.compare(pin);
      expect(comparison.differences.entries).toContainEqual(
        expect.objectContaining({
          section: 'planner',
          id: taskId,
          kind: 'marked_cloud_deletion',
          label: 'Личное событие'
        })
      );
      expect(comparison.localRecord('planner', taskId).fields.title).toBe('Личное событие');
      expect(comparison.cloudRecord('planner', taskId)).toBeNull();
    }
    expect(checked.compare(sibling.pin).differences.entries).toContainEqual(
      expect.objectContaining({ id: taskId, kind: 'only_local' })
    );
    expect(initial.sections.planner.records.some(row => row.id === taskId)).toBe(true);
    expect(checked.prepareConservativeAdoption(deletion.pin, root.pin, {}).status).toBe('not_unique_head');
  });

  it('обычное отсутствие в версии 1 не превращает в метку удаления', async () => {
    const disappeared = await seal(without(initial, taskId), root.pin);
    const verified = await verify([root, disappeared]);
    expect(verified.plannerRecord(disappeared.pin, taskId)).toBeNull();
    expect(verified.plannerDeletions(disappeared.pin)).toEqual([]);
  });

  it('не принимает основу даже при точном совпадении, если в истории исчез ID или есть метка удаления', async () => {
    const local = without(initial, taskId);
    const disappeared = await seal(local, root.pin);
    const missingReview = await review([root, disappeared], local);
    expect(missingReview.status).toBe('ready_for_review');
    expect(missingReview.prepareExactAdoption(disappeared.pin, {})).toEqual({ status: 'deletions_unsupported' });

    const history = await verify([root]);
    const deletion = await sealHistoryVersionWithPlannerDeletions(deletionOptions(history));
    const deletionReview = await review([root, deletion], local);
    expect(deletionReview.prepareExactAdoption(deletion.pin, {})).toEqual({ status: 'deletions_unsupported' });
  });

  it('не выбирает победителя, если видны две ветви с одинаковым содержимым', async () => {
    const first = await seal(initial, root.pin);
    const second = await seal(initial, root.pin);
    const value = await review([root, first, second], initial);
    expect(value.status).toBe('ready_for_review');
    expect(value.prepareExactAdoption(first.pin, {})).toEqual({ status: 'not_unique_head' });
    expect(value.prepareExactAdoption(second.pin, {})).toEqual({ status: 'not_unique_head' });
  });

  it('требует явного выбора и точного набора отсутствующих записей', async () => {
    const history = await verify([root]);
    const original = JSON.stringify(initial);
    const requests = [
      { confirmedDeletion: false },
      { deletedIds: [] },
      { deletedIds: [taskId, taskId] },
      { deletedIds: [secondId] },
      { deletedIds: [taskId, secondId] },
      { deletedIds: [id()] },
      { publicSnapshot: initial },
      { publicSnapshot: without(initial, taskId, secondId) },
      { history: {} },
      { datasetId: id() },
      { parent: { ...root.pin, sha256: '0'.repeat(64) } }
    ];
    for (const changed of requests) {
      await expect(sealHistoryVersionWithPlannerDeletions(deletionOptions(history, changed))).rejects.toThrow();
    }
    expect(JSON.stringify(initial)).toBe(original);
  });

  it('поддерживает несколько явно выбранных удалений без потери других разделов', async () => {
    const history = await verify([root]);
    const result = await sealHistoryVersionWithPlannerDeletions(
      deletionOptions(history, { publicSnapshot: without(initial, taskId, secondId), deletedIds: [secondId, taskId] })
    );
    const verified = await verify([root, result]);
    expect(new Set(verified.plannerDeletions(result.pin))).toEqual(new Set([taskId, secondId]));
    expect(verified.publicSnapshot(result.pin).sections.characters).toEqual(initial.sections.characters);
  });

  it.each([
    ['нет меток', () => v2({ plannerDeletedIds: [] })],
    ['повторные метки', () => v2({ plannerDeletedIds: [taskId, taskId] })],
    ['неверный ID', () => v2({ plannerDeletedIds: ['not-an-id'] })],
    ['помечено другое', () => v2({ plannerDeletedIds: [secondId] })],
    ['запись осталась', () => v2({ publicSnapshot: initial })],
    ['не всё отсутствие помечено', () => v2({ publicSnapshot: without(initial, taskId, secondId) })],
    ['нет родителя', () => v2({ parent: null })],
    ['устаревший формат с дополнительным полем', () => v2({ version: 1 })],
    ['неизвестная версия', () => v2({ version: 3 })],
    ['лишнее поле', () => v2({ hidden: 'x' })]
  ])('не принимает неподходящую расшифрованную версию: %s', async (_label, payload) => {
    const altered = await forge(payload());
    await expect(verify([root, altered])).rejects.toThrow();
  });

  it('не позволяет незаметно восстановить тот же ID в потомке метки, но оставляет соседнюю ветку', async () => {
    const history = await verify([root]);
    const deletion = await sealHistoryVersionWithPlannerDeletions(deletionOptions(history));
    const sibling = await seal(initial, root.pin);
    const returned = await seal(initial, deletion.pin);
    const valid = await verify([root, deletion, sibling]);
    expect(valid.plannerRecord(sibling.pin, taskId)).not.toBeNull();
    await expect(verify([root, deletion, sibling, returned])).rejects.toThrow();
  });

  it('фиксирует входы до первого await и не вызывает getter в неподходящем снимке', async () => {
    const history = await verify([root]);
    const options = deletionOptions(history);
    const pending = sealHistoryVersionWithPlannerDeletions(options);
    options.deletedIds[0] = secondId;
    options.publicSnapshot.sections.planner.order.length = 0;
    const result = await pending;
    expect((await verify([root, result])).plannerDeletions(result.pin)).toEqual([taskId]);

    const unsafe = without(initial, taskId);
    const getter = vi.fn(() => 'SECRET');
    Object.defineProperty(unsafe.sections.planner.records[0].fields, 'title', { enumerable: true, get: getter });
    await expect(
      sealHistoryVersionWithPlannerDeletions(deletionOptions(history, { publicSnapshot: unsafe }))
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
