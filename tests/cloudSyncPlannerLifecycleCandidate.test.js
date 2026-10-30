// Кандидаты жизненного цикла календаря: только память, без state/облака/сайта.
import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { normalizePlannerEntry } from '../js/modules/dashboard/planner.js';
import { createMarathon, createSeries } from '../js/modules/marathons/model.js';
import { reviewSnapshotDependencies } from '../js/modules/cloudSync/reviewDependencies.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import {
  sealHistoryVersion,
  sealHistoryVersionWithPlannerDeletions,
  verifyHistory
} from '../js/modules/cloudSync/history.js';
import { preparePlannerAddition, preparePlannerDeletion } from '../js/modules/cloudSync/plannerLifecycleCandidate.js';

const id = () => generateSyncId(webcrypto);
const selections = ['planner', 'eventReminders'];
const publicState = state => buildPublicSnapshot(state, { settingsSelections: selections });
const row = (snapshot, syncId) => snapshot.sections.planner.records.find(entry => entry.id === syncId);
const without = (snapshot, syncId) => {
  const result = structuredClone(snapshot);
  result.sections.planner.records = result.sections.planner.records.filter(item => item.id !== syncId);
  result.sections.planner.order = result.sections.planner.order.filter(item => item !== syncId);
  return result;
};

function localState({ guild = false, invalidDate = false, localId = 'LOCAL-TASK' } = {}) {
  const state = normalizeState({
    schemaVersion: 10,
    characters: [
      {
        id: 'LOCAL-HERO',
        nick: 'Герой',
        contacts: { email: 'PRIVATE@example.test', password: 'SECRET-PASSWORD', phone: 'SECRET-PHONE' },
        launch: { gcPath: '/PRIVATE/PATH' }
      }
    ],
    plannerEntries: [
      {
        id: guild ? 'guild-462' : localId,
        title: 'Повторяющаяся задача',
        date: '2026-11-01',
        time: '18:00',
        durationMinutes: 60,
        kind: 'task',
        priority: 'high',
        reminderMinutes: 15,
        recurrence: 'weekly',
        recurrenceEnd: '2026-12-31',
        status: 'todo',
        statusByDate: { '2026-11-08': 'doing' },
        createdAt: '2026-10-28T12:00:00.000Z',
        updatedAt: '2026-10-28T12:00:00.000Z'
      },
      {
        id: 'LOCAL-NOTE',
        title: 'Локальная заметка',
        date: '2026-11-02',
        kind: 'note',
        createdAt: '2026-10-28T12:00:00.000Z',
        updatedAt: '2026-10-28T12:00:00.000Z'
      }
    ]
  });
  const { ui, ...snapshot } = state;
  const result = planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot;
  if (invalidDate) result.plannerEntries[0].date = '2026-02-30';
  return result;
}

function remoteEntry(syncId, { guild = false } = {}) {
  return normalizePlannerEntry({
    id: guild ? 'guild-902' : 'REMOTE-LOCAL-ID',
    syncId,
    title: 'Новое событие',
    date: '2026-11-03',
    time: '20:30',
    durationMinutes: 90,
    kind: 'event',
    priority: 'normal',
    reminderMinutes: 90,
    recurrence: 'weekly',
    recurrenceEnd: '2027-01-30',
    status: 'doing',
    statusByDate: { '2026-11-10': 'done' },
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T12:00:00.000Z'
  });
}

async function graph(base = localState()) {
  const datasetId = id();
  const recoveryKey = generateRecoveryKey(webcrypto);
  const basePublic = publicState(base);
  const seal = (publicSnapshot, parent = null) =>
    sealHistoryVersion({ publicSnapshot, parent, datasetId, recoveryKey, versionId: id(), cryptoSource: webcrypto });
  const root = await seal(basePublic);
  const verify = versions =>
    verifyHistory({
      envelopes: versions.map(version => version.envelope),
      root: root.pin,
      knownPins: [root.pin],
      expectedDatasetId: datasetId,
      recoveryKey,
      cryptoSource: webcrypto
    });
  const deletion = (history, parent, snapshot, deletedIds) =>
    sealHistoryVersionWithPlannerDeletions({
      history,
      parent,
      publicSnapshot: snapshot,
      deletedIds,
      confirmedDeletion: true,
      datasetId,
      versionId: id(),
      recoveryKey,
      cryptoSource: webcrypto
    });
  const options = (history, localVersion, remoteVersion, snapshot, syncId) => ({
    snapshot,
    history,
    localPin: localVersion.pin,
    remotePin: remoteVersion.pin,
    expectedKnownPins: [root.pin, localVersion.pin].filter(
      (value, index, all) => all.findIndex(other => other.versionId === value.versionId) === index
    ),
    id: syncId,
    selected: true
  });
  return { base, basePublic, root, seal, verify, deletion, options };
}

