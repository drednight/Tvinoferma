// Изолированное намерение и диагностика сбоя: приложение, облако и vault не изменяются.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  inspectPlannerCommitIntent,
  preparePlannerCommitIntent,
  publishPlannerCommitIntent,
  readPublishedPlannerCommitIntent
} from '../js/modules/cloudSync/plannerCommitJournal.js';
import { tryBrowserSyncOperation } from '../js/modules/cloudSync/browserCoordination.js';

const id = () => generateSyncId(webcrypto);
const day = '2026-11-08';
const settingsSelections = ['planner', 'eventReminders'];
const publicState = snapshot => buildPublicSnapshot(snapshot, { settingsSelections });
let scenario;

function memoryStorage() {
  const records = new Map();
  return {
    failRead: false,
    failBefore: false,
    failAfter: false,
    corruptReadback: false,
    writes: 0,
    getItem(key) {
      if (this.failRead) throw new Error('PRIVATE-INTERNAL-READ');
      const value = records.get(key) ?? null;
      return this.corruptReadback && this.writes ? 'DAMAGED' : value;
    },
    setItem(key, value) {
      this.writes++;
      if (this.failBefore) throw new Error('PRIVATE-INTERNAL-WRITE');
      records.set(key, String(value));
      if (this.failAfter) throw new Error('PRIVATE-INTERNAL-WRITE');
    },
    raw() {
      return [...records.values()];
    },
    key() {
      return [...records.keys()][0];
    }
  };
}

async function createScenario() {
  const datasetId = id();
  const datasetKey = generateRecoveryKey(webcrypto);
  const checkpointKey = generateRecoveryKey(webcrypto);
  const intentKey = generateRecoveryKey(webcrypto);
  const deviceId = id();
  const state = normalizeState({
    schemaVersion: 10,
    characters: [
      {
        id: 'LOCAL-HERO',
        nick: 'Личное имя',
        contacts: { email: 'PRIVATE@example.test', password: 'PRIVATE-PASSWORD', phone: 'PRIVATE-PHONE' },
        launch: { gcPath: '/PRIVATE/LOCAL/PATH' }
      }
    ],
    plannerEntries: [
      {
        id: 'LOCAL-TASK',
        title: 'Личная повторяющаяся задача',
        date: '2026-11-01',
        time: '18:00',
        recurrence: 'weekly',
        statusByDate: { [day]: 'todo' },
        createdAt: '2026-10-28T12:00:00.000Z',
        updatedAt: '2026-10-28T12:00:00.000Z'
      },
      {
        id: 'LOCAL-OTHER',
        title: 'Неизменяемая заметка',
        date: '2026-11-03',
        createdAt: '2026-10-28T12:00:00.000Z',
        updatedAt: '2026-10-28T12:00:00.000Z'
      }
    ]
  });
  const { ui, ...raw } = state;
  const localState = planSyncIdentities({ snapshot: raw, cryptoSource: webcrypto }).snapshot;
  const plannerId = localState.plannerEntries[0].syncId;
  const base = publicState(localState);
  const seal = (publicSnapshot, parent = null) =>
    sealHistoryVersion({
      publicSnapshot,
      parent,
      recoveryKey: datasetKey,
      datasetId,
      versionId: id(),
      cryptoSource: webcrypto
    });
  const root = await seal(base);
  const local = await seal(base, root.pin);
  const incoming = structuredClone(base);
  const row = incoming.sections.planner.records.find(item => item.id === plannerId);
  row.fields.time = '20:30';
  row.fields.statusByDate[day] = 'done';
  const remote = await seal(incoming, root.pin);
  const verify = versions =>
    verifyHistory({
      envelopes: versions.map(version => version.envelope),
      root: root.pin,
      knownPins: [root.pin, local.pin, remote.pin],
      expectedDatasetId: datasetId,
      recoveryKey: datasetKey,
      cryptoSource: webcrypto
    });
  const beforeHistory = await verify([root, local, remote]);
  const review = createPlannerCandidateReview({
    history: beforeHistory,
    localPin: local.pin,
    remotePin: remote.pin,
    id: plannerId
  });
  const beforeCheckpoint = await review.sealCheckpoint({ datasetId, deviceId, checkpointKey, cryptoSource: webcrypto });
  const preview = review.plan({ snapshot: localState, selected: [['statusByDate', day]] });
  const afterVersion = await seal(preview.candidatePublicSnapshot(), local.pin);
  const versions = [root, local, remote, afterVersion];
  const history = await verify(versions);
  const prepareOptions = {
    stateBeforeRaw: JSON.stringify(localState),
    checkpointBeforeRaw: JSON.stringify(beforeCheckpoint.envelope),
    expectedCheckpointBeforePin: beforeCheckpoint.pin,
    history,
    datasetId,
    deviceId,
    rootPin: root.pin,
    localBeforePin: local.pin,
    localAfterPin: afterVersion.pin,
    remotePin: remote.pin,
    expectedKnownPins: [root.pin, local.pin, remote.pin],
    selected: [['statusByDate', day]],
    checkpointKey,
    intentKey,
    cryptoSource: webcrypto
  };
  const prepared = await preparePlannerCommitIntent(prepareOptions);
  const inspectOptions = {
    envelope: prepared.envelope(),
    expectedIntentPin: prepared.pin(),
    stateRaw: prepareOptions.stateBeforeRaw,
    checkpointRaw: prepareOptions.checkpointBeforeRaw,
    history,
    datasetId,
    deviceId,
    rootPin: root.pin,
    localBeforePin: local.pin,
    remotePin: remote.pin,
    expectedCheckpointBeforePin: beforeCheckpoint.pin,
    expectedKnownPins: [root.pin, local.pin, remote.pin],
    checkpointKey,
    intentKey,
    cryptoSource: webcrypto
  };
  return {
    datasetId,
    datasetKey,
    checkpointKey,
    intentKey,
    deviceId,
    localState,
    plannerId,
    root,
    local,
    remote,
    afterVersion,
    versions,
    beforeCheckpoint,
    history,
    seal,
    verify,
    prepareOptions,
    inspectOptions,
    prepared
  };
}

