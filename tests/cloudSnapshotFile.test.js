import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { generateSyncId, encryptSnapshot } from '../js/modules/cloudSync/envelope.js';
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
  it('явный выбор полного файла связывает все конкурирующие heads, не объединяя поля', async () => {
    const a = await seal(original),
      b = await seal(original);
    const selected = structuredClone(original);
    selected.sections.characters.records[0].fields.notes = 'ВЫБРАННЫЙ ФАЙЛ';
    const chosen = await seal(selected, a.pin, { replacedHeads: [b.pin] });
    const history = await verify([root, a, b, chosen]);
    expect(history.observedHeads()).toEqual([chosen.pin]);
    expect(history.replacedHeads(chosen.pin)).toEqual([b.pin]);
    expect(history.covers(chosen.pin, b.pin)).toBe(true);
    expect(history.publicSnapshot(chosen.pin)).toEqual(selected);
    const next = await seal(selected, chosen.pin);
    expect((await verify([root, a, b, chosen, next])).observedHeads()).toEqual([next.pin]);
    await expect(verify([root, a, chosen])).rejects.toThrow();
  });
  it.each(['empty', 'duplicate', 'parent', 'ancestor', 'missing', 'wrongHash', 'oldVersion'])(
    'отклоняет некорректное подтверждение heads: %s',
    async kind => {
      const a = await seal(original),
        b = await seal(original);
      let refs = [b.pin],
        version = 6;
      if (kind === 'empty') refs = [];
      if (kind === 'duplicate') refs = [b.pin, b.pin];
      if (kind === 'parent') refs = [a.pin];
      if (kind === 'ancestor') refs = [root.pin];
      if (kind === 'missing') refs = [{ ...b.pin, versionId: id() }];
      if (kind === 'wrongHash') refs = [{ ...b.pin, sha256: '0'.repeat(64) }];
      if (kind === 'oldVersion') version = 5;
      const envelope = await encryptSnapshot({
        snapshot: {
          format: 'tvinoferma-public-history',
          version,
          parent: a.pin,
          publicSnapshot: original,
          replacedHeads: refs
        },
        recoveryKey: key.dataKey,
        datasetId,
        versionId: id(),
        cryptoSource
      });
      await expect(verify([root, a, b, { envelope }])).rejects.toThrow();
    }
  );
  it('отметки снятых ожиданий строги и не содержат открытого снимка или ключа', () => {
    const row = {
      version: 2,
      datasetId,
      acceptedPin: root.pin,
      acceptedHash: 'a'.repeat(64),
      pending: null,
      unsettled: [
        {
          pin: { versionId: id(), sha256: 'b'.repeat(64) },
          parent: root.pin,
          fileId: 'SYNTHETIC_FILE',
          contentHash: 'c'.repeat(64)
        }
      ]
    };
    const settings = withSnapshotFileState({}, 'google', row);
    expect(readSnapshotFileState(settings, 'google', datasetId)).toEqual(row);
    for (const patch of [
      { unsettled: [...row.unsettled, ...row.unsettled] },
      { version: 1 },
      { unsettled: [{ ...row.unsettled[0], contentHash: 'c'.repeat(64) + '\n' }] },
      { unsettled: [{ ...row.unsettled[0], secret: 'never' }] }
    ])
      expect(() =>
        readSnapshotFileState({ cloudSnapshotFiles: { google: { ...row, ...patch } } }, 'google', datasetId)
      ).toThrow();
  });
});
