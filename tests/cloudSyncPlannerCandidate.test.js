import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { sealHistoryVersion, verifyHistory } from '../js/modules/cloudSync/history.js';
import { createPlannerCandidateReview, preparePlannerCandidate } from '../js/modules/cloudSync/plannerCandidate.js';

const id = () => generateSyncId(webcrypto);
const day = '2026-11-08';
const later = '2026-11-15';
const settingsSelections = ['planner', 'eventReminders'];
const record = (snapshot, syncId) => snapshot.sections.planner.records.find(item => item.id === syncId);

function localState() {
  const state = normalizeState({
    schemaVersion: 10,
    characters: [
      {
        id: 'LOCAL-HERO',
        nick: 'Герой',
        contacts: { email: 'PERSONAL@example.test', password: 'SECRET-PASSWORD', phone: 'SECRET-PHONE' },
        launch: { gcPath: '/LOCAL/PATH' }
      }
    ],
    plannerEntries: [
      {
        id: 'LOCAL-TASK',
        title: 'Задача',
        date: '2026-11-01',
        time: '18:00',
        durationMinutes: 60,
        kind: 'task',
        priority: 'high',
        reminderMinutes: 15,
        recurrence: 'weekly',
        recurrenceEnd: '2026-12-31',
        status: 'todo',
        statusByDate: { [day]: 'todo', [later]: 'todo' },
        createdAt: '2026-10-28T12:00:00.000Z',
        updatedAt: '2026-10-28T12:00:00.000Z'
      },
      {
        id: 'guild-462',
        title: 'Клановый поход',
        date: '2026-11-02',
        time: '20:00',
        kind: 'event',
        createdAt: '2026-10-28T12:00:00.000Z',
        updatedAt: '2026-10-28T12:00:00.000Z'
      },
      {
        id: 'LOCAL-NOTE',
        title: 'Неизменяемая заметка',
        date: '2026-11-03',
        kind: 'note',
        createdAt: '2026-10-28T12:00:00.000Z',
        updatedAt: '2026-10-28T12:00:00.000Z'
      }
    ]
  });
  const { ui, ...snapshot } = state;
  return planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot;
}

async function scenario({ index = 0, editLocal = () => {}, editRemote = () => {}, extraRemote = false } = {}) {
  const baseState = localState();
  const syncId = baseState.plannerEntries[index].syncId;
  const base = buildPublicSnapshot(baseState, { settingsSelections });
  const local = structuredClone(baseState);
  editLocal(local);
  const localPublic = buildPublicSnapshot(local, { settingsSelections });
  const remote = structuredClone(base);
  editRemote(record(remote, syncId), remote);
  const recoveryKey = generateRecoveryKey(webcrypto);
  const datasetId = id();
  const seal = (publicSnapshot, parent = null) =>
    sealHistoryVersion({ publicSnapshot, parent, datasetId, recoveryKey, versionId: id(), cryptoSource: webcrypto });
  const root = await seal(base);
  const localVersion = await seal(localPublic, root.pin);
  const remoteVersion = await seal(remote, root.pin);
  const versions = [root, localVersion, remoteVersion];
  if (extraRemote) versions.push(await seal(remote, remoteVersion.pin));
  const verify = items =>
    verifyHistory({
      envelopes: items.map(version => version.envelope),
      expectedDatasetId: datasetId,
      recoveryKey,
      root: root.pin,
      knownPins: [localVersion.pin, remoteVersion.pin],
      cryptoSource: webcrypto
    });
  const history = await verify(versions);
  const options = { snapshot: local, history, localPin: localVersion.pin, remotePin: remoteVersion.pin, id: syncId };
  return { options, baseState, local, base, localPublic, remote, root, versions, seal, verify };
}

const paths = changes => changes.map(change => change.path.join('/'));