// Модель повреждённого файла с пересчитанным pin — НЕ доверенный якорь в приложении.
async function repackIntent(s, mutate) {
  const original = s.prepared.envelope();
  const payload = await decryptSnapshot({
    envelope: original,
    recoveryKey: s.intentKey,
    expectedDatasetId: s.datasetId,
    cryptoSource: webcrypto
  });
  mutate(payload);
  const envelope = await encryptSnapshot({
    snapshot: payload,
    recoveryKey: s.intentKey,
    datasetId: s.datasetId,
    versionId: original.versionId,
    cryptoSource: webcrypto
  });
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        'tvinoferma-planner-commit-intent-sha256-v1',
        envelope.format,
        envelope.version,
        envelope.algorithm,
        envelope.datasetId,
        envelope.versionId,
        envelope.iv,
        envelope.ciphertext
      ])
    )
    .digest('hex');
  return { envelope, expectedIntentPin: { versionId: envelope.versionId, sha256: fingerprint } };
}

beforeEach(async () => {
  scenario = await createScenario();
});
afterEach(() => vi.restoreAllMocks());

describe('зашифрованное намерение для частичного обновления календаря', () => {
  it('связывает точное полное состояние и checkpoint, не записывая и не раскрывая личные данные', async () => {
    const s = scenario;
    expect(s.prepared.status).toBe('prepared');
    const candidate = JSON.parse(s.prepared.candidateStateJson());
    expect(candidate.plannerEntries[0].statusByDate[day]).toBe('done');
    expect(candidate.plannerEntries[0].time).toBe('18:00'); // невыбранное время остаётся ожидающим
    expect(candidate.plannerEntries[1]).toEqual(s.localState.plannerEntries[1]);
    expect(candidate.characters[0].contacts.password).toBe('PRIVATE-PASSWORD');
    expect(candidate.characters[0].launch.gcPath).toBe('/PRIVATE/LOCAL/PATH');
    expect(JSON.parse(s.prepareOptions.stateBeforeRaw)).toEqual(s.localState);
    expect(JSON.stringify(s.prepared)).toBe('{"status":"prepared"}');
    const serialized = JSON.stringify(s.prepared.envelope());
    for (const secret of [
      'PRIVATE-PASSWORD',
      'PRIVATE@example.test',
      '/PRIVATE/LOCAL/PATH',
      'Личная повторяющаяся задача',
      'statusByDate',
      s.checkpointKey,
      s.intentKey,
      s.datasetKey
    ])
      expect(serialized).not.toContain(secret);

    const restored = await restorePlannerCandidateCheckpoint({
      envelope: JSON.parse(s.prepared.checkpointAfterJson()),
      checkpointKey: s.checkpointKey,
      expectedCheckpointPin: s.prepared.checkpointAfterPin(),
      expectedDatasetId: s.datasetId,
      expectedDeviceId: s.deviceId,
      expectedRootPin: s.root.pin,
      expectedLocalPin: s.afterVersion.pin,
      expectedRemotePin: s.remote.pin,
      expectedKnownPins: s.inspectOptions.expectedKnownPins,
      localPublicSnapshot: publicState(candidate),
      history: s.history,
      cryptoSource: webcrypto
    });
    expect(restored.changes().map(change => change.path.join('/'))).toEqual(['time']);
    expect(restored.origins().map(change => change.path.join('/'))).toEqual([`statusByDate/${day}`]);
    const remaining = restored.plan({ snapshot: candidate, selected: [['time']] });
    expect(remaining.status).toBe('prepared');
    expect(remaining.candidateState().plannerEntries[0].time).toBe('20:30');
    expect(remaining.candidateState().plannerEntries[0].statusByDate[day]).toBe('done');
    expect(remaining.candidateState().characters[0].contacts.password).toBe('PRIVATE-PASSWORD');
  });

  it('различает четыре комбинации и не выдаёт ни одну за разрешение записи', async () => {
    const s = scenario;
    const afterState = s.prepared.candidateStateJson();
    const afterCheckpoint = s.prepared.checkpointAfterJson();
    const before = await inspectPlannerCommitIntent(s.inspectOptions);
    const stateAhead = await inspectPlannerCommitIntent({ ...s.inspectOptions, stateRaw: afterState });
    const checkpointAhead = await inspectPlannerCommitIntent({ ...s.inspectOptions, checkpointRaw: afterCheckpoint });
    const after = await inspectPlannerCommitIntent({
      ...s.inspectOptions,
      stateRaw: afterState,
      checkpointRaw: afterCheckpoint
    });
    expect(before).toEqual({
      status: 'pair_matches_before',
      otherKnownBranches: false,
      pendingCount: 2,
      action: 'manual_review'
    });
    expect(stateAhead).toEqual({
      status: 'state_ahead',
      otherKnownBranches: false,
      pendingCount: null,
      action: 'manual_review'
    });
    expect(checkpointAhead).toEqual({
      status: 'checkpoint_ahead',
      otherKnownBranches: false,
      pendingCount: null,
      action: 'manual_review'
    });
    expect(after).toEqual({
      status: 'pair_matches_after',
      otherKnownBranches: false,
      pendingCount: 1,
      action: 'manual_review'
    });
  });

  it('принимает форматированный JSON без потери данных, но сравнивает точные исходные байты', async () => {
    const s = scenario;
    const prettyRaw = `\r\n${JSON.stringify(s.localState, null, 2)}\n`;
    const prepared = await preparePlannerCommitIntent({ ...s.prepareOptions, stateBeforeRaw: prettyRaw });
    const options = {
      ...s.inspectOptions,
      envelope: prepared.envelope(),
      expectedIntentPin: prepared.pin(),
      stateRaw: prettyRaw
    };
    expect((await inspectPlannerCommitIntent(options)).status).toBe('pair_matches_before');
    expect((await inspectPlannerCommitIntent({ ...options, stateRaw: s.prepareOptions.stateBeforeRaw })).status).toBe(
      'unrecognized'
    );
    const candidate = JSON.parse(prepared.candidateStateJson());
    expect(candidate.characters[0]).toEqual(s.localState.characters[0]);
    expect(candidate.plannerEntries[0].time).toBe('18:00');
    expect(candidate.plannerEntries[0].statusByDate[day]).toBe('done');
    expect(
      (
        await inspectPlannerCommitIntent({
          ...options,
          stateRaw: prepared.candidateStateJson(),
          checkpointRaw: prepared.checkpointAfterJson()
        })
      ).status
    ).toBe('pair_matches_after');
  });

  it('принимает отсортированные ключи и форматирование в стиле serde_json без потери локальных сведений', async () => {
    const sortKeys = value => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map(key => [key, sortKeys(value[key])])
      );
    };
    const raw = JSON.stringify(sortKeys(scenario.localState), null, 2).replaceAll('\n', '\r\n');
    const prepared = await preparePlannerCommitIntent({ ...scenario.prepareOptions, stateBeforeRaw: raw });
    const result = JSON.parse(prepared.candidateStateJson());
    expect(result.characters).toEqual(scenario.localState.characters);
    expect(result.plannerEntries[1]).toEqual(scenario.localState.plannerEntries[1]);
    expect(result.plannerEntries[0].statusByDate[day]).toBe('done');
  });

  it('не путает escape, скобки, цифры и двоеточия внутри приватных строк с JSON-структурой', async () => {
    const local = structuredClone(scenario.localState);
    local.characters[0].contacts.password = '"password": {"x": 10.0000000000000001} \\u0073 [\\"]';
    const raw = JSON.stringify(local, null, 2).replace('"schemaVersion": 10', '"\\u0073chemaVersion": 1.0e1');
    const prepared = await preparePlannerCommitIntent({ ...scenario.prepareOptions, stateBeforeRaw: raw });
    expect(JSON.parse(prepared.candidateStateJson()).characters[0].contacts.password).toBe(
      local.characters[0].contacts.password
    );
    expect(JSON.parse(prepared.candidateStateJson()).plannerEntries[0].time).toBe('18:00');
  });

  it.each(['10.0', '1e1', '1000e-2', '0.1e2', '1.00E+1'])(
    'принимает точную десятичную форму числа %s',
    async number => {
      const raw = scenario.prepareOptions.stateBeforeRaw.replace('"schemaVersion":10', `"schemaVersion":${number}`);
      const prepared = await preparePlannerCommitIntent({ ...scenario.prepareOptions, stateBeforeRaw: raw });
      expect(prepared.status).toBe('prepared');
      expect(JSON.parse(prepared.candidateStateJson()).schemaVersion).toBe(10);
    }
  );

  it('замечает смену приватного поля, хотя публичная проекция не изменилась', async () => {
    const s = scenario;
    const modified = JSON.parse(s.prepareOptions.stateBeforeRaw);
    modified.characters[0].contacts.password = 'NEW-PRIVATE-PASSWORD';
    expect(publicState(modified)).toEqual(publicState(s.localState));
    expect(await inspectPlannerCommitIntent({ ...s.inspectOptions, stateRaw: JSON.stringify(modified) })).toEqual({
      status: 'unrecognized',
      otherKnownBranches: false,
      action: 'manual_review'
    });
    const freshlyPrepared = await preparePlannerCommitIntent({
      ...s.prepareOptions,
      stateBeforeRaw: JSON.stringify(modified)
    });
    expect(JSON.parse(freshlyPrepared.candidateStateJson()).characters[0].contacts.password).toBe(
      'NEW-PRIVATE-PASSWORD'
    );
  });

  it('не принимает некорректный или отсутствующий исходный checkpoint и неподходящий ключ', async () => {
    const s = scenario;
    const examples = [
      { checkpointBeforeRaw: '{bad' },
      { checkpointBeforeRaw: '' },
      { expectedCheckpointBeforePin: { ...s.beforeCheckpoint.pin, sha256: '0'.repeat(64) } },
      { checkpointKey: generateRecoveryKey(webcrypto) },
      { deviceId: id() },
      { intentKey: s.checkpointKey }
    ];
    for (const changes of examples)
      await expect(preparePlannerCommitIntent({ ...s.prepareOptions, ...changes })).rejects.toThrow();
  });

  it('останавливается при неверных данных состояния, геттеров не читает и не включает секреты в ошибки', async () => {
    const s = scenario;
    const raw = s.prepareOptions.stateBeforeRaw;
    const duplicatedKey = raw.replace('{', '{"schemaVersion":10,');
    const duplicatedEscaped = raw.replace('"schemaVersion":10', '"schemaVersion":10,"\\u0073chemaVersion":10');
    const duplicatedNested = raw.replace('"contacts":{', '"contacts":{"password":"PRIVATE-PASSWORD",');
    const roundedNumber = raw.replace('"schemaVersion":10', '"schemaVersion":10.000000000000000001');
    const deeplyShadowed = raw.replace(
      '"schemaVersion":10',
      `"schemaVersion":${'['.repeat(70)}0${']'.repeat(70)},"schemaVersion":10`
    );
    for (const original of [duplicatedKey, duplicatedEscaped, duplicatedNested, roundedNumber, deeplyShadowed]) {
      expect(JSON.parse(original)).toEqual(s.localState); // JSON.parse без дополнительной проверки теряет проблему
    }
    const vaultState = JSON.stringify({ ...s.localState, secretsInVault: true });
    for (const stateBeforeRaw of [
      '{broken',
      '[]',
      '{"__proto__":{}}',
      '{"x":Infinity}',
      `{"x":"\ud800"}`,
      duplicatedKey,
      duplicatedEscaped,
      duplicatedNested,
      roundedNumber,
      deeplyShadowed,
      vaultState,
      ' '.repeat(32 * 1024 * 1024 + 1)
    ]) {
      await expect(preparePlannerCommitIntent({ ...s.prepareOptions, stateBeforeRaw })).rejects.toThrow();
    }
    const changed = JSON.parse(s.prepareOptions.stateBeforeRaw);
    changed.plannerEntries[0].title = 'SECRET-INVALID';
    await expect(
      preparePlannerCommitIntent({ ...s.prepareOptions, stateBeforeRaw: JSON.stringify(changed) })
    ).rejects.toThrow();
    try {
      await preparePlannerCommitIntent({ ...s.prepareOptions, stateBeforeRaw: JSON.stringify(changed) });
    } catch (error) {
      expect(String(error)).not.toContain('SECRET-INVALID');
      expect(String(error)).not.toContain('PRIVATE-PASSWORD');
    }
    const getter = vi.fn(() => ['time']);
    const selected = [];
    Object.defineProperty(selected, 0, { enumerable: true, configurable: true, get: getter });
    selected.length = 1;
    await expect(preparePlannerCommitIntent({ ...s.prepareOptions, selected })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('пустой выбор не создаёт ни намерение, ни checkpoint', async () => {
    const result = await preparePlannerCommitIntent({ ...scenario.prepareOptions, selected: [] });
    expect(result).toEqual({ status: 'blocked', reason: 'review_required' });
  });

  it('требует непосредственную локальную версию с именно выбранным кандидатом', async () => {
    const s = scenario;
    await expect(preparePlannerCommitIntent({ ...s.prepareOptions, localAfterPin: s.local.pin })).rejects.toThrow();
    const altered = publicState(s.localState);
    altered.sections.planner.records[0].fields.title = 'Иное изменение';
    const wrong = await s.seal(altered, s.local.pin);
    const wrongHistory = await s.verify([s.root, s.local, s.remote, wrong]);
    await expect(
      preparePlannerCommitIntent({ ...s.prepareOptions, history: wrongHistory, localAfterPin: wrong.pin })
    ).rejects.toThrow();
    const intermediate = await s.seal(publicState(s.localState), s.local.pin);
    const indirect = await s.seal(s.history.publicSnapshot(s.afterVersion.pin), intermediate.pin);
    const indirectHistory = await s.verify([s.root, s.local, s.remote, intermediate, indirect]);
    await expect(
      preparePlannerCommitIntent({ ...s.prepareOptions, history: indirectHistory, localAfterPin: indirect.pin })
    ).rejects.toThrow();
  });

  it('блокирует другую известную ветку и проверяет независимые прежние отметки', async () => {
    const s = scenario;
    const sibling = await s.seal(publicState(s.localState), s.root.pin);
    const history = await s.verify([...s.versions, sibling]);
    await expect(
      preparePlannerCommitIntent({
        ...s.prepareOptions,
        history,
        expectedKnownPins: [...s.prepareOptions.expectedKnownPins, sibling.pin]
      })
    ).rejects.toThrow(/ветка/);
    for (const expectedKnownPins of [
      [],
      [s.root.pin, s.local.pin],
      [s.root.pin, s.remote.pin],
      [s.root.pin, s.local.pin, s.remote.pin, s.root.pin]
    ]) {
      await expect(preparePlannerCommitIntent({ ...s.prepareOptions, expectedKnownPins })).rejects.toThrow();
    }
    await expect(
      inspectPlannerCommitIntent({ ...s.inspectOptions, expectedKnownPins: [s.root.pin, s.local.pin] })
    ).rejects.toThrow();
    const hidden = await s.seal(publicState(s.localState), s.root.pin);
    await expect(
      inspectPlannerCommitIntent({
        ...s.inspectOptions,
        expectedKnownPins: [...s.inspectOptions.expectedKnownPins, hidden.pin]
      })
    ).rejects.toThrow();
    const truncated = await s.verify([s.root, s.local, s.remote]);
    await expect(inspectPlannerCommitIntent({ ...s.inspectOptions, history: truncated })).rejects.toThrow();
  });

  it('при обнаружении дополнительной ветки после подготовки требует отдельного разбора', async () => {
    const s = scenario;
    const sibling = await s.seal(publicState(s.localState), s.root.pin);
    const history = await s.verify([...s.versions, sibling]);
    const result = await inspectPlannerCommitIntent({
      ...s.inspectOptions,
      history,
      expectedKnownPins: [...s.inspectOptions.expectedKnownPins, sibling.pin]
    });
    expect(result).toEqual({
      status: 'pair_matches_before',
      otherKnownBranches: true,
      pendingCount: 2,
      action: 'manual_review'
    });
  });

  it('не принимает подмену конверта, отметки, набора, устройства, корня или ключа', async () => {
    const s = scenario;
    const tampered = structuredClone(s.prepared.envelope());
    tampered.ciphertext = (tampered.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.ciphertext.slice(1);
    const cases = [
      { envelope: tampered },
      { expectedIntentPin: { ...s.prepared.pin(), sha256: '0'.repeat(64) } },
      { datasetId: id() },
      { deviceId: id() },
      { rootPin: { ...s.root.pin, sha256: '0'.repeat(64) } },
      { expectedCheckpointBeforePin: { ...s.beforeCheckpoint.pin, sha256: '0'.repeat(64) } },
      { intentKey: generateRecoveryKey(webcrypto) },
      { checkpointKey: generateRecoveryKey(webcrypto) },
      { history: {} }
    ];
    for (const change of cases)
      await expect(inspectPlannerCommitIntent({ ...s.inspectOptions, ...change })).rejects.toThrow();
  });

  it.each([
    ['неизвестная версия', payload => (payload.version = 9)],
    ['лишнее поле', payload => (payload.unexpected = 'SECRET')],
    ['другой компьютер', payload => (payload.deviceId = id())],
    ['поддельный корень', payload => (payload.rootPin.sha256 = '0'.repeat(64))],
    ['отсутствующий локальный отпечаток', payload => (payload.knownPins = [payload.rootPin])],
    ['непосредственный потомок заменён', payload => (payload.localAfterPin = payload.localBeforePin)],
    ['неверный digest', payload => (payload.stateAfterDigest = 'broken')],
    ['совпадающие состояния', payload => (payload.stateAfterDigest = payload.stateBeforeDigest)],
    ['совпадающие checkpoint', payload => (payload.checkpointAfterDigest = payload.checkpointBeforeDigest)]
  ])('отклоняет неподдерживаемое расшифрованное намерение: %s', async (_label, mutate) => {
    const s = scenario;
    const changed = await repackIntent(s, mutate);
    await expect(inspectPlannerCommitIntent({ ...s.inspectOptions, ...changed })).rejects.toThrow();
  });

  it('фиксирует выбранные пути, отметки и конверт до первого await', async () => {
    const s = scenario;
    const request = {
      ...s.prepareOptions,
      rootPin: { ...s.root.pin },
      localBeforePin: { ...s.local.pin },
      localAfterPin: { ...s.afterVersion.pin },
      remotePin: { ...s.remote.pin },
      expectedCheckpointBeforePin: { ...s.beforeCheckpoint.pin },
      expectedKnownPins: s.prepareOptions.expectedKnownPins.map(value => ({ ...value })),
      selected: [['statusByDate', day]]
    };
    const pending = preparePlannerCommitIntent(request);
    request.selected[0][0] = 'time';
    request.rootPin.sha256 = '0'.repeat(64);
    request.expectedKnownPins.length = 0;
    request.expectedCheckpointBeforePin.sha256 = '0'.repeat(64);
    const prepared = await pending;
    expect(JSON.parse(prepared.candidateStateJson()).plannerEntries[0].statusByDate[day]).toBe('done');

    const observe = {
      ...s.inspectOptions,
      envelope: prepared.envelope(),
      expectedIntentPin: prepared.pin(),
      rootPin: { ...s.root.pin },
      expectedKnownPins: s.inspectOptions.expectedKnownPins.map(value => ({ ...value }))
    };
    const checking = inspectPlannerCommitIntent(observe);
    observe.envelope.ciphertext = 'changed';
    observe.rootPin.sha256 = '0'.repeat(64);
    observe.expectedKnownPins.length = 0;
    expect((await checking).status).toBe('pair_matches_before');
  });

  it('не держит одновременно несколько больших буферов хэширования содержимого', async () => {
    const s = scenario;
    let active = 0;
    let maximum = 0;
    const subtle = webcrypto.subtle;
    const cryptoSource = {
      getRandomValues: value => webcrypto.getRandomValues(value),
      subtle: {
        importKey: subtle.importKey.bind(subtle),
        encrypt: subtle.encrypt.bind(subtle),
        decrypt: subtle.decrypt.bind(subtle),
        async digest(...args) {
          active++;
          maximum = Math.max(maximum, active);
          try {
            return await subtle.digest(...args);
          } finally {
            active--;
          }
        }
      }
    };
    const prepared = await preparePlannerCommitIntent({ ...s.prepareOptions, cryptoSource });
    await inspectPlannerCommitIntent({
      ...s.inspectOptions,
      envelope: prepared.envelope(),
      expectedIntentPin: prepared.pin(),
      cryptoSource
    });
    expect(active).toBe(0);
    expect(maximum).toBe(1);
  });

  it('не выполняет сетевых вызовов или записи state/Storage при подготовке и наблюдении', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const prepared = await preparePlannerCommitIntent(scenario.prepareOptions);
    await inspectPlannerCommitIntent({
      ...scenario.inspectOptions,
      envelope: prepared.envelope(),
      expectedIntentPin: prepared.pin()
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('экспериментальный слот только зашифрованного намерения', () => {
  it('после нового экземпляра читает только по независимому pin и никогда не сохраняет открытые данные', async () => {
    const s = scenario;
    const storage = memoryStorage();
    expect(publishPlannerCommitIntent({ storage, prepared: s.prepared, expectedIntentPin: s.prepared.pin() })).toEqual({
      status: 'published_for_test'
    });
    const file = storage.raw().join('');
    for (const secret of [
      'PRIVATE-PASSWORD',
      'PRIVATE@example.test',
      '/PRIVATE/LOCAL/PATH',
      'Личная повторяющаяся задача',
      s.intentKey,
      s.checkpointKey
    ])
      expect(file).not.toContain(secret);
    expect(
      await readPublishedPlannerCommitIntent({
        storage,
        datasetId: s.datasetId,
        deviceId: s.deviceId,
        expectedIntentPin: structuredClone(s.prepared.pin()),
        cryptoSource: webcrypto
      })
    ).toEqual(s.prepared.envelope());
    expect(() =>
      publishPlannerCommitIntent({ storage, prepared: s.prepared, expectedIntentPin: s.prepared.pin() })
    ).toThrow(/незавершённая/);
  });

  it('в модели занятый lock не позволяет второй публикации начать работу со слотом', async () => {
    const s = scenario;
    const storage = memoryStorage();
    let held = false;
    let enter;
    let release;
    const entered = new Promise(resolve => (enter = resolve));
    const wait = new Promise(resolve => (release = resolve));
    const manager = {
      async request(name, _options, callback) {
        if (held) return callback(null);
        held = true;
        try {
          return await callback({ name, mode: 'exclusive' });
        } finally {
          held = false;
        }
      }
    };
    const publish = vi.fn(() =>
      publishPlannerCommitIntent({ storage, prepared: s.prepared, expectedIntentPin: s.prepared.pin() })
    );
    const first = tryBrowserSyncOperation({
      lockManager: manager,
      operation: async () => {
        enter();
        await wait;
        publish();
      }
    });
    await entered;
    expect((await tryBrowserSyncOperation({ lockManager: manager, operation: publish })).status).toBe('busy');
    expect(publish).not.toHaveBeenCalled();
    release();
    expect((await first).status).toBe('completed_for_test');
    expect(storage.writes).toBe(1);
    let unfinished = false;
    await tryBrowserSyncOperation({
      lockManager: manager,
      operation: () => {
        try {
          publish();
        } catch {
          unfinished = true;
        }
      }
    });
    expect(unfinished).toBe(true);
    expect(storage.writes).toBe(1);
  });

  it('не позволяет публикацию неподготовленного объекта или по другому отпечатку', () => {
    const s = scenario;
    const storage = memoryStorage();
    expect(() =>
      publishPlannerCommitIntent({ storage, prepared: { status: 'prepared' }, expectedIntentPin: s.prepared.pin() })
    ).toThrow();
    expect(() =>
      publishPlannerCommitIntent({
        storage,
        prepared: s.prepared,
        expectedIntentPin: { ...s.prepared.pin(), sha256: '0'.repeat(64) }
      })
    ).toThrow();
    expect(storage.raw()).toEqual([]);
  });

  it.each(['failBefore', 'failAfter', 'corruptReadback'])(
    'не повторяет запись после неопределённого исхода: %s',
    async flag => {
      const s = scenario;
      const storage = memoryStorage();
      storage[flag] = true;
      expect(() =>
        publishPlannerCommitIntent({ storage, prepared: s.prepared, expectedIntentPin: s.prepared.pin() })
      ).toThrow(/неизвестен/);
      storage[flag] = false;
      expect(() =>
        publishPlannerCommitIntent({ storage, prepared: s.prepared, expectedIntentPin: s.prepared.pin() })
      ).toThrow(/неизвестен/);
      expect(storage.writes).toBe(1);
      if (flag !== 'failBefore') {
        expect(
          await readPublishedPlannerCommitIntent({
            storage,
            datasetId: s.datasetId,
            deviceId: s.deviceId,
            expectedIntentPin: s.prepared.pin(),
            cryptoSource: webcrypto
          })
        ).toEqual(s.prepared.envelope());
      } else {
        await expect(
          readPublishedPlannerCommitIntent({
            storage,
            datasetId: s.datasetId,
            deviceId: s.deviceId,
            expectedIntentPin: s.prepared.pin(),
            cryptoSource: webcrypto
          })
        ).rejects.toThrow(/Не найдена/);
      }
    }
  );

  it('отказ чтения не вызывает запись и не раскрывает внутреннюю ошибку', async () => {
    const s = scenario;
    const storage = memoryStorage();
    storage.failRead = true;
    expect(() =>
      publishPlannerCommitIntent({ storage, prepared: s.prepared, expectedIntentPin: s.prepared.pin() })
    ).toThrow(/прочитать/);
    await expect(
      readPublishedPlannerCommitIntent({
        storage,
        datasetId: s.datasetId,
        deviceId: s.deviceId,
        expectedIntentPin: s.prepared.pin(),
        cryptoSource: webcrypto
      })
    ).rejects.not.toThrow('PRIVATE-INTERNAL-READ');
    expect(storage.writes).toBe(0);
  });

  it('отклоняет отсутствие, усечение, чужой dataset/device и подмену, не очищая слот', async () => {
    const s = scenario;
    const storage = memoryStorage();
    const read = changes =>
      readPublishedPlannerCommitIntent({
        storage,
        datasetId: s.datasetId,
        deviceId: s.deviceId,
        expectedIntentPin: s.prepared.pin(),
        cryptoSource: webcrypto,
        ...changes
      });
    await expect(read({})).rejects.toThrow();
    publishPlannerCommitIntent({ storage, prepared: s.prepared, expectedIntentPin: s.prepared.pin() });
    const original = storage.raw()[0];
    await expect(read({ datasetId: id() })).rejects.toThrow();
    await expect(read({ deviceId: id() })).rejects.toThrow();
    await expect(read({ expectedIntentPin: { ...s.prepared.pin(), sha256: '0'.repeat(64) } })).rejects.toThrow();
    storage.setItem(storage.key(), original.slice(0, -5));
    await expect(read({})).rejects.toThrow();
    expect(storage.raw()[0]).toBe(original.slice(0, -5));
  });
});

describe('сбой между отдельными записями на тестовом файловом хранилище', () => {
  it('распознаёт оба порядка, повреждение и изменение приватного поля после повторного чтения', async () => {
    const s = scenario;
    const beforeRaw = `${JSON.stringify(s.localState, null, 2)}\n`;
    const prepared = await preparePlannerCommitIntent({ ...s.prepareOptions, stateBeforeRaw: beforeRaw });
    const dir = mkdtempSync(join(tmpdir(), 'tvinoferma-intent-test-'));
    const statePath = join(dir, 'state.json');
    const checkpointPath = join(dir, 'checkpoint.json');
    const slotPath = join(dir, 'encrypted-intent.json');
    let hasSlot = false;
    const storage = {
      getItem() {
        return hasSlot ? readFileSync(slotPath, 'utf8') : null;
      },
      setItem(_key, value) {
        writeFileSync(slotPath, value);
        hasSlot = true;
      }
    };
    try {
      writeFileSync(statePath, beforeRaw);
      writeFileSync(checkpointPath, s.prepareOptions.checkpointBeforeRaw);
      publishPlannerCommitIntent({ storage, prepared: prepared, expectedIntentPin: prepared.pin() });
      expect(readFileSync(slotPath, 'utf8')).not.toContain('PRIVATE-PASSWORD');
      // Отдельный процесс на каждом шаге заново проверяет историю и реально читает файлы.
      // Доверенные отметки/ключи тест передаёт по stdin, а не берёт из слота рядом с файлами.
      const observe = () =>
        JSON.parse(
          execFileSync(process.execPath, ['tests/fixtures/cloudSyncPlannerCommitJournalReader.mjs'], {
            input: JSON.stringify({
              statePath,
              checkpointPath,
              slotPath,
              versions: s.versions,
              datasetId: s.datasetId,
              deviceId: s.deviceId,
              datasetKey: s.datasetKey,
              checkpointKey: s.checkpointKey,
              intentKey: s.intentKey,
              rootPin: s.root.pin,
              localPin: s.local.pin,
              remotePin: s.remote.pin,
              knownPins: s.inspectOptions.expectedKnownPins,
              checkpointBeforePin: s.beforeCheckpoint.pin,
              intentPin: prepared.pin()
            }),
            encoding: 'utf8'
          })
        );
      expect(observe().status).toBe('pair_matches_before');
      writeFileSync(statePath, prepared.candidateStateJson());
      expect(observe().status).toBe('state_ahead');
      writeFileSync(checkpointPath, prepared.checkpointAfterJson());
      expect(observe().status).toBe('pair_matches_after');
      writeFileSync(statePath, beforeRaw);
      expect(observe().status).toBe('checkpoint_ahead');
      // Совместный откат к двум прежним файлам неотличим от операции до записи.
      // Модель обязана потребовать ручную проверку, а не объявить новый commit успешным.
      writeFileSync(checkpointPath, s.prepareOptions.checkpointBeforeRaw);
      expect(observe()).toEqual({
        status: 'pair_matches_before',
        otherKnownBranches: false,
        pendingCount: 2,
        action: 'manual_review'
      });
      const privateChanged = JSON.parse(beforeRaw);
      privateChanged.characters[0].contacts.email = 'CHANGED@example.test';
      writeFileSync(statePath, JSON.stringify(privateChanged));
      expect(observe().status).toBe('unrecognized');
      writeFileSync(statePath, beforeRaw);
      writeFileSync(checkpointPath, '{truncated');
      expect(observe().status).toBe('unrecognized');
      expect(readFileSync(checkpointPath, 'utf8')).toBe('{truncated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