async function additionScenario({ editLocal = () => {}, editRemote = () => {}, guild = false, base } = {}) {
  const g = await graph(base);
  const newId = id();
  const local = structuredClone(g.base);
  editLocal(local);
  const remote = structuredClone(g.base);
  remote.plannerEntries.unshift(remoteEntry(newId, { guild }));
  const remotePublic = publicState(remote);
  editRemote(remotePublic, newId);
  const localVersion = await g.seal(publicState(local), g.root.pin);
  const remoteVersion = await g.seal(remotePublic, g.root.pin);
  const history = await g.verify([g.root, localVersion, remoteVersion]);
  return {
    ...g,
    local,
    remotePublic,
    localVersion,
    remoteVersion,
    history,
    newId,
    options: { ...g.options(history, localVersion, remoteVersion, local, newId), cryptoSource: webcrypto }
  };
}

async function deletionScenario({ editLocal = () => {}, marker = true, base } = {}) {
  const g = await graph(base);
  const target = g.base.plannerEntries[0].syncId;
  const local = structuredClone(g.base);
  editLocal(local);
  const localVersion = await g.seal(publicState(local), g.root.pin);
  const beforeDeletion = await g.verify([g.root, localVersion]);
  const deleted = without(g.basePublic, target);
  const remoteVersion = marker
    ? await g.deletion(beforeDeletion, g.root.pin, deleted, [target])
    : await g.seal(deleted, g.root.pin);
  const history = await g.verify([g.root, localVersion, remoteVersion]);
  return {
    ...g,
    local,
    localVersion,
    remoteVersion,
    history,
    target,
    deleted,
    options: { ...g.options(history, localVersion, remoteVersion, local, target), confirmedDeletion: true }
  };
}

