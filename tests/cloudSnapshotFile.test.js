import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { sealHistoryVersion, sealFileSnapshot, verifyHistory } from '../js/modules/cloudSync/history.js';
import {
  snapshotFileHash,
  hasSnapshotFileMode,
  readSnapshotFileState,
  withSnapshotFileState
} from '../js/modules/cloudSync/snapshotFileState.js';
const cryptoSource = webcrypto,
  id = () => generateSyncId(cryptoSource);
let key, datasetId, original, root;
beforeAll(async () => {
  datasetId = id();
  key = await createKeyBundle({
    datasetId,
    primary: { kind: 'password', secret: 'Тестовый пароль обмена 123456' },
    backup: { kind: 'generated' },
    cryptoSource
  });
  const { ui, ...state } = normalizeState({
    characters: [
      { id: 'a', nick: 'А' },
      { id: 'b', nick: 'Б' }
    ],
    plannerEntries: [{ id: 'task', title: 'Задача', date: '2026-10-31' }]
  });
  original = buildPublicSnapshot(planSyncIdentities({ snapshot: state, cryptoSource }).snapshot);
  root = await sealHistoryVersion({
    publicSnapshot: original,
    parent: null,
    datasetId,
    versionId: id(),
    recoveryKey: key.dataKey,
    keyBundle: key.bundle,
    keyPin: key.pin,
    cryptoSource
  });
});
const seal = (snapshot, parent = root.pin, extra = {}) =>
  sealFileSnapshot({
    publicSnapshot: snapshot,
    parent,
    datasetId,
    versionId: id(),
    recoveryKey: key.dataKey,
    keyBundle: key.bundle,
    keyPin: key.pin,
    cryptoSource,
    ...extra
  });
const verify = versions =>
  verifyHistory({
    envelopes: versions.map(row => row.envelope),
    root: root.pin,
    knownPins: [root.pin],
    expectedDatasetId: datasetId,
    recoveryKey: key.dataKey,
    cryptoSource
  });
describe('полный зашифрованный файл', () => {
  it('принимает отсутствие персонажей и задач как содержимое нового файла', async () => {
    const empty = structuredClone(original);
    empty.sections.characters.records = [];
    empty.sections.characters.order = { active: [], archived: [] };
    empty.sections.planner.records = [];
    empty.sections.planner.order = [];
    const child = await seal(empty),
      history = await verify([root, child]);
    expect(history.isFileSnapshot(child.pin)).toBe(true);
    expect(history.publicSnapshot(child.pin)).toEqual(empty);
    expect(history.observedHeads()).toEqual([child.pin]);
    expect(JSON.stringify(child.envelope)).not.toContain('Задача');
  });
  it('не разрешает старому протоколу продолжать новый файл', async () => {
    const child = await seal(original);
    const downgraded = await sealHistoryVersion({
      publicSnapshot: original,
      parent: child.pin,
      datasetId,
      versionId: id(),
      recoveryKey: key.dataKey,
      cryptoSource
    });
    await expect(verify([root, child, downgraded])).rejects.toThrow();
  });
  it('не выбирает одну из двух конкурентных загрузок по дате', async () => {
    const a = await seal(original),
      b = await seal(original);
    const history = await verify([root, a, b]);
    expect(history.observedHeads()).toHaveLength(2);
  });
  it('отклоняет потерю родителя и изменение шифртекста', async () => {
    const child = await seal(original);
    await expect(verify([child])).rejects.toThrow();
    child.envelope.ciphertext = (child.envelope.ciphertext[0] === 'A' ? 'B' : 'A') + child.envelope.ciphertext.slice(1);
    await expect(verify([root, child])).rejects.toThrow();
  });
  it('считает одинаковыми перестановки объявлений записей, но замечает пользовательский порядок', async () => {
    const other = structuredClone(original);
    other.sections.characters.records.reverse();
    expect(await snapshotFileHash(other, cryptoSource)).toBe(await snapshotFileHash(original, cryptoSource));
    other.sections.characters.order.active.reverse();
    expect(await snapshotFileHash(other, cryptoSource)).not.toBe(await snapshotFileHash(original, cryptoSource));
  });
  it('хранит только pin и hash принятой версии; неизвестный формат отметки блокируется', () => {
    const settings = withSnapshotFileState({}, 'google', {
      version: 1,
      datasetId,
      acceptedPin: root.pin,
      acceptedHash: 'a'.repeat(64),
      pending: null
    });
    expect(readSnapshotFileState(settings, 'google', datasetId).acceptedPin).toEqual(root.pin);
    settings.cloudSnapshotFiles.google.version = 999;
    expect(() => readSnapshotFileState(settings, 'google', datasetId)).toThrow();
  });
  it('файловый режим одного диска не закрывает старую очередь другого', () => {
    const settings = withSnapshotFileState({}, 'google', {
      version: 1,
      datasetId,
      acceptedPin: root.pin,
      acceptedHash: 'a'.repeat(64),
      pending: null
    });
    expect(hasSnapshotFileMode(settings, 'google')).toBe(true);
    expect(hasSnapshotFileMode(settings, 'yandex')).toBe(false);
    settings.cloudSnapshotFiles.google.acceptedHash += '\n';
    expect(() => readSnapshotFileState(settings, 'google', datasetId)).toThrow();
  });
});
