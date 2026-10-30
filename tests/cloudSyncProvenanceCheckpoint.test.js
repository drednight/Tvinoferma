// Перезапуск в модели: зашифрованный checkpoint, независимые отметки и проверенное дерево.
// Это НЕ тест файлового сохранения, атомарности, vault или реального облака.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import {
  decryptSnapshot,
  encryptSnapshot,
  generateRecoveryKey,
  generateSyncId
} from '../js/modules/cloudSync/envelope.js';
import { sealHistoryVersion, verifyHistory } from '../js/modules/cloudSync/history.js';
import {
  createPlannerCandidateReview,
  restorePlannerCandidateCheckpoint
} from '../js/modules/cloudSync/plannerCandidate.js';
import { sealFieldProvenanceCheckpoint } from '../js/modules/cloudSync/fieldProvenanceReview.js';

const id = () => generateSyncId(webcrypto);
const day = '2026-11-08';
const selections = ['planner', 'eventReminders'];
let datasetId, datasetKey, deviceId, checkpointKey, localState, plannerId, root, local, remote, versions;

const publicSnapshot = snapshot => buildPublicSnapshot(snapshot, { settingsSelections: selections });
const seal = (snapshot, parent = null) =>
  sealHistoryVersion({
    publicSnapshot: snapshot,
    parent,
    datasetId,
    recoveryKey: datasetKey,
    versionId: id(),
    cryptoSource: webcrypto
  });
const verify = items =>
  verifyHistory({
    envelopes: items.map(item => item.envelope),
    expectedDatasetId: datasetId,
    recoveryKey: datasetKey,
    root: root.pin,
    knownPins: [local.pin, remote.pin],
    cryptoSource: webcrypto
  });
const paths = review => review.changes().map(change => change.path.join('/'));

beforeEach(async () => {
  datasetId = id();
  datasetKey = generateRecoveryKey(webcrypto);
  deviceId = id();
  checkpointKey = generateRecoveryKey(webcrypto); // отдельный ключ модели устройства
  const state = normalizeState({
    schemaVersion: 10,
    characters: [
      { id: 'hero', nick: 'Личное имя', contacts: { email: 'private@example.test', password: 'PRIVATE-PASSWORD' } }
    ],
    plannerEntries: [
      {
        id: 'task',
        title: 'Личное название задачи',
        date: '2026-11-01',
        time: '18:00',
        recurrence: 'weekly',
        statusByDate: { [day]: 'todo' },
        createdAt: '2026-10-01T12:00:00.000Z',
        updatedAt: '2026-10-01T12:00:00.000Z'
      }
    ]
  });
  const { ui, ...snapshot } = state;
  localState = planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot;
  plannerId = localState.plannerEntries[0].syncId;
  const base = publicSnapshot(localState);
  root = await seal(base);
  local = await seal(base, root.pin);
  const incoming = structuredClone(base);
  const row = incoming.sections.planner.records.find(item => item.id === plannerId);
  row.fields.time = '20:30';
  row.fields.statusByDate[day] = 'done';
  remote = await seal(incoming, root.pin);
  versions = [root, local, remote];
});

async function partial() {
  const history = await verify(versions);
  const initial = createPlannerCandidateReview({ history, localPin: local.pin, remotePin: remote.pin, id: plannerId });
  const proposal = initial.plan({ snapshot: localState, selected: [['statusByDate', day]] });
  const nextState = proposal.candidateState();
  const savedModelVersion = await seal(proposal.candidatePublicSnapshot(), local.pin);
  const nextVersions = [...versions, savedModelVersion];
  const nextHistory = await verify(nextVersions);
  const next = proposal.bindModel({ history: nextHistory, localPin: savedModelVersion.pin, remotePin: remote.pin });
  const checkpoint = await next.sealCheckpoint({ datasetId, deviceId, checkpointKey, cryptoSource: webcrypto });
  return { initial, next, nextState, savedModelVersion, nextVersions, nextHistory, checkpoint };
}

