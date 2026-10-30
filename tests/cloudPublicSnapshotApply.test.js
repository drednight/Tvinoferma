import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { createMarathon, createSeries, createTask } from '../js/modules/marathons/model.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { comparePublicSnapshots } from '../js/modules/cloudSync/compareSnapshots.js';
import {
  preparePublicSnapshotApply,
  prepareFullPublicSnapshotReplace
} from '../js/modules/cloudSync/applyPublicSnapshot.js';
import { generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { sealHistoryVersion } from '../js/modules/cloudSync/history.js';
import { prepareCloudReview } from '../js/modules/cloudSync/cloudReview.js';
import { planConservativePublicMerge } from '../js/modules/cloudSync/conservativeMerge.js';

const groupNames = ['appearance', 'navigation', 'planner', 'eventReminders'];
function ready(raw) {
  const { ui, ...snapshot } = normalizeState(raw);
  return planSyncIdentities({ snapshot, cryptoSource: webcrypto }).snapshot;
}
function remoteState() {
  const series = createSeries({ id: 'remote-series', title: 'Серия', childIds: ['remote-marathon'] });
  const marathon = createMarathon({
    id: 'remote-marathon',
    title: 'Марафон',
    seriesId: 'remote-series',
    source: { type: 'template', templateId: 'remote-template' },
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    participantIds: ['remote-hero'],
    tasks: [
      createTask({
        id: 'remote-task',
        title: 'Задание',
        rewards: [{ id: 'remote-reward', threshold: 2, rewardText: 'Награда', rewardCoins: 5 }]
      })
    ],
    bonuses: [{ id: 'remote-bonus', needTasks: 1, text: 'Бонус' }],
    assignments: { 'remote-hero': ['remote-task'] },
    progress: { 'remote-hero': { 'remote-task': { site: 1, marks: ['2026-10-02'], history: { '2026-10-02': 1 } } } },
    balance: { start: { 'remote-hero': { coins: 3, at: '2026-10-01' } }, end: {} },
    awards: [
      {
        characterId: 'remote-hero',
        charNick: 'Герой',
        taskId: 'remote-task',
        taskTitle: 'Задание',
        rewardText: 'Награда',
        coins: 5
      }
    ],
    lastSync: { at: '2026-10-02', errors: [{ error: 'REMOTE_PRIVATE_STATUS' }], changes: [] }
  });
  return ready({
    schemaVersion: 10,
    characters: [
      {
        id: 'remote-hero',
        nick: 'Герой',
        partyIds: ['remote-party'],
        mainPartyId: 'remote-party',
        partyOrder: { 'remote-party': 2 },
        ancientCoins: 40,
        contacts: { email: 'remote@example.test', password: 'REMOTE_SECRET' },
        launch: { gcPath: '/remote/private' }
      }
    ],
    parties: [{ id: 'remote-party', name: 'Альфа', order: 1 }],
    marathons: [series, marathon],
    marathonTemplates: [{ id: 'remote-template', name: 'Шаблон', tasks: [], bonuses: [] }],
    plannerEntries: [
      {
        id: 'remote-task-day',
        title: 'Задача',
        date: '2026-10-28',
        kind: 'task',
        recurrence: 'daily',
        statusByDate: { '2026-10-28': 'done' }
      },
      { id: 'guild-462', title: 'Клан', date: '2026-10-29', kind: 'event', status: 'done' }
    ],
    finance: {
      operations: [
        {
          id: 'remote-op',
          date: '2026-10-28',
          kind: 'out',
          currency: 'coins',
          amount: 50,
          counterparty: 'Долг',
          source: 'debt',
          ref: 'remote-loan'
        }
      ],
      shopItems: [{ id: 'remote-item', name: 'Предмет', side: 'sell', price: 5, qty: 2, date: '2026-10-28' }],
      loans: [
        {
          id: 'remote-loan',
          direction: 'lent',
          who: 'Игрок',
          principal: 50,
          start: '2026-10-28',
          currency: 'coins',
          opId: 'remote-op',
          payments: [{ id: 'remote-payment', date: '2026-10-29', amount: 10 }]
        }
      ],
      settings: { goldRate: 12, goldRateAt: '2026-10-28', commissionPct: 2, opening: { gold: 100, coins: 5 } }
    }
  });
}
function publicView(state) {
  return buildPublicSnapshot(state, { settingsSelections: groupNames });
}
function selectAll(snapshot) {
  return ['characters', 'parties', 'marathons', 'planner', 'finance'].flatMap(section =>
    snapshot.sections[section].records.map(record => ({ section, id: record.id }))
  );
}
function prepare(localState, cloudSnapshot, selectedRecords, options = {}) {
  return preparePublicSnapshotApply({
    localState,
    cloudSnapshot,
    selectedRecords,
    cryptoSource: webcrypto,
    ...options
  });
}

describe('выборочный кандидат облачного снимка', () => {
  it('переносит все связанные разделы на чистый ПК без чужих локальных секретов и ID', () => {
    const local = ready({ schemaVersion: 10 });
    const remote = remoteState();
    const cloud = publicView(remote);
    const localBefore = JSON.stringify(local);
    const cloudBefore = JSON.stringify(cloud);
    const result = prepare(local, cloud, selectAll(cloud), {
      selectedSettings: groupNames,
      includeFinanceSettings: true
    });
    expect(result.status).toBe('prepared');
    const candidate = result.candidateState();
    expect(comparePublicSnapshots({ local: publicView(candidate), cloud }).entries).toEqual([]);
    expect(JSON.stringify(local)).toBe(localBefore);
    expect(JSON.stringify(cloud)).toBe(cloudBefore);
    expect(candidate.characters[0].syncId).toBe(remote.characters[0].syncId);
    expect(candidate.characters[0].id).not.toBe(remote.characters[0].id);
    expect(candidate.characters[0].contacts.password).toBe('');
    expect(candidate.characters[0].launch.gcPath).toBe('');
    expect(candidate.characters[0].isLoggedIn).toBe(false);
    expect(candidate.characters[0].partyIds).toEqual([candidate.parties[0].id]);
    expect(candidate.marathons[1].participantIds).toEqual([candidate.characters[0].id]);
    expect(candidate.marathons[1].tasks[0].syncId).toBe(remote.marathons[1].tasks[0].syncId);
    expect(candidate.marathons[1].lastSync).toBe(null);
    expect(candidate.plannerEntries.find(x => x.id === 'guild-462').status).toBe('done');
    expect(candidate.finance.loans[0].opId).toBe(candidate.finance.operations[0].id);
    expect(candidate.finance.operations[0].ref).toBe(candidate.finance.loans[0].id);
    expect(candidate.finance.loans[0].payments[0].syncId).toBe(remote.finance.loans[0].payments[0].syncId);
    expect(JSON.stringify(candidate)).not.toContain('REMOTE_SECRET');
    expect(JSON.stringify(candidate)).not.toContain('REMOTE_PRIVATE_STATUS');
    const again = result.candidateState();
    candidate.characters[0].nick = 'mutated';
    expect(again.characters[0].nick).toBe('Герой');
  });

  it('меняет только выбранное и оставляет контакты, путь, авторизацию и локальный журнал', () => {
    const local = remoteState();
    local.characters[0].contacts.password = 'LOCAL_SECRET';
    local.characters[0].launch.gcPath = '/local/private';
    local.characters[0].isLoggedIn = true;
    local.marathons[1].lastSync = { at: 'local', errors: [], changes: [] };
    const remote = structuredClone(local);
    remote.characters[0].ancientCoins = 123;
    remote.characters[0].notes = 'Облако';
    remote.plannerEntries[0].title = 'Не выбрано';
    remote.marathons[1].title = 'Новый марафон';
    remote.marathons[1].lastSync = { at: 'remote', errors: [], changes: [] };
    const cloud = publicView(remote);
    const result = prepare(local, cloud, [
      { section: 'characters', id: local.characters[0].syncId },
      { section: 'marathons', id: local.marathons[1].syncId }
    ]).candidateState();
    expect(result.characters[0]).toMatchObject({
      id: local.characters[0].id,
      ancientCoins: 123,
      notes: 'Облако',
      isLoggedIn: true,
      contacts: { password: 'LOCAL_SECRET' },
      launch: { gcPath: '/local/private' }
    });
    expect(result.marathons[1].title).toBe('Новый марафон');
    expect(result.marathons[1].lastSync.at).toBe('local');
    expect(result.plannerEntries[0].title).toBe(local.plannerEntries[0].title);
    expect(result.finance).toEqual(local.finance);
  });

  it('не считает отсутствие на диске удалением и не применяет неподтверждённые настройки', () => {
    const local = remoteState();
    const remote = structuredClone(local);
    remote.plannerEntries = [];
    remote.settings.ui.theme = 'light';
    remote.finance.settings.goldRate = 77;
    const candidate = prepare(local, publicView(remote), []).candidateState();
    expect(candidate.plannerEntries).toEqual(local.plannerEntries);
    expect(candidate.settings.ui.theme).toBe(local.settings.ui.theme);
    expect(candidate.finance.settings).toEqual(local.finance.settings);
  });

  it('отклоняет недостающие зависимости и совпадающий ник с другим sync-ID', () => {
    const local = ready({ schemaVersion: 10 });
    const remote = remoteState();
    const cloud = publicView(remote);
    const char = cloud.sections.characters.records[0];
    expect(() => prepare(local, cloud, [{ section: 'characters', id: char.id }])).toThrow('связанных');
    const collision = ready({ schemaVersion: 10, characters: [{ id: 'another-local', nick: 'Герой' }] });
    expect(() => prepare(collision, cloud, selectAll(cloud))).toThrow('сопоставление');
  });

  it('сохраняет нормальный порядок партий и финансов после добавления с другого ПК', () => {
    const local = ready({
      schemaVersion: 10,
      parties: [{ id: 'local-p', name: 'Местная', order: 5 }],
      finance: { operations: [{ id: 'local-op', date: '2026-10-01', kind: 'in', amount: 5, currency: 'coins' }] }
    });
    const remote = remoteState();
    const cloud = publicView(remote);
    const selected = [
      { section: 'parties', id: remote.parties[0].syncId },
      ...cloud.sections.finance.records.map(record => ({ section: 'finance', id: record.id }))
    ];
    const candidate = prepare(local, cloud, selected).candidateState();
    expect(candidate.parties.map(item => item.name)).toEqual(['Альфа', 'Местная']);
    expect(candidate.finance.operations.map(item => item.date)).toEqual(['2026-10-28', '2026-10-01']);
  });

  it('не создаёт совпадение ников при изменении существующей записи', () => {
    const local = ready({
      schemaVersion: 10,
      characters: [
        { id: 'one', nick: 'Один' },
        { id: 'two', nick: 'Два' }
      ]
    });
    const remote = structuredClone(local);
    remote.characters[0].nick = 'Два';
    expect(() =>
      prepare(local, publicView(remote), [{ section: 'characters', id: local.characters[0].syncId }])
    ).toThrow('сопоставление');
  });

  it('не удаляет вложенные задания, награды или бонусы по отсутствию', () => {
    const local = remoteState();
    for (const change of [
      marathon => {
        marathon.tasks = [];
        marathon.assignments = {};
        marathon.progress = {};
        marathon.awards = [];
      },
      marathon => {
        marathon.tasks[0].rewards = [];
      },
      marathon => {
        marathon.bonuses = [];
      }
    ]) {
      const remote = structuredClone(local);
      change(remote.marathons[1]);
      expect(() =>
        prepare(local, publicView(remote), [{ section: 'marathons', id: remote.marathons[1].syncId }])
      ).toThrow('удаления');
    }
  });

  it('готовит кандидат только из выбранного проверенного конверта и отклоняет устаревший просмотр', async () => {
    const local = ready({ schemaVersion: 10 });
    const cloud = publicView(remoteState());
    const datasetId = generateSyncId(webcrypto);
    const dataKey = generateRecoveryKey(webcrypto);
    const root = await sealHistoryVersion({
      publicSnapshot: cloud,
      parent: null,
      recoveryKey: dataKey,
      datasetId,
      versionId: generateSyncId(webcrypto),
      cryptoSource: webcrypto
    });
    const session = {
      listWithDates: async () => ({
        status: 'listed',
        versions: [{ versionId: root.pin.versionId, modifiedAt: null }]
      }),
      read: async versionId =>
        versionId === root.pin.versionId ? { status: 'found', envelope: root.envelope } : { status: 'not_found' }
    };
    const review = await prepareCloudReview({
      provider: 'google',
      session,
      datasetId,
      dataKey,
      rootPin: root.pin,
      knownPins: [root.pin],
      localSnapshot: publicView(local),
      localSavedAt: null,
      cryptoSource: webcrypto
    });
    expect(review.status).toBe('ready_for_review');
    const prepared = review.prepareApply(root.pin, {
      localState: local,
      selectedRecords: selectAll(cloud),
      selectedSettings: groupNames,
      includeFinanceSettings: true,
      cryptoSource: webcrypto
    });
    expect(prepared.candidateState().characters[0].nick).toBe('Герой');
    expect(() =>
      review.prepareApply({ ...root.pin, sha256: '0'.repeat(64) }, { localState: local, selectedRecords: [] })
    ).toThrow();
    const changed = structuredClone(local);
    changed.plannerEntries.push(remoteState().plannerEntries[0]);
    expect(() => review.prepareApply(root.pin, { localState: changed, selectedRecords: [] })).toThrow('изменились');
  });

  it('отклоняет неизвестные, повторные и повреждённые выборы', () => {
    const local = remoteState();
    const cloud = publicView(local);
    const choice = { section: 'characters', id: local.characters[0].syncId };
    expect(() => prepare(local, cloud, [choice, choice])).toThrow();
    expect(() => prepare(local, cloud, [{ ...choice, section: 'cookies' }])).toThrow();
    expect(() => prepare(local, cloud, [{ ...choice, id: 'not-a-sync-id' }])).toThrow();
    expect(() => prepare(local, cloud, [], { selectedSettings: ['security'] })).toThrow();
    const bad = structuredClone(cloud);
    bad.sections.characters.records[0].fields.ancientCoins = 'not-a-number';
    expect(() => prepare(local, bad, [choice])).toThrow();
  });
});

describe('объединение существующих разделов без потери местных данных', () => {
  it('сохраняет независимые изменения персонажа, пати, марафона, календаря и финансов', () => {
    const source = remoteState();
    const base = publicView(source);
    const localState = structuredClone(source);
    const single = localState.marathons.find(m => m.kind === 'single');
    const beforeLastSync = structuredClone(single.lastSync);
    const taskId = single.tasks[0].id;
    const rewardId = single.tasks[0].rewards[0].id;
    const paymentId = localState.finance.loans[0].payments[0].id;
    localState.characters[0].notes = 'ЛОКАЛЬНОЕ ПРИМЕЧАНИЕ';
    localState.parties[0].color = '#abcdef';
    single.description = 'ЛОКАЛЬНОЕ ОПИСАНИЕ МАРАФОНА';
    localState.plannerEntries.find(entry => entry.id === 'remote-task-day').priority = 'high';
    localState.finance.settings.opening.gold = 123;
    const local = publicView(localState);
    const cloud = structuredClone(base);
    cloud.sections.characters.records[0].fields.level = 30;
    cloud.sections.parties.records[0].fields.name = 'Новое имя пати';
    const marathon = cloud.sections.marathons.records.find(record => record.type === 'marathon');
    const charSyncId = cloud.sections.characters.records[0].id;
    const taskSyncId = marathon.fields.tasks[0].id;
    marathon.fields.progress[charSyncId][taskSyncId].site = 2;
    cloud.sections.planner.records.find(record => record.fields.source.kind === 'manual').fields.status = 'done';
    cloud.sections.finance.records.find(record => record.type === 'financeOperation').fields.note =
      'ОБЛАЧНОЕ ПРИМЕЧАНИЕ';
    const plan = planConservativePublicMerge({ base, local, cloud });
    expect(plan.status).toBe('prepared');
    expect(new Set(plan.selectedRecords().map(item => item.section))).toEqual(
      new Set(['characters', 'parties', 'marathons', 'planner', 'finance'])
    );
    const applied = preparePublicSnapshotApply({
      localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    });
    const candidate = applied.candidateState();
    expect(comparePublicSnapshots({ local: plan.snapshot(), cloud: publicView(candidate) }).entries).toEqual([]);
    expect(candidate.characters[0]).toMatchObject({ notes: 'ЛОКАЛЬНОЕ ПРИМЕЧАНИЕ', level: 30 });
    expect(candidate.characters[0].contacts.password).toBe('REMOTE_SECRET');
    expect(candidate.characters[0].launch.gcPath).toBe('/remote/private');
    expect(candidate.parties[0]).toMatchObject({ name: 'Новое имя пати', color: '#abcdef' });
    const afterSingle = candidate.marathons.find(m => m.kind === 'single');
    expect(afterSingle.description).toBe('ЛОКАЛЬНОЕ ОПИСАНИЕ МАРАФОНА');
    expect(afterSingle.lastSync).toEqual(beforeLastSync);
    expect(afterSingle.tasks[0].id).toBe(taskId);
    expect(afterSingle.tasks[0].rewards[0].id).toBe(rewardId);
    expect(afterSingle.progress['remote-hero'][taskId].site).toBe(2);
    expect(candidate.plannerEntries.find(entry => entry.id === 'remote-task-day')).toMatchObject({
      priority: 'high',
      status: 'done'
    });
    expect(candidate.finance.settings.opening.gold).toBe(123);
    expect(candidate.finance.operations[0].note).toBe('ОБЛАЧНОЕ ПРИМЕЧАНИЕ');
    expect(candidate.finance.loans[0].payments[0].id).toBe(paymentId);
    expect(candidate.finance.loans[0].opId).toBe(candidate.finance.operations[0].id);
  });

  it('без выбора финансов сохраняет их локальный реестр и идентификаторы без реконструкции', () => {
    const local = remoteState();
    const originalFinance = structuredClone(local.finance);
    const cloud = publicView(local);
    cloud.sections.characters.records[0].fields.level = 45;
    const prepared = preparePublicSnapshotApply({
      localState: local,
      cloudSnapshot: cloud,
      selectedRecords: [{ section: 'characters', id: cloud.sections.characters.records[0].id }],
      cryptoSource: webcrypto
    });
    expect(prepared.candidateState().finance).toEqual(originalFinance);
  });
});

describe('полная замена публичным файлом — не частичный merge', () => {
  it('удаляет все отсутствующие записи, включая полностью пустой банк', () => {
    const local = remoteState(),
      cloud = buildPublicSnapshot(ready({}), { settingsSelections: groupNames });
    const candidate = prepareFullPublicSnapshotReplace({
      localState: local,
      cloudSnapshot: cloud,
      cryptoSource: webcrypto
    }).candidateState();
    expect(candidate.characters).toEqual([]);
    expect(candidate.parties).toEqual([]);
    expect(candidate.marathons).toEqual([]);
    expect(candidate.marathonTemplates).toEqual([]);
    expect(candidate.plannerEntries).toEqual([]);
    expect(candidate.finance.operations).toEqual([]);
    expect(candidate.finance.shopItems).toEqual([]);
    expect(candidate.finance.loans).toEqual([]);
    expect(
      comparePublicSnapshots({ local: buildPublicSnapshot(candidate, { settingsSelections: groupNames }), cloud })
        .entries
    ).toEqual([]);
  });
  it('заменяет поля целиком, но не импортирует контакты и пути другого ПК', () => {
    const local = remoteState(),
      incoming = structuredClone(local);
    incoming.characters[0].notes = 'ЗАМЕНА';
    incoming.characters[0].contacts.password = 'ЧУЖОЙ ПАРОЛЬ';
    incoming.characters[0].launch.gcPath = '/other/path';
    const cloud = buildPublicSnapshot(incoming, { settingsSelections: groupNames });
    const candidate = prepareFullPublicSnapshotReplace({
      localState: local,
      cloudSnapshot: cloud,
      cryptoSource: webcrypto
    }).candidateState();
    expect(candidate.characters[0]).toMatchObject({
      notes: 'ЗАМЕНА',
      contacts: local.characters[0].contacts,
      launch: local.characters[0].launch
    });
    expect(local.characters[0].notes).not.toBe('ЗАМЕНА');
  });
  it('сохраняет точный порядок и архив вместо местного порядка', () => {
    const local = remoteState(),
      incoming = structuredClone(local);
    incoming.archivedCharacters.push(incoming.characters.shift());
    const cloud = buildPublicSnapshot(incoming);
    const candidate = prepareFullPublicSnapshotReplace({
      localState: local,
      cloudSnapshot: cloud,
      cryptoSource: webcrypto
    }).candidateState();
    expect(candidate.characters).toEqual([]);
    expect(candidate.archivedCharacters[0].syncId).toBe(local.characters[0].syncId);
  });
  it('отклоняет файл с оборванными ссылками до записи', () => {
    const local = remoteState(),
      cloud = buildPublicSnapshot(local);
    cloud.sections.parties.records = [];
    cloud.sections.parties.order = { active: [], archived: [] };
    expect(() =>
      prepareFullPublicSnapshotReplace({ localState: local, cloudSnapshot: cloud, cryptoSource: webcrypto })
    ).toThrow();
  });
});