describe('предварительная подготовка локального календаря', () => {
  it('переносит выбранную отметку повтора, сохраняя локальные изменения, секреты и ожидающие поля', async () => {
    const { options, local, localPublic } = await scenario({
      editLocal: state => (state.plannerEntries[0].title = 'Моя локальная задача'),
      editRemote: row => {
        row.fields.time = '20:30';
        row.fields.statusByDate[day] = 'done';
        row.fields.statusByDate[later] = 'doing';
      }
    });
    const before = JSON.stringify(local);
    const result = preparePlannerCandidate({ ...options, selected: [['statusByDate', day]] });
    expect(result.status).toBe('prepared');
    expect(paths(result.details().selected)).toEqual([`statusByDate/${day}`]);
    expect(paths(result.details().pending)).toEqual([`statusByDate/${later}`, 'time']);
    const candidate = result.candidateState();
    const entry = candidate.plannerEntries[0];
    expect(entry).toMatchObject({
      id: 'LOCAL-TASK',
      syncId: options.id,
      title: 'Моя локальная задача',
      time: '18:00',
      recurrence: 'weekly',
      statusByDate: { [day]: 'done', [later]: 'todo' }
    });
    expect(candidate.plannerEntries.slice(1)).toEqual(local.plannerEntries.slice(1));
    expect(candidate.characters).toEqual(local.characters);
    expect(candidate.characters[0].contacts).toMatchObject({
      email: 'PERSONAL@example.test',
      password: 'SECRET-PASSWORD'
    });
    expect(candidate.settings).toEqual(local.settings);
    expect(JSON.stringify(local)).toBe(before);
    expect(JSON.stringify(localPublic)).not.toContain('SECRET-PASSWORD');
    expect(buildPublicSnapshot(candidate, { settingsSelections })).toEqual(result.candidatePublicSnapshot());
    expect(JSON.stringify(result.details())).not.toContain('SECRET-PASSWORD');
    expect(JSON.stringify(result.details())).not.toContain('Моя локальная задача');

    // Внешняя правка любой возвращённой копии не меняет следующие копии.
    entry.statusByDate[day] = 'todo';
    candidate.characters[0].contacts.password = 'replaced';
    result.candidatePublicSnapshot().sections.planner.records.length = 0;
    result.details().selected[0].path[0] = 'wrong';
    expect(result.candidateState().plannerEntries[0].statusByDate[day]).toBe('done');
    expect(result.candidateState().characters[0].contacts.password).toBe('SECRET-PASSWORD');
    expect(result.details().selected[0].path).toEqual(['statusByDate', day]);
  });

  it('принимает выбранные независимые поля и не отмечает невыбранное принятым', async () => {
    const { options } = await scenario({
      editRemote: row => {
        Object.assign(row.fields, {
          title: 'Новое название',
          date: '2026-11-02',
          time: '22:45',
          durationMinutes: 90,
          reminderMinutes: 60,
          recurrence: 'daily',
          recurrenceEnd: '2027-02-28',
          status: 'doing',
          color: 'red'
        });
      }
    });
    const result = preparePlannerCandidate({
      ...options,
      selected: [
        ['title'],
        ['date'],
        ['time'],
        ['durationMinutes'],
        ['reminderMinutes'],
        ['recurrence'],
        ['recurrenceEnd'],
        ['status']
      ]
    });
    const entry = result.candidateState().plannerEntries[0];
    expect(entry).toMatchObject({
      title: 'Новое название',
      date: '2026-11-02',
      time: '22:45',
      durationMinutes: 90,
      reminderMinutes: 60,
      recurrence: 'daily',
      recurrenceEnd: '2027-02-28',
      status: 'doing',
      color: 'blue'
    });
    expect(paths(result.details().pending)).toEqual(['color']);
  });

  it('сохраняет клановый id и источник, не отправляя голос или ответ на сайт', async () => {
    const { options } = await scenario({
      index: 1,
      editRemote: row => {
        row.fields.status = 'done';
        row.fields.time = '21:30';
      }
    });
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const result = preparePlannerCandidate({ ...options, selected: [['status']] });
      const clan = result.candidateState().plannerEntries[1];
      expect(clan).toMatchObject({ id: 'guild-462', syncId: options.id, status: 'done', time: '20:00' });
      expect(record(result.candidatePublicSnapshot(), options.id).fields.source).toEqual({
        kind: 'guild',
        eventId: '462'
      });
      expect(result.details().pending.map(item => item.path)).toEqual([['time']]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('не заменяет источник и дату создания, даже если в облаке они изменились', async () => {
    const { options } = await scenario({
      index: 1,
      editRemote: row => {
        row.fields.source = { kind: 'guild', eventId: '999' };
        row.fields.createdAt = '2026-09-01T12:00:00.000Z';
        row.fields.status = 'done';
      }
    });
    expect(() => preparePlannerCandidate({ ...options, selected: [['source', 'eventId']] })).toThrow(
      'требуют проверки'
    );
    expect(() => preparePlannerCandidate({ ...options, selected: [['createdAt']] })).toThrow('требуют проверки');
    const result = preparePlannerCandidate({ ...options, selected: [['status']] });
    expect(result.candidateState().plannerEntries[1]).toMatchObject({
      id: 'guild-462',
      status: 'done',
      createdAt: '2026-10-28T12:00:00.000Z'
    });
    expect(paths(result.details().pending)).toEqual(['createdAt', 'source/eventId']);
  });

  it('в модели помнит выбранные поля между частичными просмотрами и не теряет ожидающие', async () => {
    const { options, versions, seal, verify } = await scenario({
      editRemote: row => {
        row.fields.statusByDate[day] = 'done';
        row.fields.statusByDate[later] = 'doing';
        row.fields.time = '20:30';
      }
    });
    const { snapshot, history, localPin, remotePin, id: syncId } = options;
    const review = createPlannerCandidateReview({ history, localPin, remotePin, id: syncId });
    expect(paths(review.changes())).toEqual([`statusByDate/${day}`, `statusByDate/${later}`, 'time']);
    const first = review.plan({ snapshot, selected: [['statusByDate', day]] });
    expect(review.origins()).toEqual([]);

    // Сам по себе bindModel не подтверждает запись: он только сверяет публичные версии в памяти.
    const wrong = structuredClone(first.candidatePublicSnapshot());
    record(wrong, syncId).fields.title = 'Другая версия';
    const wrongVersion = await seal(wrong, localPin);
    const wrongHistory = await verify([...versions, wrongVersion]);
    expect(() => first.bindModel({ history: wrongHistory, localPin: wrongVersion.pin, remotePin })).toThrow(
      'Локальные данные изменились'
    );
    expect(review.origins()).toEqual([]);

    const firstVersion = await seal(first.candidatePublicSnapshot(), localPin);
    const history1 = await verify([...versions, firstVersion]);
    const afterFirst = first.bindModel({ history: history1, localPin: firstVersion.pin, remotePin });
    expect(() => review.changes()).toThrow('уже заменён');
    expect(() => first.bindModel({ history: history1, localPin: firstVersion.pin, remotePin })).toThrow('уже заменён');
    expect(afterFirst.origins()).toEqual([{ path: ['statusByDate', day], source: remotePin }]);
    expect(paths(afterFirst.changes())).toEqual([`statusByDate/${later}`, 'time']);

    // Поздняя локальная правка уже принятого поля остаётся локальной, а остальные всё ещё ожидают.
    const edited = first.candidateState();
    edited.plannerEntries[0].statusByDate[day] = 'doing';
    const editedPublic = buildPublicSnapshot(edited, { settingsSelections });
    const editedVersion = await seal(editedPublic, firstVersion.pin);
    const history2 = await verify([...versions, firstVersion, editedVersion]);
    const refreshed = afterFirst.refreshModel({ history: history2, localPin: editedVersion.pin, remotePin });
    expect(() => afterFirst.changes()).toThrow('уже заменён');
    const second = refreshed.plan({ snapshot: edited, selected: [['time']] });
    expect(second.candidateState().plannerEntries[0]).toMatchObject({
      time: '20:30',
      statusByDate: { [day]: 'doing', [later]: 'todo' }
    });
    expect(paths(second.details().pending)).toEqual([`statusByDate/${later}`]);
    const finalVersion = await seal(second.candidatePublicSnapshot(), editedVersion.pin);
    const history3 = await verify([...versions, firstVersion, editedVersion, finalVersion]);
    const afterSecond = second.bindModel({ history: history3, localPin: finalVersion.pin, remotePin });
    expect(afterSecond.origins()).toEqual([
      { path: ['statusByDate', day], source: remotePin },
      { path: ['time'], source: remotePin }
    ]);
    expect(paths(afterSecond.changes())).toEqual([`statusByDate/${later}`]);
  });

  it('не продвигает модель, если ожидающее поле изменилось локально', async () => {
    const { options, versions, seal, verify } = await scenario({
      editRemote: row => {
        row.fields.statusByDate[day] = 'done';
        row.fields.time = '20:30';
      }
    });
    const { snapshot, history, localPin, remotePin, id: syncId } = options;
    const review = createPlannerCandidateReview({ history, localPin, remotePin, id: syncId });
    const edited = structuredClone(snapshot);
    edited.plannerEntries[0].time = '20:30'; // Совпадение со значением облака не является принятием.
    const changed = await seal(buildPublicSnapshot(edited, { settingsSelections }), localPin);
    const nextHistory = await verify([...versions, changed]);
    expect(() => review.refreshModel({ history: nextHistory, localPin: changed.pin, remotePin })).toThrow(
      'Ожидающее поле изменено локально'
    );
    expect(paths(review.changes())).toEqual([`statusByDate/${day}`, 'time']);
  });

  it('отклоняет устаревший полный публичный снимок, даже если изменилась другая запись', async () => {
    const { options } = await scenario({ editRemote: row => (row.fields.time = '20:30') });
    options.snapshot.plannerEntries[2].title = 'Локальная правка после просмотра';
    expect(() => preparePlannerCandidate({ ...options, selected: [['time']] })).toThrow('Локальные данные изменились');
  });

  it('сохраняет актуальные локальные секреты, которых нет в публичном снимке', async () => {
    const { options } = await scenario({ editRemote: row => (row.fields.time = '20:30') });
    options.snapshot.characters[0].contacts.password = 'NEW-LOCAL-PASSWORD';
    options.snapshot.characters[0].launch.gcPath = '/ANOTHER/LOCAL/PATH';
    const result = preparePlannerCandidate({ ...options, selected: [['time']] });
    expect(result.candidateState().characters[0].contacts.password).toBe('NEW-LOCAL-PASSWORD');
    expect(result.candidateState().characters[0].launch.gcPath).toBe('/ANOTHER/LOCAL/PATH');
    expect(JSON.stringify(result.candidatePublicSnapshot())).not.toContain('NEW-LOCAL-PASSWORD');
  });

  it('развязывает общие ссылки, чтобы изменение записи не затронуло локальные данные', async () => {
    const { options } = await scenario({ editRemote: row => (row.fields.title = 'Входящее название') });
    // Такое возможно в памяти, хотя после JSON-сохранения это были бы независимые объекты.
    options.snapshot.characters[0].contacts = options.snapshot.plannerEntries[0];
    const result = preparePlannerCandidate({ ...options, selected: [['title']] });
    const candidate = result.candidateState();
    expect(candidate.plannerEntries[0].title).toBe('Входящее название');
    expect(candidate.characters[0].contacts.title).toBe('Задача');
    expect(options.snapshot.plannerEntries[0].title).toBe('Задача');
  });

  it('не создаёт кандидата для пустого выбора или конфликта двух правок', async () => {
    const { options } = await scenario({
      editLocal: state => (state.plannerEntries[0].time = '19:00'),
      editRemote: row => (row.fields.time = '20:30')
    });
    const empty = preparePlannerCandidate({ ...options, selected: [] });
    expect(empty.status).toBe('no_selection');
    expect(empty.candidateState).toBeUndefined();
    const conflict = preparePlannerCandidate({ ...options, selected: [['time']] });
    expect(conflict.status).toBe('needs_review');
    expect(conflict.details().blocked).toEqual([expect.objectContaining({ path: ['time'], kind: 'conflict' })]);
    expect(conflict.candidateState).toBeUndefined();
  });

  it('не считает пропавшую отметку подтверждённым удалением и сохраняет её в кандидате', async () => {
    const { options } = await scenario({
      editRemote: row => {
        delete row.fields.statusByDate[day];
        row.fields.time = '20:30';
      }
    });
    const blocked = preparePlannerCandidate({ ...options, selected: [['statusByDate', day]] });
    expect(blocked.status).toBe('needs_review');
    expect(blocked.details().blocked).toEqual([
      expect.objectContaining({ path: ['statusByDate', day], kind: 'unverified_absence' })
    ]);
    expect(blocked.candidateState).toBeUndefined();
    const other = preparePlannerCandidate({ ...options, selected: [['time']] });
    expect(other.candidateState().plannerEntries[0]).toMatchObject({
      time: '20:30',
      statusByDate: { [day]: 'todo' }
    });
    expect(other.details().pending).toEqual([
      expect.objectContaining({ path: ['statusByDate', day], kind: 'unverified_absence' })
    ]);
  });

  it('не подменяет удаление или исчезнувшую запись готовым кандидатом', async () => {
    const { options } = await scenario({
      editRemote: (row, remote) => {
        remote.sections.planner.records = remote.sections.planner.records.filter(item => item.id !== row.id);
        remote.sections.planner.order = remote.sections.planner.order.filter(syncId => syncId !== row.id);
      }
    });
    expect(() => preparePlannerCandidate({ ...options, selected: [['title']] })).toThrow('Нет общей записи');
  });

  it('не использует известную устаревшую облачную версию', async () => {
    const { options } = await scenario({ extraRemote: true, editRemote: row => (row.fields.time = '20:30') });
    expect(() => preparePlannerCandidate({ ...options, selected: [['time']] })).toThrow('новая версия');
  });

  it('отклоняет подменённую историю, недопустимые пути и вызов getter', async () => {
    const { options } = await scenario({ editRemote: row => (row.fields.time = '20:30') });
    expect(() => preparePlannerCandidate({ ...options, history: {}, selected: [['time']] })).toThrow();
    for (const path of [[], ['id'], ['syncId'], ['source'], ['statusByDate'], ['time', 'other'], ['__proto__']]) {
      expect(() => preparePlannerCandidate({ ...options, selected: [path] })).toThrow('требуют проверки');
    }
    const unsafe = structuredClone(options.snapshot);
    const getter = vi.fn(() => 'PRIVATE');
    Object.defineProperty(unsafe.plannerEntries[0], 'time', { enumerable: true, get: getter });
    expect(() => preparePlannerCandidate({ ...options, snapshot: unsafe, selected: [['time']] })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['title', '', ['title']],
    ['title', 'x'.repeat(161), ['title']],
    ['title', ' Название ', ['title']],
    ['date', '2026-02-29', ['date']],
    ['date', '2026-13-01', ['date']],
    ['time', '24:00', ['time']],
    ['time', '21:60', ['time']],
    ['durationMinutes', 0, ['durationMinutes']],
    ['durationMinutes', 1441, ['durationMinutes']],
    ['durationMinutes', 1.5, ['durationMinutes']],
    ['reminderMinutes', -1, ['reminderMinutes']],
    ['reminderMinutes', 525601, ['reminderMinutes']],
    ['recurrenceEnd', '2026-02-30', ['recurrenceEnd']],
    ['updatedAt', '2026-02-30T00:00:00.000Z', ['updatedAt']],
    ['status', 'unknown', ['status']]
  ])('не нормализует молча недопустимое входящее значение %s=%s', async (field, value, path) => {
    const { options } = await scenario({ editRemote: row => (row.fields[field] = value) });
    const before = JSON.stringify(options.snapshot);
    expect(() => preparePlannerCandidate({ ...options, selected: [path] })).toThrow();
    expect(JSON.stringify(options.snapshot)).toBe(before);
  });

  it.each([null, [], 'нет отметок', 0])(
    'не принимает повреждённый контейнер отметок %s и не портит выбор другого поля',
    async invalidStatuses => {
      const { options } = await scenario({
        editRemote: row => {
          row.fields.statusByDate = invalidStatuses;
          row.fields.time = '20:30';
        }
      });
      const result = preparePlannerCandidate({ ...options, selected: [['time']] });
      expect(result.candidateState().plannerEntries[0].statusByDate).toEqual(
        options.snapshot.plannerEntries[0].statusByDate
      );
      expect(paths(result.details().pending)).toContain('statusByDate');
      expect(() => preparePlannerCandidate({ ...options, selected: [['statusByDate']] })).toThrow('требуют проверки');
    }
  );

  it.each([
    ['0000-01-01T00:00:00Z'],
    ['2026-11-01T24:00:00Z'],
    ['2026-11-01T23:60:00Z'],
    ['2026-11-01T23:59:60Z'],
    ['2026-11-01T23:59:59+24:00'],
    ['2026-11-01T23:59:59+03:60']
  ])('отклоняет некорректный timestamp %s без записи кандидата', async timestamp => {
    const { options } = await scenario({ editRemote: row => (row.fields.updatedAt = timestamp) });
    expect(() => preparePlannerCandidate({ ...options, selected: [['updatedAt']] })).toThrow('требуют проверки');
  });

  it.each(['2028-02-29T23:59:59.999+14:00', '2026-11-01T00:00:00-03:30', '2026-11-01T23:59:59Z'])(
    'сохраняет корректную временную отметку без молчаливого преобразования: %s',
    async timestamp => {
      const { options } = await scenario({ editRemote: row => (row.fields.updatedAt = timestamp) });
      const prepared = preparePlannerCandidate({ ...options, selected: [['updatedAt']] });
      expect(prepared.candidateState().plannerEntries[0].updatedAt).toBe(timestamp);
    }
  );

  it('проверяет реальные даты в отметках повтора, включая високосный день', async () => {
    const { options } = await scenario({
      editRemote: row => {
        row.fields.statusByDate['2028-02-29'] = 'done';
        row.fields.statusByDate['2026-02-29'] = 'doing';
      }
    });
    const valid = preparePlannerCandidate({ ...options, selected: [['statusByDate', '2028-02-29']] });
    expect(valid.candidateState().plannerEntries[0].statusByDate['2028-02-29']).toBe('done');
    expect(paths(valid.details().pending)).toContain('statusByDate/2026-02-29');
    expect(() => preparePlannerCandidate({ ...options, selected: [['statusByDate', '2026-02-29']] })).toThrow();
  });
});