function restoreOptions({ checkpoint, nextState, savedModelVersion, history }) {
  return {
    envelope: checkpoint.envelope,
    checkpointKey,
    expectedCheckpointPin: checkpoint.pin,
    expectedDatasetId: datasetId,
    expectedDeviceId: deviceId,
    expectedRootPin: root.pin,
    expectedLocalPin: savedModelVersion.pin,
    expectedRemotePin: remote.pin,
    expectedKnownPins: [root.pin, local.pin, remote.pin, savedModelVersion.pin],
    localPublicSnapshot: publicSnapshot(nextState),
    history,
    cryptoSource: webcrypto
  };
}

// Для тестов повреждённого содержимого независимо пересчитываем отметку конверта.
// Это НЕ доверенный источник: настоящая отметка не должна обновляться из файла.
function untrustedFingerprint(envelope) {
  return {
    versionId: envelope.versionId,
    sha256: createHash('sha256')
      .update(
        JSON.stringify([
          'tvinoferma-provenance-checkpoint-envelope-sha256-v1',
          envelope.format,
          envelope.version,
          envelope.algorithm,
          envelope.datasetId,
          envelope.versionId,
          envelope.iv,
          envelope.ciphertext
        ])
      )
      .digest('hex')
  };
}
async function repack(checkpoint, edit) {
  const payload = await decryptSnapshot({
    envelope: checkpoint.envelope,
    recoveryKey: checkpointKey,
    expectedDatasetId: datasetId,
    cryptoSource: webcrypto
  });
  edit(payload);
  const envelope = await encryptSnapshot({
    snapshot: payload,
    recoveryKey: checkpointKey,
    datasetId,
    versionId: id(),
    cryptoSource: webcrypto
  });
  return { envelope, pin: untrustedFingerprint(envelope) };
}

