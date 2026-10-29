import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { createMarathon, createSeries, createTask } from '../js/modules/marathons/model.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { comparePublicSnapshots } from '../js/modules/cloudSync/compareSnapshots.js';
import { encryptPreparedSnapshot } from '../js/modules/cloudSync/encryptPreparedSnapshot.js';
import { decryptSnapshot, generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';

function preparedState() {
  const task = createTask({
    id: 'private-task-id',
    title: 'Пройти подземелье',
    targetChecks: 3,
    rewards: [{ id: 'private-reward-id', threshold: 2, rewardText: 'Награда', rewardCoins: 7 }]
  });
  const marathon = createMarathon({
    id: 'private-marathon-id',
    title: 'Марафон',
    seriesId: 'private-series-id',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    participantIds: ['private-hero-id'],
    tasks: [task],
    bonuses: [{ id: 'private-bonus-id', needTasks: 1, text: 'Бонус' }],
    assignments: { 'private-hero-id': ['private-task-id'] },
    progress: { 'private-hero-id': { 'private-task-id': { site: 1, marks: ['2026-10-02'] } } },
    lastSync: { at: '2026-10-02', errors: [{ error: 'PRIVATE_LOGIN_STATUS' }], changes: [] }
  });
  const series = createSeries({ id: 'private-series-id', title: 'Серия', childIds: ['private-marathon-id'] });
  const state = normalizeState({
    schemaVersion: 10,
    characters: [
      {
        id: 'private-hero-id',
        nick: 'Герой',
        partyIds: ['private-party-id'],
        mainPartyId: 'private-party-id',
        contacts: {
          email: 'private-email@example.test',
          password: 'PRIVATE_PASSWORD',
          recoveryEmail: 'PRIVATE_RECOVERY',
          phone: 'PRIVATE_PHONE'
        },
        launch: { gcPath: '/PRIVATE/PATH' },
        ancientCoins: 32,
        tags: ['танк']
      }
    ],
    parties: [{ id: 'private-party-id', name: 'Альфа', order: 1 }],
    marathons: [series, marathon],
    marathonTemplates: [{ id: 'private-template-id', name: 'Шаблон', tasks: [] }],
    plannerEntries: [
      {
        id: 'private-day-task',
        title: 'Задача дня',
        date: '2026-10-28',
        kind: 'task',
        recurrence: 'daily',
        status: 'doing',
        statusByDate: { '2026-10-28': 'done', '2026-10-29': 'todo' }
      },
      { id: 'guild-462', title: 'Клановый поход', date: '2026-10-29', kind: 'event', status: 'done' },
      { id: 'private-note-id', title: 'Заметка', date: '2026-10-29', kind: 'note' }
    ]
  });
  const { ui, ...snapshot } = state;
  return planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot;
}

function cryptoOptions(snapshot) {
  return {
    snapshot,
    recoveryKey: generateRecoveryKey(webcrypto),
    datasetId: generateSyncId(webcrypto),
    versionId: generateSyncId(webcrypto),
    cryptoSource: webcrypto
  };
}

async function decrypt(envelope, options) {
  return decryptSnapshot({
    envelope,
    recoveryKey: options.recoveryKey,
    expectedDatasetId: options.datasetId,
    cryptoSource: webcrypto
  });
}

describe('полный подготовленный публичный набор', () => {
  it('собирает разделы и ссылки, включая все типы календарных записей и отметки по дням', () => {
    const source = preparedState();
    const before = JSON.stringify(source);
    const snapshot = buildPublicSnapshot(source);
    const { characters, parties, marathons, planner, finance, preferences } = snapshot.sections;
    expect(characters.records[0].fields).toMatchObject({
      nick: 'Герой',
      ancientCoins: 32,
      partyIds: [parties.records[0].id]
    });
    expect(marathons.records.find(row => row.type === 'marathon').fields).toMatchObject({
      participantIds: [characters.records[0].id],
      tasks: [{ title: 'Пройти подземелье', rewards: [{ rewardCoins: 7 }] }]
    });
    expect(planner.records).toHaveLength(3);
    expect(planner.records[0].fields).toMatchObject({
      kind: 'task',
      source: { kind: 'manual' },
      recurrence: 'daily',
      status: 'doing',
      statusByDate: { '2026-10-28': 'done', '2026-10-29': 'todo' }
    });
    expect(planner.records[1].fields).toMatchObject({
      kind: 'event',
      source: { kind: 'guild', eventId: '462' },
      status: 'done'
    });
    expect(planner.records[2].fields.kind).toBe('note');
    expect(finance.records).toEqual([]);
    expect(preferences.selections).toEqual([]);
    const text = JSON.stringify(snapshot);
    for (const excluded of [
      'PRIVATE_PASSWORD',
      'PRIVATE_RECOVERY',
      'PRIVATE_PHONE',
      'private-email@example.test',
      '/PRIVATE/PATH',
      'PRIVATE_LOGIN_STATUS',
      'private-hero-id',
      'guild-462'
    ]) {
      expect(text).not.toContain(excluded);
    }
    expect(JSON.stringify(source)).toBe(before);
    planner.records[0].fields.statusByDate['2026-10-28'] = 'todo';
    expect(source.plannerEntries[0].statusByDate['2026-10-28']).toBe('done');
  });

  it('сохраняет только явно выбранные переносимые настройки', () => {
    const snapshot = buildPublicSnapshot(preparedState(), { settingsSelections: ['appearance', 'planner'] });
    expect(snapshot.sections.preferences.selections).toEqual(['appearance', 'planner']);
    expect(Object.keys(snapshot.sections.preferences.values)).toEqual(['appearance', 'planner']);
    expect(() => buildPublicSnapshot(preparedState(), { settingsSelections: ['launch'] })).toThrow();
  });

  it('не собирает неполный или повреждённый набор и не вызывает getters', () => {
    const missing = preparedState();
    delete missing.plannerEntries;
    expect(() => buildPublicSnapshot(missing)).toThrow();
    const unknownVersion = preparedState();
    unknownVersion.schemaVersion = 999;
    expect(() => buildPublicSnapshot(unknownVersion)).toThrow();
    const duplicate = preparedState();
    duplicate.plannerEntries[0].syncId = duplicate.characters[0].syncId;
    expect(() => buildPublicSnapshot(duplicate)).toThrow();
    const overlapsLocal = preparedState();
    overlapsLocal.plannerEntries[1].id = overlapsLocal.characters[0].syncId;
    expect(() => buildPublicSnapshot(overlapsLocal)).toThrow();
    const nestedDuplicate = preparedState();
    nestedDuplicate.marathons[1].tasks[0].syncId = nestedDuplicate.parties[0].syncId;
    expect(() => buildPublicSnapshot(nestedDuplicate)).toThrow();
    const getterState = preparedState();
    const getter = vi.fn(() => 'secret');
    Object.defineProperty(getterState.plannerEntries[0], 'title', { enumerable: true, get: getter });
    expect(() => buildPublicSnapshot(getterState)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('предварительное сравнение без применения', () => {
  it('показывает конкретные изменённые поля и состояния событий по датам', () => {
    const source = preparedState();
    const local = buildPublicSnapshot(source);
    const changed = structuredClone(source);
    changed.characters[0].level = 99;
    changed.plannerEntries[0].statusByDate['2026-10-29'] = 'done';
    changed.plannerEntries[1].status = 'todo';
    changed.marathons[1].tasks[0].title = 'Новая цель';
    const cloud = buildPublicSnapshot(changed);
    const before = JSON.stringify([local, cloud]);
    const { entries } = comparePublicSnapshots({ local, cloud });
    expect(entries.find(e => e.section === 'characters')).toMatchObject({
      kind: 'changed',
      label: 'Герой',
      changes: expect.arrayContaining([
        { path: ['level'], local: { present: true, value: 1 }, cloud: { present: true, value: 99 } }
      ])
    });
    expect(entries.find(e => e.id === source.plannerEntries[0].syncId).changes).toContainEqual({
      path: ['statusByDate', '2026-10-29'],
      local: { present: true, value: 'todo' },
      cloud: { present: true, value: 'done' }
    });
    expect(entries.find(e => e.id === source.plannerEntries[1].syncId).changes).toContainEqual({
      path: ['status'],
      local: { present: true, value: 'done' },
      cloud: { present: true, value: 'todo' }
    });
    expect(entries.find(e => e.type === 'marathon').changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['tasks', source.marathons[1].tasks[0].syncId, 'title'] })
      ])
    );
    expect(JSON.stringify([local, cloud])).toBe(before);
  });

  it('по отдельному выбору сравнивает настройки напоминаний встроенных событий', () => {
    const source = preparedState();
    const options = { settingsSelections: ['eventReminders'] };
    const local = buildPublicSnapshot(source, options);
    const other = structuredClone(source);
    other.settings.notifications.events['dynasty-battle'].enabled = false;
    other.settings.notifications.events['dynasty-battle'].leadMinutes = 30;
    const cloud = buildPublicSnapshot(other, options);
    const result = comparePublicSnapshots({ local, cloud });
    expect(result.entries).toEqual([
      expect.objectContaining({
        section: 'preferences',
        kind: 'settings_changed',
        group: 'eventReminders',
        changes: expect.arrayContaining([
          {
            path: ['dynasty-battle', 'enabled'],
            local: { present: true, value: true },
            cloud: { present: true, value: false }
          },
          {
            path: ['dynasty-battle', 'leadMinutes'],
            local: { present: true, value: 10 },
            cloud: { present: true, value: 30 }
          }
        ])
      })
    ]);
    const unselected = buildPublicSnapshot(other);
    expect(comparePublicSnapshots({ local, cloud: unselected }).uncomparedSettings).toContain('eventReminders');
  });

  it('не называет отсутствие записи удалением или добавлением без подтверждённой истории', () => {
    const source = preparedState();
    const local = buildPublicSnapshot(source);
    const other = structuredClone(source);
    const missingId = other.plannerEntries[0].syncId;
    other.plannerEntries.shift();
    other.plannerEntries.push({
      ...structuredClone(other.plannerEntries[0]),
      id: 'new-manual-id',
      syncId: generateSyncId(webcrypto),
      title: 'Только на диске'
    });
    // Это новая ручная запись, не второе клановое событие с тем же внешним ID.
    const cloud = buildPublicSnapshot(other);
    const entries = comparePublicSnapshots({ local, cloud }).entries;
    expect(entries.find(e => e.id === missingId)).toMatchObject({ kind: 'only_local', label: 'Задача дня' });
    expect(entries.find(e => e.label === 'Только на диске')).toMatchObject({ kind: 'only_cloud' });
    expect(JSON.stringify(entries)).not.toMatch(/deleted|removed|добавлен|удалён/i);
  });

  it('одинаковое событие клана с разными sync-ID требует сверки идентичности', () => {
    const source = preparedState();
    const local = buildPublicSnapshot(source);
    const other = structuredClone(source);
    other.plannerEntries[1].syncId = generateSyncId(webcrypto);
    const cloud = buildPublicSnapshot(other);
    const entries = comparePublicSnapshots({ local, cloud }).entries.filter(item => item.section === 'planner');
    expect(entries).toEqual([
      {
        section: 'planner',
        kind: 'identity_review',
        type: 'plannerEntry',
        label: 'Клановый поход',
        localId: source.plannerEntries[1].syncId,
        cloudId: other.plannerEntries[1].syncId,
        changes: []
      }
    ]);
  });

  it('не сопоставляет идентификатор вложенного задания с другим типом сущности', () => {
    const source = preparedState();
    const local = buildPublicSnapshot(source);
    const other = structuredClone(source);
    other.marathons[1].tasks[0].syncId = generateSyncId(webcrypto);
    other.plannerEntries[0].syncId = source.marathons[1].tasks[0].syncId;
    const cloud = buildPublicSnapshot(other);
    expect(() => comparePublicSnapshots({ local, cloud })).toThrow();
  });

  it('невключённые настройки не интерпретирует как стирание', () => {
    const source = preparedState();
    const local = buildPublicSnapshot(source, { settingsSelections: ['appearance'] });
    const cloud = buildPublicSnapshot(source, { settingsSelections: ['planner'] });
    expect(comparePublicSnapshots({ local, cloud })).toEqual({
      entries: [],
      uncomparedSettings: ['appearance', 'planner']
    });
  });

  it('отказывает при отсутствии раздела, чужом типе, лишних секретах и неправильном порядке', () => {
    const local = buildPublicSnapshot(preparedState());
    const cloud = structuredClone(local);
    delete cloud.sections.planner;
    expect(() => comparePublicSnapshots({ local, cloud })).toThrow();
    const secret = structuredClone(local);
    secret.sections.characters.records[0].fields.password = 'PRIVATE_PASSWORD';
    expect(() => comparePublicSnapshots({ local, cloud: secret })).toThrow();
    const nestedSecret = structuredClone(local);
    nestedSecret.sections.characters.records[0].fields.sky.email = 'private';
    expect(() => comparePublicSnapshots({ local, cloud: nestedSecret })).toThrow();
    const missingOrder = structuredClone(local);
    missingOrder.sections.planner.order.pop();
    expect(() => comparePublicSnapshots({ local, cloud: missingOrder })).toThrow();
    const badGuild = structuredClone(local);
    delete badGuild.sections.planner.records[1].fields.source.eventId;
    expect(() => comparePublicSnapshots({ local, cloud: badGuild })).toThrow();
    const sameIdDifferentType = structuredClone(local);
    sameIdDifferentType.sections.characters.records[0].id = sameIdDifferentType.sections.planner.records[0].id;
    expect(() => comparePublicSnapshots({ local, cloud: sameIdDifferentType })).toThrow();
  });
});

describe('отдельный выбор контактов и шифрование до выдачи файла', () => {
  it('по умолчанию не включает контакты и пароли даже в расшифрованном наборе', async () => {
    const options = cryptoOptions(preparedState());
    const envelope = await encryptPreparedSnapshot(options);
    const payload = await decrypt(envelope, options);
    expect(payload).not.toHaveProperty('private');
    expect(JSON.stringify(payload)).not.toMatch(
      /PRIVATE_PASSWORD|PRIVATE_PHONE|PRIVATE_RECOVERY|private-email@example/
    );
    expect(JSON.stringify(envelope)).not.toMatch(/Герой|PRIVATE_|private-email/);
  });

  it('каждое поле включается независимо; невыбранные категории не становятся удалением', async () => {
    const options = {
      ...cryptoOptions(preparedState()),
      choices: { email: true, phone: true },
      contactsSourceConfirmed: true
    };
    const envelope = await encryptPreparedSnapshot(options);
    const payload = await decrypt(envelope, options);
    expect(payload.private).toEqual({
      schemaVersion: 1,
      selections: ['email', 'phone'],
      records: [
        {
          characterId: options.snapshot.characters[0].syncId,
          fields: { email: 'private-email@example.test', phone: 'PRIVATE_PHONE' }
        }
      ]
    });
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE_PASSWORD|PRIVATE_RECOVERY/);
    expect(JSON.stringify(envelope)).not.toMatch(/PRIVATE_PHONE|private-email@example/);
    const recoveryOptions = { ...options, choices: { recoveryEmail: true } };
    const recovery = await decrypt(await encryptPreparedSnapshot(recoveryOptions), recoveryOptions);
    expect(recovery.private.records[0].fields).toEqual({ recoveryEmail: 'PRIVATE_RECOVERY' });
  });

  it('не экспортирует выбранные контакты, если их источник и полнота не подтверждены', async () => {
    const options = { ...cryptoOptions(preparedState()), choices: { email: true } };
    await expect(encryptPreparedSnapshot(options)).rejects.toThrow('полнота данных контактов');
    await expect(encryptPreparedSnapshot({ ...options, contactsSourceConfirmed: false })).rejects.toThrow();
    await expect(encryptPreparedSnapshot({ ...options, contactsSourceConfirmed: 'yes' })).rejects.toThrow();
    const confirmed = { ...options, contactsSourceConfirmed: true };
    expect((await decrypt(await encryptPreparedSnapshot(confirmed), confirmed)).private.selections).toEqual(['email']);
  });

  it('пароль требует явного включения и отдельного подтверждения риска', async () => {
    const options = { ...cryptoOptions(preparedState()), choices: { password: true }, contactsSourceConfirmed: true };
    await expect(encryptPreparedSnapshot(options)).rejects.toThrow('подтвердить риск');
    const accepted = { ...options, acknowledgePasswordRisk: true };
    const envelope = await encryptPreparedSnapshot(accepted);
    expect(JSON.stringify(envelope)).not.toContain('PRIVATE_PASSWORD');
    expect((await decrypt(envelope, accepted)).private.records[0].fields).toEqual({ password: 'PRIVATE_PASSWORD' });
    await expect(encryptPreparedSnapshot({ ...accepted, choices: { password: 'yes' } })).rejects.toThrow();
    await expect(encryptPreparedSnapshot({ ...accepted, choices: { cookies: true } })).rejects.toThrow();
  });
});