describe('создание выбранной ручной записи в локальной копии', () => {
  it('сохраняет локальные секреты и невыбранные данные, создаёт отдельный локальный ID и проверяет round-trip', async () => {
    const s = await additionScenario({
      editLocal: state => {
        state.plannerEntries[1].title = 'Локальное изменение';
        state.plannerEntries.push(remoteEntry(id()));
        state.plannerEntries[2].id = 'LOCAL-OTHER';
      },
      editRemote: (snapshot, newId) => {
        row(snapshot, newId).fields.statusByDate['2026-11-17'] = 'todo';
        snapshot.sections.planner.records.find(entry => entry.id !== newId).fields.title = 'Не выбранное изменение';
      }
    });
    const before = JSON.stringify(s.local);
    const result = preparePlannerAddition(s.options);
    expect(result.status).toBe('prepared');
    const candidate = result.candidateState();
    const added = candidate.plannerEntries.at(-1);
    expect(added).toMatchObject({
      syncId: s.newId,
      title: 'Новое событие',
      recurrence: 'weekly',
      status: 'doing',
      statusByDate: { '2026-11-10': 'done', '2026-11-17': 'todo' }
    });
    expect(added.id).toMatch(/^planner-[0-9a-f-]+$/);
    expect(added.id).not.toBe(s.newId);
    expect(added.id).not.toBe('REMOTE-LOCAL-ID');
    expect(candidate.plannerEntries.slice(0, -1)).toEqual(s.local.plannerEntries);
    expect(candidate.characters).toEqual(s.local.characters);
    expect(candidate.characters[0].contacts.password).toBe('SECRET-PASSWORD');
    expect(candidate.settings).toEqual(s.local.settings);
    expect(JSON.stringify(s.local)).toBe(before);
    expect(result.candidatePublicSnapshot()).toEqual(publicState(candidate));
    expect(result.candidatePublicSnapshot().sections.planner.order.at(-1)).toBe(s.newId);
    expect(JSON.stringify(result.details())).not.toContain('Новое событие');
    expect(JSON.stringify(result.details())).not.toContain('SECRET-PASSWORD');
    candidate.characters[0].contacts.password = 'broken';
    result.candidatePublicSnapshot().sections.planner.records.length = 0;
    expect(result.candidateState().characters[0].contacts.password).toBe('SECRET-PASSWORD');
    expect(result.candidatePublicSnapshot().sections.planner.records.length).toBe(4);
  });

  it('не готовит невыбранную или клановую запись', async () => {
    const s = await additionScenario();
    expect(preparePlannerAddition({ ...s.options, selected: false })).toEqual({
      status: 'blocked',
      reason: 'selection_required'
    });
    const guild = await additionScenario({ guild: true });
    expect(preparePlannerAddition(guild.options)).toEqual({ status: 'blocked', reason: 'guild_requires_site_review' });
  });

  it.each([
    ['пустое имя', fields => (fields.title = '')],
    ['пробелы', fields => (fields.title = ' Лишний пробел ')],
    ['невозможная дата', fields => (fields.date = '2026-02-30')],
    ['неверное время', fields => (fields.time = '24:61')],
    ['нулевая продолжительность', fields => (fields.durationMinutes = 0)],
    ['отрицательное напоминание', fields => (fields.reminderMinutes = -1)],
    ['неверное окончание повтора', fields => (fields.recurrenceEnd = '2026-13-01')],
    ['неверная дата отметки', fields => (fields.statusByDate = { '2026-02-30': 'done' })],
    ['неверная отметка', fields => (fields.statusByDate = { '2026-11-01': 'unknown' })],
    ['плохое время создания', fields => (fields.createdAt = 'yesterday')],
    ['неизвестный цвет', fields => (fields.color = 'ultraviolet')]
  ])('отклоняет без нормализации: %s', async (_label, change) => {
    const s = await additionScenario({ editRemote: (snapshot, syncId) => change(row(snapshot, syncId).fields) });
    expect(() => preparePlannerAddition(s.options)).toThrow();
  });

  it('не принимает ранее существовавший ID после немаркированного исчезновения', async () => {
    const g = await graph();
    const newId = id();
    const withId = structuredClone(g.base);
    withId.plannerEntries.push(remoteEntry(newId));
    const appeared = await g.seal(publicState(withId), g.root.pin);
    const vanished = await g.seal(g.basePublic, appeared.pin);
    const returned = await g.seal(publicState(withId), vanished.pin);
    const history = await g.verify([g.root, appeared, vanished, returned]);
    const options = { ...g.options(history, vanished, returned, g.base, newId), cryptoSource: webcrypto };
    expect(preparePlannerAddition(options)).toEqual({ status: 'blocked', reason: 'identity_uncertain' });
  });

  it('проверяет весь удалённый путь, а не только текущие две вершины', async () => {
    const g = await graph();
    const newId = id();
    const withId = structuredClone(g.base);
    withId.plannerEntries.push(remoteEntry(newId));
    const appeared = await g.seal(publicState(withId), g.root.pin);
    const vanished = await g.seal(g.basePublic, appeared.pin);
    const returned = await g.seal(publicState(withId), vanished.pin);
    const history = await g.verify([g.root, appeared, vanished, returned]);
    const options = { ...g.options(history, g.root, returned, g.base, newId), cryptoSource: webcrypto };
    expect(preparePlannerAddition(options)).toEqual({ status: 'blocked', reason: 'identity_uncertain' });
  });

  it('не считает ручной записью прежний клановый источник с тем же ID', async () => {
    const g = await graph();
    const newId = id();
    const withId = structuredClone(g.base);
    withId.plannerEntries.push(remoteEntry(newId));
    const guildSnapshot = publicState(withId);
    row(guildSnapshot, newId).fields.source = { kind: 'guild', eventId: '902' };
    const formerlyGuild = await g.seal(guildSnapshot, g.root.pin);
    const nowManual = await g.seal(publicState(withId), formerlyGuild.pin);
    const history = await g.verify([g.root, formerlyGuild, nowManual]);
    const options = { ...g.options(history, g.root, nowManual, g.base, newId), cryptoSource: webcrypto };
    expect(preparePlannerAddition(options)).toEqual({ status: 'blocked', reason: 'guild_requires_site_review' });
  });

  it('не совпадает с локальным ID другой записи и прекращает попытки при отказе случайности', async () => {
    const collision = 'planner-00000000-0000-4000-8000-000000000000';
    const s = await additionScenario({ base: localState({ localId: collision }) });
    const random = vi.fn(bytes => (bytes.fill(0), bytes));
    const fakeCrypto = { subtle: webcrypto.subtle, getRandomValues: random };
    expect(() => preparePlannerAddition({ ...s.options, cryptoSource: fakeCrypto })).toThrow();
    expect(random).toHaveBeenCalledTimes(16);
    expect(s.local.plannerEntries[0].id).toBe(collision);
  });

  it('не принимает входящие sync-ID, совпадающие с существующим локальным ID другой сущности', async () => {
    const newId = id();
    const base = localState({ localId: newId });
    const g = await graph(base);
    const remote = structuredClone(g.base);
    remote.plannerEntries.push(remoteEntry(newId));
    // Формируем структурно допустимый облачный снимок как данные с другого ПК.
    remote.plannerEntries[0].id = 'OTHER-PC-LOCAL';
    const remoteVersion = await g.seal(publicState(remote), g.root.pin);
    const history = await g.verify([g.root, remoteVersion]);
    const options = { ...g.options(history, g.root, remoteVersion, g.base, newId), cryptoSource: webcrypto };
    expect(() => preparePlannerAddition(options)).toThrow();
  });
});