describe('экспериментальное восстановление происхождения календаря', () => {
  it('после сериализации и повторной проверки дерева сохраняет выбранную отметку и ожидающее время', async () => {
    const { initial, next, nextState, savedModelVersion, nextVersions, checkpoint } = await partial();
    expect(() => initial.changes()).toThrow('уже заменён');
    expect(paths(next)).toEqual(['time']);
    const file = JSON.parse(JSON.stringify(checkpoint.envelope));
    const trustedPin = JSON.parse(JSON.stringify(checkpoint.pin));
    const historyAfterRestart = await verify(JSON.parse(JSON.stringify(nextVersions)));
    const restored = await restorePlannerCandidateCheckpoint({
      ...restoreOptions({
        checkpoint: { envelope: file, pin: trustedPin },
        nextState,
        savedModelVersion,
        history: historyAfterRestart
      })
    });
    expect(restored.origins()).toEqual([{ path: ['statusByDate', day], source: remote.pin }]);
    expect(paths(restored)).toEqual(['time']);
    const second = restored.plan({ snapshot: nextState, selected: [['time']] });
    expect(second.status).toBe('prepared');
    expect(second.candidateState().plannerEntries[0]).toMatchObject({ time: '20:30', statusByDate: { [day]: 'done' } });
    expect(second.candidateState().characters[0].contacts.password).toBe('PRIVATE-PASSWORD');
    expect(paths(restored)).toEqual(['time']); // предложение ещё не подтверждено даже в модели
    const serialized = JSON.stringify(checkpoint);
    for (const secret of [
      'Личное название задачи',
      'Личное имя',
      'private@example.test',
      'PRIVATE-PASSWORD',
      checkpointKey,
      datasetKey,
      'statusByDate'
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('после перезапуска помнит базу принятого поля и обнаруживает новую конкурентную правку', async () => {
    const { next, nextState, savedModelVersion, nextVersions, nextHistory } = await partial();
    const edited = structuredClone(nextState);
    edited.plannerEntries[0].statusByDate[day] = 'doing';
    const editedVersion = await seal(publicSnapshot(edited), savedModelVersion.pin);
    const versions1 = [...nextVersions, editedVersion];
    const history1 = await verify(versions1);
    const refreshed = next.refreshModel({ history: history1, localPin: editedVersion.pin, remotePin: remote.pin });
    const checkpoint = await refreshed.sealCheckpoint({ datasetId, deviceId, checkpointKey, cryptoSource: webcrypto });
    const restored = await restorePlannerCandidateCheckpoint(
      restoreOptions({ checkpoint, nextState: edited, savedModelVersion: editedVersion, history: history1 })
    );
    expect(paths(restored)).toEqual(['time']);
    const second = restored.plan({ snapshot: edited, selected: [['time']] });
    expect(second.candidateState().plannerEntries[0].statusByDate[day]).toBe('doing');
    const finalLocal = await seal(second.candidatePublicSnapshot(), editedVersion.pin);
    const history2 = await verify([...versions1, finalLocal]);
    const accepted = second.bindModel({ history: history2, localPin: finalLocal.pin, remotePin: remote.pin });
    const newerPublic = nextHistory.publicSnapshot(remote.pin);
    newerPublic.sections.planner.records[0].fields.statusByDate[day] = 'todo';
    const newerRemote = await seal(newerPublic, remote.pin);
    const history3 = await verify([...versions1, finalLocal, newerRemote]);
    const advanced = accepted.refreshModel({ history: history3, localPin: finalLocal.pin, remotePin: newerRemote.pin });
    expect(advanced.changes()).toContainEqual({
      path: ['statusByDate', day],
      kind: 'conflict',
      reason: 'concurrent-edit',
      source: newerRemote.pin
    });
    expect(advanced.plan({ snapshot: second.candidateState(), selected: [['statusByDate', day]] }).status).toBe(
      'needs_review'
    );
  });

  it('не принимает подменённый ciphertext, чужой ключ, устройство, набор, корень и отпечаток', async () => {
    const { nextState, savedModelVersion, nextHistory, checkpoint } = await partial();
    const options = restoreOptions({ checkpoint, nextState, savedModelVersion, history: nextHistory });
    const wrongCipher = structuredClone(checkpoint.envelope);
    wrongCipher.ciphertext = (wrongCipher.ciphertext[0] === 'A' ? 'B' : 'A') + wrongCipher.ciphertext.slice(1);
    const cases = [
      { envelope: wrongCipher },
      { checkpointKey: generateRecoveryKey(webcrypto) },
      { checkpointKey: datasetKey }, // общий ключ набора не открывает независимый checkpoint
      { expectedDeviceId: id() },
      { expectedDatasetId: id() },
      { expectedRootPin: local.pin },
      { expectedCheckpointPin: { ...checkpoint.pin, sha256: '0'.repeat(64) } },
      { expectedCheckpointPin: { ...checkpoint.pin, versionId: id() } },
      { history: {} }
    ];
    for (const changed of cases)
      await expect(restorePlannerCandidateCheckpoint({ ...options, ...changed })).rejects.toThrow();
  });

  it('не возобновляет просмотр при изменившейся локальной проекции или независимых версиях', async () => {
    const { nextState, savedModelVersion, nextHistory, checkpoint } = await partial();
    const options = restoreOptions({ checkpoint, nextState, savedModelVersion, history: nextHistory });
    const changed = structuredClone(options.localPublicSnapshot);
    changed.sections.planner.records[0].fields.title = 'Поздняя локальная правка';
    await expect(restorePlannerCandidateCheckpoint({ ...options, localPublicSnapshot: changed })).rejects.toThrow(
      'Локальные данные изменились'
    );
    await expect(restorePlannerCandidateCheckpoint({ ...options, expectedLocalPin: local.pin })).rejects.toThrow();
    await expect(restorePlannerCandidateCheckpoint({ ...options, expectedRemotePin: root.pin })).rejects.toThrow();
  });

  it('требует все независимо известные версии даже в формально проверенной усечённой истории', async () => {
    const { nextState, savedModelVersion, nextHistory, checkpoint } = await partial();
    const previouslySeen = await seal(publicSnapshot(localState), root.pin);
    const options = restoreOptions({ checkpoint, nextState, savedModelVersion, history: nextHistory });
    await expect(
      restorePlannerCandidateCheckpoint({
        ...options,
        expectedKnownPins: [...options.expectedKnownPins, previouslySeen.pin]
      })
    ).rejects.toThrow('Версия не найдена');
    await expect(
      restorePlannerCandidateCheckpoint({ ...options, expectedKnownPins: [{ ...remote.pin, sha256: '0'.repeat(64) }] })
    ).rejects.toThrow('Версия не найдена');
    await expect(
      restorePlannerCandidateCheckpoint({ ...options, expectedKnownPins: [root.pin, root.pin] })
    ).rejects.toThrow();
  });

  it('не маскирует известную более новую облачную ветку', async () => {
    const { nextState, savedModelVersion, nextVersions, checkpoint } = await partial();
    const advanced = await seal(publicSnapshot(localState), remote.pin);
    const history = await verify([...nextVersions, advanced]);
    const options = restoreOptions({ checkpoint, nextState, savedModelVersion, history });
    await expect(restorePlannerCandidateCheckpoint(options)).rejects.toThrow('новая версия');
  });

  it('отвергает старый checkpoint при сохранённой независимо новой отметке', async () => {
    const { next, nextState, savedModelVersion, nextVersions, nextHistory, checkpoint } = await partial();
    const second = next.plan({ snapshot: nextState, selected: [['time']] });
    const version2 = await seal(second.candidatePublicSnapshot(), savedModelVersion.pin);
    const history2 = await verify([...nextVersions, version2]);
    const review2 = second.bindModel({ history: history2, localPin: version2.pin, remotePin: remote.pin });
    const later = await review2.sealCheckpoint({ datasetId, deviceId, checkpointKey, cryptoSource: webcrypto });
    const options = restoreOptions({ checkpoint, nextState, savedModelVersion, history: nextHistory });
    await expect(restorePlannerCandidateCheckpoint({ ...options, expectedCheckpointPin: later.pin })).rejects.toThrow();
    // Сбой между записью нового checkpoint и локального состояния: версии не согласованы.
    await expect(
      restorePlannerCandidateCheckpoint({
        ...options,
        history: history2,
        envelope: later.envelope,
        expectedCheckpointPin: later.pin
      })
    ).rejects.toThrow();
    // И обратный порядок: состояние уже изменилось, а checkpoint остался старым.
    await expect(
      restorePlannerCandidateCheckpoint({
        ...options,
        history: history2,
        expectedLocalPin: version2.pin,
        expectedKnownPins: [...options.expectedKnownPins, version2.pin],
        localPublicSnapshot: second.candidatePublicSnapshot()
      })
    ).rejects.toThrow();
    // Откат и файла, и якобы «доверенной» отметки вместе здесь НЕ обнаруживается.
    expect(paths(await restorePlannerCandidateCheckpoint(options))).toEqual(['time']);
  });

  it.each([
    ['путь', payload => (payload.model.origins[0].path = ['__proto__'])],
    ['пустой путь', payload => (payload.model.origins[0].path = [])],
    ['слишком длинный путь', payload => (payload.model.origins[0].path = Array(65).fill('x'))],
    ['слишком длинная часть пути', payload => (payload.model.origins[0].path = ['x'.repeat(257)])],
    [
      'несуществующий источник',
      payload => (payload.model.origins[0].source = { versionId: id(), sha256: 'a'.repeat(64) })
    ],
    ['источник не содержит поле', payload => (payload.model.origins[0].path = ['noSuchField'])],
    ['другую запись', payload => (payload.model.id = id())],
    ['незнакомую версию формата', payload => (payload.version = 2)]
  ])('отклоняет структурно неверное содержимое: %s', async (_label, edit) => {
    const { nextState, savedModelVersion, nextHistory, checkpoint } = await partial();
    const bad = await repack(checkpoint, edit);
    const options = restoreOptions({ checkpoint: bad, nextState, savedModelVersion, history: nextHistory });
    await expect(restorePlannerCandidateCheckpoint(options)).rejects.toThrow();
  });

  it('не усекает слишком большое число решений и не расшифровывает чрезмерно большой файл', async () => {
    const { nextState, savedModelVersion, nextHistory, checkpoint } = await partial();
    const many = await repack(checkpoint, payload => {
      payload.model.origins = Array.from({ length: 10_001 }, () => payload.model.origins[0]);
    });
    await expect(
      restorePlannerCandidateCheckpoint(
        restoreOptions({ checkpoint: many, nextState, savedModelVersion, history: nextHistory })
      )
    ).rejects.toThrow();
    const tooLarge = await repack(checkpoint, payload => (payload.extra = 'x'.repeat(2 * 1024 * 1024)));
    await expect(
      restorePlannerCandidateCheckpoint(
        restoreOptions({ checkpoint: tooLarge, nextState, savedModelVersion, history: nextHistory })
      )
    ).rejects.toThrow();
  });

  it('не принимает поддельную модель или getters в метаданных', async () => {
    await expect(
      sealFieldProvenanceCheckpoint({ review: {}, datasetId, deviceId, checkpointKey, cryptoSource: webcrypto })
    ).rejects.toThrow();
    const { nextState, savedModelVersion, nextHistory, checkpoint } = await partial();
    const options = restoreOptions({ checkpoint, nextState, savedModelVersion, history: nextHistory });
    const getter = vi.fn(() => 'PRIVATE');
    const unsafe = structuredClone(options.localPublicSnapshot);
    Object.defineProperty(unsafe.sections.planner.records[0].fields, 'time', { enumerable: true, get: getter });
    await expect(restorePlannerCandidateCheckpoint({ ...options, localPublicSnapshot: unsafe })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('фиксирует переданные снимок, конверт и отпечатки до асинхронной проверки', async () => {
    const { nextState, savedModelVersion, nextHistory, checkpoint } = await partial();
    const options = restoreOptions({
      checkpoint: structuredClone(checkpoint),
      nextState,
      savedModelVersion,
      history: nextHistory
    });
    options.expectedRootPin = { ...options.expectedRootPin };
    options.expectedLocalPin = { ...options.expectedLocalPin };
    options.expectedRemotePin = { ...options.expectedRemotePin };
    let release;
    const gate = new Promise(resolve => (release = resolve));
    const subtle = {
      digest: async (...args) => {
        await gate;
        return webcrypto.subtle.digest(...args);
      },
      importKey: (...args) => webcrypto.subtle.importKey(...args),
      decrypt: (...args) => webcrypto.subtle.decrypt(...args)
    };
    const delayedCrypto = { subtle, getRandomValues: value => webcrypto.getRandomValues(value) };
    const restoring = restorePlannerCandidateCheckpoint({ ...options, cryptoSource: delayedCrypto });
    options.envelope.ciphertext = 'A';
    options.expectedCheckpointPin.sha256 = '0'.repeat(64);
    options.expectedLocalPin.sha256 = '0'.repeat(64);
    options.localPublicSnapshot.sections.planner.records[0].fields.time = '00:00';
    release();
    expect(paths(await restoring)).toEqual(['time']);
  });

  it('не выдаёт checkpoint старого бизнес-просмотра после его замены во время шифрования', async () => {
    const { next, nextHistory, savedModelVersion } = await partial();
    let release;
    const gate = new Promise(resolve => (release = resolve));
    const subtle = {
      importKey: async (...args) => {
        await gate;
        return webcrypto.subtle.importKey(...args);
      },
      encrypt: (...args) => webcrypto.subtle.encrypt(...args),
      digest: (...args) => webcrypto.subtle.digest(...args)
    };
    const delayedCrypto = { subtle, getRandomValues: value => webcrypto.getRandomValues(value) };
    const sealing = next.sealCheckpoint({ datasetId, deviceId, checkpointKey, cryptoSource: delayedCrypto });
    next.refreshModel({ history: nextHistory, localPin: savedModelVersion.pin, remotePin: remote.pin });
    release();
    await expect(sealing).rejects.toThrow('уже заменён');
  });
});
