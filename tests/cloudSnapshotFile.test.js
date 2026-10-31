import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { createKeyBundle } from '../js/modules/cloudSync/keyBundle.js';
import { generateSyncId, encryptSnapshot, decryptSnapshot } from '../js/modules/cloudSync/envelope.js';
import {
  sealHistoryVersion,
  sealFileSnapshot,
  sealHistoryCheckpoint,
  verifyHistory
} from '../js/modules/cloudSync/history.js';
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
  it('полный файл может исключить контакты только явно удалённых персонажей через v7', async () => {
    const characterId = original.sections.characters.records[0].id;
    const parent = await seal(original, root.pin, {
      privateSnapshot: { schemaVersion: 1, records: [{ characterId, fields: { password: 'SYNTHETIC_PRIVATE' } }] }
    });
    const target = structuredClone(original);
    target.sections.characters.records = target.sections.characters.records.filter(row => row.id !== characterId);
    target.sections.characters.order.active = target.sections.characters.order.active.filter(id => id !== characterId);
    const missingConsent = await seal(target, parent.pin);
    await expect(verify([root, parent, missingConsent])).rejects.toThrow();
    const pruned = await seal(target, parent.pin, { privatePrunedIds: [characterId] });
    const history = await verify([root, parent, pruned]);
    expect(history.privateSnapshot(pruned.pin)).toBeNull();
    expect(history.privatePrunedIds(pruned.pin)).toEqual([characterId]);
    expect(history.isFileSnapshot(pruned.pin)).toBe(true);
    const next = await seal(target, pruned.pin);
    expect((await verify([root, parent, pruned, next])).observedHeads()).toEqual([next.pin]);
  });
  it('не позволяет v7 удалять секреты оставшегося персонажа или указывать чужой ID', async () => {
    const characterId = original.sections.characters.records[0].id,
      parent = await seal(original, root.pin, {
        privateSnapshot: { schemaVersion: 1, records: [{ characterId, fields: { password: 'PRIVATE' } }] }
      });
    for (const privatePrunedIds of [[characterId], [id()]]) {
      const child = await seal(original, parent.pin, { privatePrunedIds });
      await expect(verify([root, parent, child])).rejects.toThrow();
    }
  });
  it('v7 сохраняет явный выбор нескольких файлов при удалении персонажа', async () => {
    const characterId = original.sections.characters.records[0].id;
    const parent = await seal(original, root.pin, {
        privateSnapshot: { schemaVersion: 1, records: [{ characterId, fields: { password: 'PRIVATE' } }] }
      }),
      other = await seal(original);
    const target = structuredClone(original);
    target.sections.characters.records = target.sections.characters.records.filter(row => row.id !== characterId);
    target.sections.characters.order.active = target.sections.characters.order.active.filter(id => id !== characterId);
    const chosen = await seal(target, parent.pin, { replacedHeads: [other.pin], privatePrunedIds: [characterId] });
    const history = await verify([root, parent, other, chosen]);
    expect(history.observedHeads()).toEqual([chosen.pin]);
    expect(history.covers(chosen.pin, other.pin)).toBe(true);
  });
  it('контрольный полный файл читается с root без старых ciphertext и помнит точные старые pin', async () => {
    const first = await seal(original),
      before = await verify([root, first]),
      cp = await sealHistoryCheckpoint({
        history: before,
        source: first.pin,
        archiveSha256: 'a'.repeat(64),
        datasetId,
        recoveryKey: key.dataKey,
        versionId: id(),
        keyBundle: key.bundle,
        keyPin: key.pin,
        cryptoSource
      });
    const history = await verifyHistory({
      envelopes: [root.envelope, cp.envelope],
      expectedDatasetId: datasetId,
      root: root.pin,
      knownPins: [first.pin],
      recoveryKey: key.dataKey,
      cryptoSource
    });
    expect(history.observedHeads()).toEqual([cp.pin]);
    expect(history.publicSnapshot(cp.pin)).toEqual(original);
    expect(history.covers(cp.pin, first.pin)).toBe(true);
    expect(history.hasSnapshot(first.pin)).toBe(false);
    expect(() => history.publicSnapshot(first.pin)).toThrow();
    const next = await seal(original, cp.pin);
    expect((await verify([root, cp, next])).observedHeads()).toEqual([next.pin]);
  });
  it('контрольная версия сохраняет приватные значения, а не добавляет местные секреты', async () => {
    const secret = {
        schemaVersion: 1,
        records: [{ characterId: original.sections.characters.records[0].id, fields: { password: 'CLOUD_ONLY' } }]
      },
      first = await seal(original, root.pin, { privateSnapshot: secret }),
      before = await verify([root, first]);
    const cp = await sealHistoryCheckpoint({
      history: before,
      source: first.pin,
      archiveSha256: 'a'.repeat(64),
      datasetId,
      recoveryKey: key.dataKey,
      versionId: id(),
      keyBundle: key.bundle,
      keyPin: key.pin,
      cryptoSource
    });
    expect((await verify([root, cp])).privateSnapshot(cp.pin)).toEqual(secret);
    expect((await verify([root, first, cp])).observedHeads()).toEqual([cp.pin]);
  });
  const checkpoint = (history, source) =>
    sealHistoryCheckpoint({
      history,
      source,
      archiveSha256: 'a'.repeat(64),
      datasetId,
      recoveryKey: key.dataKey,
      versionId: id(),
      keyBundle: key.bundle,
      keyPin: key.pin,
      cryptoSource
    });
  it('помнит тип исчезнувшего UUID даже после удаления всех файлов, где он встречался', async () => {
    const introduced = structuredClone(original),
      newId = id(),
      record = structuredClone(introduced.sections.characters.records[0]);
    record.id = newId;
    introduced.sections.characters.records.push(record);
    introduced.sections.characters.order.active.push(newId);
    const a = await seal(introduced),
      b = await seal(original, a.pin),
      cp = await checkpoint(await verify([root, a, b]), b.pin),
      reuse = structuredClone(original),
      task = structuredClone(reuse.sections.planner.records[0]);
    task.id = newId;
    reuse.sections.planner.records.push(task);
    reuse.sections.planner.order.push(newId);
    const next = await seal(reuse, cp.pin);
    await expect(verify([root, cp, next])).rejects.toThrow();
  });
  it('повторное сокращение сохраняет накопленные pin/типы и не требует предыдущего checkpoint', async () => {
    const a = await seal(original),
      cp = await checkpoint(await verify([root, a]), a.pin),
      b = await seal(original, cp.pin),
      next = await checkpoint(await verify([root, cp, b]), b.pin);
    const compacted = await verifyHistory({
      envelopes: [root.envelope, next.envelope],
      expectedDatasetId: datasetId,
      root: root.pin,
      knownPins: [a.pin, cp.pin, b.pin],
      recoveryKey: key.dataKey,
      cryptoSource
    });
    expect(compacted.observedHeads()).toEqual([next.pin]);
    expect(compacted.retiredPins()).toHaveLength(3);
  });
  it('не скрывает позднюю неизвестную голову; отсутствующий старый родитель требует восстановления архива', async () => {
    const a = await seal(original),
      cp = await checkpoint(await verify([root, a]), a.pin),
      late = await seal(original, a.pin),
      parallel = await seal(original);
    await expect(verify([root, cp, late])).rejects.toThrow();
    const fork = await verify([root, cp, parallel]);
    expect(fork.observedHeads()).toHaveLength(2);
    await expect(checkpoint(fork, cp.pin)).rejects.toThrow();
  });
  it.each(['root', 'self', 'wrongKnown', 'differentSource', 'duplicate', 'incompleteTypes', 'newlineHash'])(
    'отклоняет повреждённое authenticated retirement: %s',
    async kind => {
      const a = await seal(original),
        cp = await checkpoint(await verify([root, a]), a.pin);
      if (kind === 'wrongKnown') {
        await expect(
          verifyHistory({
            envelopes: [root.envelope, cp.envelope],
            expectedDatasetId: datasetId,
            root: root.pin,
            knownPins: [{ ...a.pin, sha256: '0'.repeat(64) }],
            recoveryKey: key.dataKey,
            cryptoSource
          })
        ).rejects.toThrow();
        return;
      }
      const payload = await decryptSnapshot({
        envelope: cp.envelope,
        expectedDatasetId: datasetId,
        recoveryKey: key.dataKey,
        cryptoSource
      });
      if (kind === 'root') payload.checkpoint.retiredPins.push(root.pin);
      if (kind === 'self') payload.checkpoint.retiredPins.push(cp.pin);
      if (kind === 'differentSource') payload.publicSnapshot.sections.characters.records[0].fields.notes = 'OTHER';
      if (kind === 'duplicate') payload.checkpoint.retiredPins.push(a.pin);
      if (kind === 'incompleteTypes') payload.checkpoint.identities = [];
      if (kind === 'newlineHash') payload.checkpoint.archiveSha256 += '\n';
      const changed = {
        envelope: await encryptSnapshot({
          snapshot: payload,
          datasetId,
          versionId: cp.pin.versionId,
          recoveryKey: key.dataKey,
          keyCapsule: cp.envelope.keyCapsule,
          cryptoSource
        })
      };
      await expect(verify([root, a, changed])).rejects.toThrow();
    }
  );
  it('разрешает 129-й физический файл только как authenticated overlap; 129 обычных файлов отвергаются', async () => {
    const chain = [root];
    for (let n = 1; n < 129; n++) chain.push(await seal(original, chain.at(-1).pin));
    await expect(verify(chain)).rejects.toThrow();
    chain.pop();
    const cp = await checkpoint(await verify(chain), chain.at(-1).pin);
    const history = await verify([...chain, cp]);
    expect(history.pins()).toHaveLength(129);
    expect(history.observedHeads()).toEqual([cp.pin]);
  });
});