describe('удаление только по явной метке и после дополнительного подтверждения', () => {
  it('удаляет только выбранную запись, сохраняя локальные данные и независимые копии', async () => {
    const s = await deletionScenario({
      editLocal: state => (state.plannerEntries[1].title = 'Моя правка другой заметки')
    });
    const before = JSON.stringify(s.local);
    const result = preparePlannerDeletion(s.options);
    expect(result.status).toBe('prepared');
    const candidate = result.candidateState();
    expect(candidate.plannerEntries).toEqual([s.local.plannerEntries[1]]);
    expect(candidate.characters).toEqual(s.local.characters);
    expect(candidate.characters[0].contacts.password).toBe('SECRET-PASSWORD');
    expect(result.candidatePublicSnapshot()).toEqual(publicState(candidate));
    expect(result.details()).toMatchObject({
      kind: 'delete',
      deletionPin: s.remoteVersion.pin,
      lastPresentPin: s.root.pin
    });
    expect(JSON.stringify(result.details())).not.toContain('Повторяющаяся задача');
    expect(JSON.stringify(s.local)).toBe(before);
    candidate.plannerEntries.length = 0;
    expect(result.candidateState().plannerEntries).toHaveLength(1);
  });

  it('не интерпретирует отсутствие в старом формате как удаление', async () => {
    const s = await deletionScenario({ marker: false });
    expect(preparePlannerDeletion(s.options)).toEqual({ status: 'blocked', reason: 'missing_deletion_marker' });
  });

  it('требует и выбора, и отдельного подтверждения', async () => {
    const s = await deletionScenario();
    expect(preparePlannerDeletion({ ...s.options, selected: false })).toEqual({
      status: 'blocked',
      reason: 'selection_required'
    });
    expect(preparePlannerDeletion({ ...s.options, confirmedDeletion: false })).toEqual({
      status: 'blocked',
      reason: 'deletion_confirmation_required'
    });
    expect(() => preparePlannerDeletion({ ...s.options, confirmedDeletion: 'true' })).toThrow();
  });

  it.each([
    ['название', state => (state.plannerEntries[0].title = 'Моя правка')],
    ['время', state => (state.plannerEntries[0].time = '19:45')],
    ['отметка повтора', state => (state.plannerEntries[0].statusByDate['2026-11-08'] = 'done')],
    ['время обновления', state => (state.plannerEntries[0].updatedAt = '2026-10-29T00:00:00.000Z')]
  ])('блокирует конфликт удаления и локальной правки: %s', async (_label, editLocal) => {
    const s = await deletionScenario({ editLocal });
    expect(preparePlannerDeletion(s.options)).toEqual({ status: 'blocked', reason: 'local_edited' });
  });

  it('не пропускает изменение с последующим откатом между предком и локальной вершиной', async () => {
    const g = await graph();
    const target = g.base.plannerEntries[0].syncId;
    const changed = structuredClone(g.base);
    changed.plannerEntries[0].title = 'Временная правка';
    const first = await g.seal(publicState(changed), g.root.pin);
    const reverted = await g.seal(g.basePublic, first.pin);
    const prior = await g.verify([g.root, first, reverted]);
    const deleted = await g.deletion(prior, g.root.pin, without(g.basePublic, target), [target]);
    const history = await g.verify([g.root, first, reverted, deleted]);
    const options = { ...g.options(history, reverted, deleted, g.base, target), confirmedDeletion: true };
    expect(preparePlannerDeletion(options)).toEqual({ status: 'blocked', reason: 'local_edited' });
  });

  it('не удаляет запись при локальной перестановке старых записей, но допускает новую запись рядом', async () => {
    const reordered = await deletionScenario({ editLocal: state => state.plannerEntries.reverse() });
    expect(preparePlannerDeletion(reordered.options)).toEqual({ status: 'blocked', reason: 'local_reordered' });
    const added = await deletionScenario({ editLocal: state => state.plannerEntries.unshift(remoteEntry(id())) });
    expect(preparePlannerDeletion(added.options).status).toBe('prepared');
    expect(preparePlannerDeletion(added.options).candidateState().plannerEntries).toHaveLength(2);
  });

  it('возвращает отметку последней версии перед удалением, если на другом ПК запись изменили', async () => {
    const g = await graph();
    const target = g.base.plannerEntries[0].syncId;
    const edited = structuredClone(g.basePublic);
    row(edited, target).fields.title = 'Последняя удалённая версия';
    const remoteEdit = await g.seal(edited, g.root.pin);
    const prior = await g.verify([g.root, remoteEdit]);
    const deleted = await g.deletion(prior, remoteEdit.pin, without(edited, target), [target]);
    const history = await g.verify([g.root, remoteEdit, deleted]);
    const result = preparePlannerDeletion({
      ...g.options(history, g.root, deleted, g.base, target),
      confirmedDeletion: true
    });
    expect(result.status).toBe('prepared');
    expect(result.details().lastPresentPin).toEqual(remoteEdit.pin);
    expect(history.plannerRecord(result.details().lastPresentPin, target).fields.title).toBe(
      'Последняя удалённая версия'
    );
  });

  it('отклоняет недопустимую последнюю облачную запись до её удаления', async () => {
    const g = await graph();
    const target = g.base.plannerEntries[0].syncId;
    const invalidRemote = structuredClone(g.basePublic);
    row(invalidRemote, target).fields.date = '2026-02-30';
    const edited = await g.seal(invalidRemote, g.root.pin);
    const prior = await g.verify([g.root, edited]);
    const deleted = await g.deletion(prior, edited.pin, without(invalidRemote, target), [target]);
    const history = await g.verify([g.root, edited, deleted]);
    const options = { ...g.options(history, g.root, deleted, g.base, target), confirmedDeletion: true };
    expect(() => preparePlannerDeletion(options)).toThrow();
  });

  it('не пропускает немаркированное исчезновение до более поздней отметки', async () => {
    const g = await graph();
    const target = g.base.plannerEntries[0].syncId;
    const disappeared = await g.seal(without(g.basePublic, target), g.root.pin);
    const returned = await g.seal(g.basePublic, disappeared.pin);
    const prior = await g.verify([g.root, disappeared, returned]);
    const deleted = await g.deletion(prior, returned.pin, without(g.basePublic, target), [target]);
    const history = await g.verify([g.root, disappeared, returned, deleted]);
    const options = { ...g.options(history, g.root, deleted, g.base, target), confirmedDeletion: true };
    expect(preparePlannerDeletion(options)).toEqual({ status: 'blocked', reason: 'missing_deletion_marker' });
  });

  it('не удаляет клановое событие и не пытается ответить на сайте', async () => {
    const s = await deletionScenario({ base: localState({ guild: true }) });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(preparePlannerDeletion(s.options)).toEqual({ status: 'blocked', reason: 'guild_requires_site_review' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('блокирует бизнес-некорректную локальную запись даже при структурно проверенной истории', async () => {
    const s = await deletionScenario({ base: localState({ invalidDate: true }) });
    expect(() => preparePlannerDeletion(s.options)).toThrow();
  });
});

describe('общие границы доверия и неизменность', () => {
  it('останавливается при дополнительной известной ветке', async () => {
    const s = await additionScenario();
    const other = await s.seal(s.basePublic, s.root.pin);
    const history = await s.verify([s.root, s.localVersion, s.remoteVersion, other]);
    expect(
      preparePlannerAddition({ ...s.options, history, expectedKnownPins: [...s.options.expectedKnownPins, other.pin] })
    ).toEqual({ status: 'blocked', reason: 'other_known_branches' });
    const d = await deletionScenario();
    const third = await d.seal(d.basePublic, d.root.pin);
    const dh = await d.verify([d.root, d.localVersion, d.remoteVersion, third]);
    expect(
      preparePlannerDeletion({
        ...d.options,
        history: dh,
        expectedKnownPins: [...d.options.expectedKnownPins, third.pin]
      })
    ).toEqual({ status: 'blocked', reason: 'other_known_branches' });
  });

  it('требует независимые root/local и все переданные известные отметки; усечённая история не принимается', async () => {
    const s = await additionScenario();
    expect(() => preparePlannerAddition({ ...s.options, expectedKnownPins: [] })).toThrow();
    expect(() => preparePlannerAddition({ ...s.options, expectedKnownPins: [s.root.pin] })).toThrow();
    expect(() => preparePlannerAddition({ ...s.options, expectedKnownPins: [s.localVersion.pin] })).toThrow();
    expect(() =>
      preparePlannerAddition({ ...s.options, expectedKnownPins: [...s.options.expectedKnownPins, s.root.pin] })
    ).toThrow();
    expect(() =>
      preparePlannerAddition({
        ...s.options,
        expectedKnownPins: [...s.options.expectedKnownPins, { ...s.remoteVersion.pin, sha256: '0'.repeat(64) }]
      })
    ).toThrow();
    expect(() => preparePlannerAddition({ ...s.options, history: {} })).toThrow();
    const truncated = await s.verify([s.root, s.localVersion]);
    expect(() => preparePlannerAddition({ ...s.options, history: truncated })).toThrow();
    const hiddenKnown = await s.seal(s.basePublic, s.root.pin);
    // Сам объект истории не может знать, что дополнительная версия ранее существовала.
    // Независимый список известных отпечатков не даёт молча её пропустить.
    expect(() =>
      preparePlannerAddition({ ...s.options, expectedKnownPins: [...s.options.expectedKnownPins, hiddenKnown.pin] })
    ).toThrow();
  });

  it('останавливается при изменении локальной публичной проекции после просмотра', async () => {
    const s = await additionScenario();
    const stale = structuredClone(s.local);
    stale.plannerEntries[0].status = 'done';
    expect(() => preparePlannerAddition({ ...s.options, snapshot: stale })).toThrow(/изменились/);
    const d = await deletionScenario();
    const changed = structuredClone(d.local);
    changed.plannerEntries[1].title = 'после просмотра';
    expect(() => preparePlannerDeletion({ ...d.options, snapshot: changed })).toThrow(/изменились/);
  });

  it('отклоняет getter до чтения и не раскрывает значения в ошибке', async () => {
    const s = await additionScenario();
    const getter = vi.fn(() => 'SECRET-TITLE');
    Object.defineProperty(s.local.plannerEntries[0], 'title', { get: getter, enumerable: true });
    expect(() => preparePlannerAddition(s.options)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    try {
      preparePlannerAddition(s.options);
    } catch (error) {
      expect(String(error)).not.toContain('SECRET-TITLE');
      expect(String(error)).not.toContain('SECRET-PASSWORD');
    }
  });

  it('останавливает оба кандидата при известных несогласованных связях в других разделах', async () => {
    const base = localState();
    base.marathons = [
      createSeries({ id: 'LOCAL-FOLDER', title: 'Папка', childIds: ['LOCAL-MARATHON'] }),
      createMarathon({ id: 'LOCAL-MARATHON', title: 'Марафон', seriesId: null })
    ];
    const planned = planSyncIdentities({ snapshot: base, cryptoSource: webcrypto }).snapshot;
    expect(reviewSnapshotDependencies(publicState(planned)).issues).not.toHaveLength(0);
    const a = await additionScenario({ base: planned });
    expect(preparePlannerAddition(a.options)).toEqual({ status: 'blocked', reason: 'dependency_review_required' });
    const d = await deletionScenario({ base: planned });
    expect(preparePlannerDeletion(d.options)).toEqual({ status: 'blocked', reason: 'dependency_review_required' });
  });

  it('публичная сверка не заменяет проверку приватных данных перед записью', async () => {
    const s = await additionScenario();
    const oldProposal = preparePlannerAddition(s.options);
    const latest = structuredClone(s.local);
    latest.characters[0].contacts.password = 'NEW-PRIVATE-PASSWORD';
    expect(publicState(latest)).toEqual(publicState(s.local));
    // Старая копия всё ещё содержит прежний пароль; применять её нельзя.
    expect(oldProposal.candidateState().characters[0].contacts.password).toBe('SECRET-PASSWORD');
    // Только новая подготовка сохраняет актуальную приватную часть в этом примере.
    const refreshed = preparePlannerAddition({ ...s.options, snapshot: latest });
    expect(refreshed.candidateState().characters[0].contacts.password).toBe('NEW-PRIVATE-PASSWORD');
    // Это не проверка конкурентной записи: она по-прежнему нужна в интеграции.
  });

  it('не вызывает сеть или localStorage при подготовке', async () => {
    const s = await additionScenario();
    const d = await deletionScenario();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    try {
      expect(preparePlannerAddition(s.options).status).toBe('prepared');
      expect(preparePlannerDeletion(d.options).status).toBe('prepared');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(storageSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      storageSpy.mockRestore();
    }
  });
});

describe('модель перезапуска после раздельных записей — не доказательство атомарности', () => {
  it('после сохранения только состояния остановится на несовпадении старой локальной версии', async () => {
    const a = await additionScenario();
    const added = preparePlannerAddition(a.options).candidateState();
    expect(() => preparePlannerAddition({ ...a.options, snapshot: added })).toThrow(/изменились/);

    const d = await deletionScenario();
    const removed = preparePlannerDeletion(d.options).candidateState();
    expect(() => preparePlannerDeletion({ ...d.options, snapshot: removed })).toThrow(/изменились/);
  });

  it('после продвижения только отметки истории старая локальная копия не подходит', async () => {
    const a = await additionScenario();
    const proposed = preparePlannerAddition(a.options).candidatePublicSnapshot();
    const advanced = await a.seal(proposed, a.localVersion.pin);
    const history = await a.verify([a.root, a.localVersion, a.remoteVersion, advanced]);
    const options = {
      ...a.options,
      history,
      localPin: advanced.pin,
      expectedKnownPins: [...a.options.expectedKnownPins, advanced.pin]
    };
    expect(() => preparePlannerAddition(options)).toThrow(/изменились/);

    const d = await deletionScenario();
    const deletionCandidate = preparePlannerDeletion(d.options).candidatePublicSnapshot();
    const advancedDeletion = await d.deletion(d.history, d.localVersion.pin, deletionCandidate, [d.target]);
    const deletionHistory = await d.verify([d.root, d.localVersion, d.remoteVersion, advancedDeletion]);
    const deletionOptions = {
      ...d.options,
      history: deletionHistory,
      localPin: advancedDeletion.pin,
      expectedKnownPins: [...d.options.expectedKnownPins, advancedDeletion.pin]
    };
    expect(() => preparePlannerDeletion(deletionOptions)).toThrow(/изменились/);
  });

  it('после согласованной модельной записи не создаёт и не удаляет запись повторно', async () => {
    const a = await additionScenario();
    const addition = preparePlannerAddition(a.options);
    const advanced = await a.seal(addition.candidatePublicSnapshot(), a.localVersion.pin);
    const history = await a.verify([a.root, a.localVersion, a.remoteVersion, advanced]);
    const options = {
      ...a.options,
      snapshot: addition.candidateState(),
      history,
      localPin: advanced.pin,
      expectedKnownPins: [...a.options.expectedKnownPins, advanced.pin]
    };
    expect(preparePlannerAddition(options)).toEqual({ status: 'blocked', reason: 'identity_uncertain' });

    const d = await deletionScenario();
    const removal = preparePlannerDeletion(d.options);
    const advancedDeletion = await d.deletion(d.history, d.localVersion.pin, removal.candidatePublicSnapshot(), [
      d.target
    ]);
    const deletionHistory = await d.verify([d.root, d.localVersion, d.remoteVersion, advancedDeletion]);
    const deletionOptions = {
      ...d.options,
      snapshot: removal.candidateState(),
      history: deletionHistory,
      localPin: advancedDeletion.pin,
      expectedKnownPins: [...d.options.expectedKnownPins, advancedDeletion.pin]
    };
    expect(preparePlannerDeletion(deletionOptions)).toEqual({ status: 'blocked', reason: 'identity_uncertain' });
  });
});
