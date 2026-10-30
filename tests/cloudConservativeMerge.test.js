import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { preparePublicSnapshotApply } from '../js/modules/cloudSync/applyPublicSnapshot.js';
import { conservativeTransition, planConservativePublicMerge } from '../js/modules/cloudSync/conservativeMerge.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { parseConservativeMergeChoices } from '../js/modules/cloudSync/conservativeMergeChoices.js';
import { createMarathon } from '../js/modules/marathons/model.js';
import { applyCoinBalance } from '../js/core/coins.js';
import { rememberStatsBefore } from '../js/modules/characters/statsHistory.js';

function fixture() {
  const { ui, ...state } = normalizeState({
    schemaVersion: 10,
    characters: [
      {
        id: 'hero',
        nick: 'Герой',
        notes: 'Основная заметка',
        level: 10,
        contacts: { email: 'local@example.test', password: 'PRIVATE_PASSWORD' },
        launch: { gcPath: '/local/private/path' },
        tags: ['старый']
      }
    ],
    plannerEntries: [{ id: 'task', title: 'Задача', date: '2026-10-30' }],
    marathonTemplates: [{ id: 'template', name: 'Шаблон', tasks: [], bonuses: [] }]
  });
  const localState = planSyncIdentities({ snapshot: state, cryptoSource: webcrypto }).snapshot;
  const base = buildPublicSnapshot(localState, { settingsSelections: ['appearance'] });
  return { localState, base, local: structuredClone(base), cloud: structuredClone(base) };
}
function merge(f) {
  return planConservativePublicMerge({ base: f.base, local: f.local, cloud: f.cloud });
}

describe('консервативное трёхстороннее объединение публичного снимка', () => {
  it('совмещает независимые поля, не выбирая сторону по времени и не раскрывая секреты', () => {
    const f = fixture();
    f.local.sections.characters.records[0].fields.notes = 'ЛОКАЛЬНАЯ ПРАВКА';
    f.cloud.sections.characters.records[0].fields.level = 20;
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const merged = plan.snapshot();
    expect(merged.sections.characters.records[0].fields).toMatchObject({ notes: 'ЛОКАЛЬНАЯ ПРАВКА', level: 20 });
    expect(plan.selectedRecords()).toEqual([{ section: 'characters', id: f.base.sections.characters.records[0].id }]);
    expect(JSON.stringify(merged)).not.toContain('PRIVATE_PASSWORD');
    expect(JSON.stringify(merged)).not.toContain('/local/private/path');
    merged.sections.characters.records[0].fields.notes = 'ПОСТОРОННЕЕ ИЗМЕНЕНИЕ';
    expect(plan.snapshot().sections.characters.records[0].fields.notes).toBe('ЛОКАЛЬНАЯ ПРАВКА');
    // Материализация оставляет контакты и путь на этом ПК и переживает нормализацию.
    f.localState.characters[0].notes = 'ЛОКАЛЬНАЯ ПРАВКА';
    const applied = preparePublicSnapshotApply({
      localState: f.localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    });
    const candidate = applied.candidateState();
    expect(candidate.characters[0]).toMatchObject({ notes: 'ЛОКАЛЬНАЯ ПРАВКА', level: 20 });
    expect(candidate.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    expect(candidate.characters[0].launch.gcPath).toBe('/local/private/path');
  });

  it('объединяет прогресс сайта внутри существующего списка заданий с местной заметкой', () => {
    const f = fixture();
    f.localState.characters[0].marathonData = {
      lastSyncDate: '2026-10-30',
      quests: [{ title: 'Задание сайта', description: 'Пройти', completed: 0, total: 2, percentage: 0 }],
      summary: { completed: 0, total: 2, percentage: 0 }
    };
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.localState.characters[0].notes = 'МЕСТНАЯ НЕЗАВИСИМАЯ ЗАМЕТКА';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.cloud = structuredClone(f.base);
    const data = f.cloud.sections.characters.records[0].fields.marathonData;
    data.quests[0].completed = 1;
    data.quests[0].percentage = 50;
    data.summary.completed = 1;
    data.summary.percentage = 50;
    expect(conservativeTransition(f.base, f.cloud)).toBe(true);
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const applied = preparePublicSnapshotApply({
      localState: f.localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    }).candidateState();
    expect(applied.characters[0].notes).toBe('МЕСТНАЯ НЕЗАВИСИМАЯ ЗАМЕТКА');
    expect(applied.characters[0].marathonData.quests[0].completed).toBe(1);
    expect(applied.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    // Одинаковое название само по себе не доказывает идентичность нового задания.
    f.cloud.sections.characters.records[0].fields.marathonData.quests[0].description = 'Другое задание';
    expect(conservativeTransition(f.base, f.cloud)).toBe(false);
  });

  it('объединяет независимые поля разных заданий и наград марафона по их sync-ID', () => {
    const f = fixture();
    f.localState.marathons = [
      createMarathon({
        id: 'marathon',
        title: 'Марафон',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        tasks: [
          { id: 'task-1', title: 'Первое', rewards: [{ id: 'reward-1', threshold: 1, rewardText: 'Монеты' }] },
          { id: 'task-2', title: 'Второе', rewards: [{ id: 'reward-2', threshold: 1, rewardText: 'Сундук' }] }
        ]
      })
    ];
    f.localState = planSyncIdentities({ snapshot: f.localState, cryptoSource: webcrypto }).snapshot;
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.localState.marathons[0].tasks[0].targetChecks = 3;
    f.localState.marathons[0].tasks[0].rewards[0].rewardCoins = 15;
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.cloud = structuredClone(f.base);
    const remote = f.cloud.sections.marathons.records.find(row => row.type === 'marathon');
    remote.fields.tasks[1].title = 'Второе изменено';
    remote.fields.tasks[1].rewards[0].rewardText = 'Облачный сундук';
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const applied = preparePublicSnapshotApply({
      localState: f.localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    }).candidateState();
    expect(applied.marathons[0].tasks[0]).toMatchObject({ title: 'Первое', targetChecks: 3 });
    expect(applied.marathons[0].tasks[0].rewards[0].rewardCoins).toBe(15);
    expect(applied.marathons[0].tasks[1].title).toBe('Второе изменено');
    expect(applied.marathons[0].tasks[1].rewards[0].rewardText).toBe('Облачный сундук');
  });

  it('конфликт одного задания не скрывает независимые изменения других заданий', () => {
    const f = fixture();
    f.localState.marathons = [
      createMarathon({
        id: 'marathon',
        title: 'М',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        tasks: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' }
        ]
      })
    ];
    f.localState = planSyncIdentities({ snapshot: f.localState, cryptoSource: webcrypto }).snapshot;
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.local = structuredClone(f.base);
    f.cloud = structuredClone(f.base);
    const local = f.local.sections.marathons.records.find(row => row.type === 'marathon');
    const remote = f.cloud.sections.marathons.records.find(row => row.type === 'marathon');
    local.fields.tasks[0].title = 'ЛОКАЛЬНО';
    local.fields.tasks[1].targetChecks = 2;
    remote.fields.tasks[0].title = 'ОБЛАКО';
    remote.fields.tasks[1].description = 'НЕЗАВИСИМО ИЗ ОБЛАКА';
    remote.fields.tasks[1].descriptionSource = 'manual';
    const conflict = merge(f);
    expect(conflict.status).toBe('conflicts');
    expect(conflict.conflicts[0]).toMatchObject({
      section: 'marathons',
      id: local.id,
      path: ['fields', 'tasks', local.fields.tasks[0].id, 'title']
    });
    const resolution = {
      reviewHash: 'a'.repeat(64),
      cloudRecords: [{ section: 'marathons', id: local.id }],
      cloudSettings: [],
      cloudFinanceSettings: false
    };
    const plan = planConservativePublicMerge({ base: f.base, local: f.local, cloud: f.cloud, resolution });
    expect(plan.status).toBe('prepared');
    const tasks = plan.snapshot().sections.marathons.records.find(row => row.type === 'marathon').fields.tasks;
    expect(tasks[0].title).toBe('ОБЛАКО');
    expect(tasks[1]).toMatchObject({ targetChecks: 2, description: 'НЕЗАВИСИМО ИЗ ОБЛАКА' });
  });

  it('принимает добавленные сверху записи монет и характеристик без потери старой истории', () => {
    const f = fixture();
    const char = f.localState.characters[0];
    applyCoinBalance(char, 100, { now: '2026-10-01T00:00:00.000Z' });
    let previous = structuredClone(char.stats);
    char.stats.strength = 1;
    rememberStatsBefore(char, previous, '2026-10-01T00:00:00.000Z');
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    const cloudState = structuredClone(f.localState);
    const cloudChar = cloudState.characters[0];
    applyCoinBalance(cloudChar, 200, { now: '2026-10-02T00:00:00.000Z' });
    previous = structuredClone(cloudChar.stats);
    cloudChar.stats.strength = 2;
    rememberStatsBefore(cloudChar, previous, '2026-10-02T00:00:00.000Z');
    f.cloud = buildPublicSnapshot(cloudState, { settingsSelections: ['appearance'] });
    char.notes = 'МЕСТНАЯ ЗАМЕТКА';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const candidate = preparePublicSnapshotApply({
      localState: f.localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    }).candidateState();
    expect(candidate.characters[0].coinHistory).toHaveLength(2);
    expect(candidate.characters[0].statsHistory).toHaveLength(2);
    expect(candidate.characters[0]).toMatchObject({
      ancientCoins: 200,
      notes: 'МЕСТНАЯ ЗАМЕТКА',
      stats: { strength: 2 }
    });
  });

  it('блокирует обрезание самой старой записи истории характеристик при лимите приложения', () => {
    const f = fixture();
    const fields = f.base.sections.characters.records[0].fields;
    fields.statsHistory = Array.from({ length: 10 }, (_, index) => ({
      at: `2026-10-${String(30 - index).padStart(2, '0')}T00:00:00.000Z`,
      stats: { ...fields.stats, strength: index }
    }));
    f.local = structuredClone(f.base);
    f.cloud = structuredClone(f.base);
    const history = f.cloud.sections.characters.records[0].fields.statsHistory;
    history.unshift({ at: '2026-10-31T00:00:00.000Z', stats: { ...fields.stats, strength: 42 } });
    history.pop();
    expect(conservativeTransition(f.base, f.cloud)).toBe(false);
    expect(merge(f).status).toBe('structure_or_deletion_unsupported');
  });

  it('не принимает замену элементов истории без уникального якоря за обычную правку', () => {
    for (const history of [
      [{ delta: 1 }, { delta: 2 }],
      [
        { id: 'same', delta: 1 },
        { id: 'same', delta: 2 }
      ]
    ]) {
      const f = fixture();
      f.base.sections.characters.records[0].fields.coinHistory = structuredClone(history);
      f.local = structuredClone(f.base);
      f.cloud = structuredClone(f.base);
      f.cloud.sections.characters.records[0].fields.coinHistory = [
        structuredClone(history[1]),
        { ...history[1], delta: 3 }
      ];
      expect(conservativeTransition(f.base, f.cloud)).toBe(false);
      expect(merge(f).status).toBe('structure_or_deletion_unsupported');
      f.cloud.sections.characters.records[0].fields.coinHistory = [...structuredClone(history), { delta: 4 }];
      expect(conservativeTransition(f.base, f.cloud)).toBe(true);
    }
  });

  it('не подменяет или удаляет элементы истории, а одновременные изменения массива считает конфликтом', () => {
    const f = fixture();
    const field = f.base.sections.characters.records[0].fields;
    field.coinHistory = [{ id: 'entry1', date: '2026-10-29', delta: 2 }];
    f.local = structuredClone(f.base);
    f.cloud = structuredClone(f.base);
    f.cloud.sections.characters.records[0].fields.coinHistory.unshift({ id: 'cloud', date: '2026-10-30', delta: 3 });
    expect(conservativeTransition(f.base, f.cloud)).toBe(true);
    f.local.sections.characters.records[0].fields.coinHistory.unshift({ id: 'local', date: '2026-10-30', delta: 4 });
    expect(merge(f).status).toBe('conflicts');
    f.cloud.sections.characters.records[0].fields.coinHistory[1].delta = 3;
    expect(conservativeTransition(f.base, f.cloud)).toBe(false);
    f.cloud.sections.characters.records[0].fields.coinHistory = [];
    expect(conservativeTransition(f.base, f.cloud)).toBe(false);
  });

  it('сообщает конфликт при разных правках одного поля; значения в описании не выдаёт', () => {
    const f = fixture();
    f.local.sections.characters.records[0].fields.notes = 'ЛИЧНЫЙ ЛОКАЛЬНЫЙ ТЕКСТ';
    f.cloud.sections.characters.records[0].fields.notes = 'ЛИЧНЫЙ ОБЛАЧНЫЙ ТЕКСТ';
    const result = merge(f);
    expect(result.status).toBe('conflicts');
    expect(result.conflicts).toMatchObject([{ section: 'characters', path: ['fields', 'notes'], reason: 'field' }]);
    expect(JSON.stringify(result)).not.toContain('ЛИЧНЫЙ ЛОКАЛЬНЫЙ ТЕКСТ');
    expect(JSON.stringify(result)).not.toContain('ЛИЧНЫЙ ОБЛАЧНЫЙ ТЕКСТ');
    expect(result.snapshot).toBeUndefined();
  });

  it('по явному выбору решает конфликтующие поля, сохраняя независимые изменения обеих сторон', () => {
    const f = fixture();
    const id = f.base.sections.characters.records[0].id;
    f.local.sections.characters.records[0].fields.notes = 'МЕСТНАЯ';
    f.local.sections.characters.records[0].fields.level = 33;
    f.cloud.sections.characters.records[0].fields.notes = 'ОБЛАЧНАЯ';
    f.cloud.sections.characters.records[0].fields.ancientCoins = 42;
    const choices = { reviewHash: 'a'.repeat(64), cloudRecords: [], cloudSettings: [], cloudFinanceSettings: false };
    expect(merge(f).status).toBe('conflicts');
    const localWins = planConservativePublicMerge({
      base: f.base,
      local: f.local,
      cloud: f.cloud,
      resolution: choices
    });
    expect(localWins.status).toBe('prepared');
    expect(localWins.snapshot().sections.characters.records[0].fields).toMatchObject({
      notes: 'МЕСТНАЯ',
      level: 33,
      ancientCoins: 42
    });
    const cloudWins = planConservativePublicMerge({
      base: f.base,
      local: f.local,
      cloud: f.cloud,
      resolution: { ...choices, cloudRecords: [{ section: 'characters', id }] }
    });
    expect(cloudWins.status).toBe('prepared');
    expect(cloudWins.snapshot().sections.characters.records[0].fields).toMatchObject({
      notes: 'ОБЛАЧНАЯ',
      level: 33,
      ancientCoins: 42
    });
    expect(cloudWins.selectedRecords()).toEqual([{ section: 'characters', id }]);
  });

  it('конфликты финансовых настроек разрешает отдельно, некорректный выбор отклоняет', () => {
    const f = fixture();
    f.local.sections.finance.settings.goldRate = 2;
    f.cloud.sections.finance.settings.goldRate = 3;
    const choices = { reviewHash: 'b'.repeat(64), cloudRecords: [], cloudSettings: [], cloudFinanceSettings: true };
    expect(merge(f).status).toBe('conflicts');
    const plan = planConservativePublicMerge({ base: f.base, local: f.local, cloud: f.cloud, resolution: choices });
    expect(plan.status).toBe('prepared');
    expect(plan.snapshot().sections.finance.settings.goldRate).toBe(3);
    expect(plan.includeFinanceSettings).toBe(true);
    expect(() =>
      planConservativePublicMerge({
        base: f.base,
        local: f.local,
        cloud: f.cloud,
        resolution: { ...choices, reviewHash: 'bad' }
      })
    ).toThrow();
    expect(() =>
      planConservativePublicMerge({
        base: f.base,
        local: f.local,
        cloud: f.cloud,
        resolution: { ...choices, cloudSettings: ['unknown'] }
      })
    ).toThrow();
  });

  it('не принимает решение по updatedAt при разных изменениях обеих сторон', () => {
    const f = fixture();
    f.local.sections.characters.records[0].fields.updatedAt = '2026-10-29T08:00:00.000Z';
    f.cloud.sections.characters.records[0].fields.updatedAt = '2026-10-30T08:00:00.000Z';
    expect(merge(f)).toMatchObject({ status: 'conflicts', conflicts: [{ path: ['fields', 'updatedAt'] }] });
  });

  it('оставляет совпадающие изменения и локальные изменения других разделов', () => {
    const f = fixture();
    f.local.sections.characters.records[0].fields.level = 15;
    f.cloud.sections.characters.records[0].fields.level = 15;
    f.local.sections.planner.records[0].fields.title = 'МЕСТНАЯ ЗАДАЧА';
    const result = merge(f);
    expect(result.status).toBe('prepared');
    expect(result.selectedRecords()).toEqual([]);
    expect(result.snapshot().sections.planner.records[0].fields.title).toBe('МЕСТНАЯ ЗАДАЧА');
  });

  it('объединяет выбранные настройки и финансовые параметры только без конфликтов', () => {
    const f = fixture();
    f.local.sections.finance.settings.opening.coins = 13;
    f.cloud.sections.finance.settings.commissionPct = 3;
    f.cloud.sections.preferences.values.appearance.theme = 'light';
    const result = merge(f);
    expect(result.status).toBe('prepared');
    expect(result.includeFinanceSettings).toBe(true);
    expect(result.selectedSettings()).toEqual(['appearance']);
    expect(result.snapshot().sections.finance.settings).toMatchObject({ opening: { coins: 13 }, commissionPct: 3 });
  });

  it('не выводит удаление из отсутствия ID, поля или элемента массива', () => {
    for (const mutate of [
      value => {
        value.sections.characters.records = [];
        value.sections.characters.order.active = [];
      },
      value => delete value.sections.characters.records[0].fields.partyOrder.extra,
      value => (value.sections.characters.records[0].fields.tags = [])
    ]) {
      const f = fixture();
      if (mutate.toString().includes('partyOrder')) {
        // Динамический словарь тоже не должен терять ранее существующее поле.
        f.base.sections.characters.records[0].fields.partyOrder.extra = 1;
        f.local = structuredClone(f.base);
        f.cloud = structuredClone(f.base);
      }
      mutate(f.cloud);
      expect(merge(f).status).toBe('structure_or_deletion_unsupported');
    }
  });

  it('не принимает изменение вложенных данных шаблона и не считает порядок неважным', () => {
    const f = fixture();
    f.localState.marathonTemplates[0].tasks = [{ id: 'local', title: 'Исходное' }];
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.local = structuredClone(f.base);
    f.cloud = structuredClone(f.base);
    f.cloud.sections.marathons.records.find(record => record.type === 'marathonTemplate').fields.tasks[0].title =
      'Изменённое';
    expect(merge(f).status).toBe('structure_or_deletion_unsupported');
    const g = fixture();
    const id = g.cloud.sections.characters.order.active[0];
    g.cloud.sections.characters.records[0].archived = true;
    g.cloud.sections.characters.order.active = [];
    g.cloud.sections.characters.order.archived = [id];
    expect(merge(g).status).toBe('structure_or_deletion_unsupported');
  });

  it('объединяет добавленных в конце персонажа, пати и задачу с независимой местной правкой', () => {
    const f = fixture();
    f.localState.characters[0].notes = 'МЕСТНАЯ ЗАМЕТКА';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    const raw = structuredClone(f.localState);
    raw.characters[0].notes = 'Основная заметка';
    raw.parties.push({ id: 'party-new', name: 'Новая пати', order: 1 });
    raw.characters.push({
      id: 'hero-new',
      nick: 'Новый',
      partyIds: ['party-new'],
      mainPartyId: 'party-new',
      contacts: { password: 'НЕ ПЕРЕНОСИТЬ' }
    });
    raw.plannerEntries.push({ id: 'task-new', title: 'Новая задача', date: '2026-11-01' });
    const { ui, ...normalized } = normalizeState(raw);
    const remote = planSyncIdentities({ snapshot: normalized, cryptoSource: webcrypto }).snapshot;
    f.cloud = buildPublicSnapshot(remote, { settingsSelections: ['appearance'] });
    expect(conservativeTransition(f.base, f.cloud)).toBe(true);
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    expect(plan.selectedCount).toBe(3);
    const applied = preparePublicSnapshotApply({
      localState: f.localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    }).candidateState();
    expect(applied.characters[0].notes).toBe('МЕСТНАЯ ЗАМЕТКА');
    expect(applied.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
    const added = applied.characters.find(row => row.nick === 'Новый');
    const party = applied.parties.find(row => row.name === 'Новая пати');
    expect(added.partyIds).toEqual([party.id]);
    expect(added.mainPartyId).toBe(party.id);
    expect(added.contacts.password).not.toBe('НЕ ПЕРЕНОСИТЬ');
    expect(applied.plannerEntries.at(-1).title).toBe('Новая задача');
    expect(buildPublicSnapshot(applied, { settingsSelections: ['appearance'] })).toEqual(plan.snapshot());
  });

  it('сохраняет новую локальную запись, когда облако изменяет существующую', () => {
    const f = fixture();
    const id = generateSyncId(webcrypto);
    const added = structuredClone(f.local.sections.characters.records[0]);
    added.id = id;
    added.fields.nick = 'Только локально';
    f.local.sections.characters.records.push(added);
    f.local.sections.characters.order.active.push(id);
    f.cloud.sections.characters.records[0].fields.level = 24;
    const result = merge(f);
    expect(result.status).toBe('prepared');
    expect(result.snapshot().sections.characters.order.active).toEqual(f.local.sections.characters.order.active);
    expect(result.snapshot().sections.characters.records.find(row => row.id === id).fields.nick).toBe(
      'Только локально'
    );
    expect(result.snapshot().sections.characters.records[0].fields.level).toBe(24);
  });

  it('сохраняет оба независимых добавления в конец и их относительный порядок', () => {
    const f = fixture();
    const ids = [];
    for (const snapshot of [f.local, f.cloud]) {
      const added = structuredClone(snapshot.sections.characters.records[0]);
      added.id = generateSyncId(webcrypto);
      ids.push(added.id);
      snapshot.sections.characters.records.push(added);
      snapshot.sections.characters.order.active.push(added.id);
    }
    const result = merge(f);
    expect(result.status).toBe('prepared');
    expect(result.snapshot().sections.characters.order.active).toEqual([
      ...f.base.sections.characters.order.active,
      ...ids
    ]);
    expect(result.selectedRecords()).toEqual([{ section: 'characters', id: ids[1] }]);
  });

  it('не угадывает противоречивый порядок общих добавлений и не принимает вставку в середину', () => {
    const f = fixture();
    const added = [0, 1].map(() => {
      const record = structuredClone(f.base.sections.characters.records[0]);
      record.id = generateSyncId(webcrypto);
      return record;
    });
    for (const snapshot of [f.local, f.cloud]) {
      snapshot.sections.characters.records.push(...structuredClone(added));
    }
    f.local.sections.characters.order.active.push(...added.map(record => record.id));
    f.cloud.sections.characters.order.active.push(...added.map(record => record.id).reverse());
    const result = merge(f);
    expect(result.status).toBe('conflicts');
    expect(result.conflicts.some(item => item.reason === 'concurrent-order')).toBe(true);
    const g = fixture();
    const newId = generateSyncId(webcrypto);
    const inserted = structuredClone(g.cloud.sections.characters.records[0]);
    inserted.id = newId;
    g.cloud.sections.characters.records.unshift(inserted);
    g.cloud.sections.characters.order.active.unshift(newId);
    expect(merge(g).status).toBe('structure_or_deletion_unsupported');
  });

  it('совпадающее добавление с тем же ID допустимо, разное содержимое — конфликт', () => {
    const f = fixture();
    const added = structuredClone(f.local.sections.characters.records[0]);
    added.id = generateSyncId(webcrypto);
    for (const snapshot of [f.local, f.cloud]) {
      snapshot.sections.characters.records.push(structuredClone(added));
      snapshot.sections.characters.order.active.push(added.id);
    }
    expect(merge(f).status).toBe('prepared');
    f.cloud.sections.characters.records.at(-1).fields.notes = 'ДРУГАЯ ВЕРСИЯ';
    const conflicted = merge(f);
    expect(conflicted.status).toBe('conflicts');
    expect(conflicted.conflicts.some(item => item.reason === 'concurrent-create')).toBe(true);
  });

  it('отклоняет опасные ключи и повторный выбор конфликтующей записи', () => {
    const id = generateSyncId(webcrypto);
    const polluted = JSON.parse(
      `{"reviewHash":"${'a'.repeat(64)}","cloudRecords":[{"section":"characters","id":"${id}","__proto__":{"polluted":true}}],"cloudSettings":[],"cloudFinanceSettings":false}`
    );
    expect(() => parseConservativeMergeChoices(polluted)).toThrow();
    expect({}.polluted).toBeUndefined();
    const repeated = {
      reviewHash: 'a'.repeat(64),
      cloudRecords: [
        { section: 'characters', id },
        { section: 'characters', id }
      ],
      cloudSettings: [],
      cloudFinanceSettings: false
    };
    expect(() => parseConservativeMergeChoices(repeated)).toThrow();
  });

  it('добавляет новый облачный шаблон и марафон с корректной локальной ссылкой', () => {
    const f = fixture();
    const remoteState = structuredClone(f.localState);
    remoteState.marathonTemplates.push({
      id: 'remote-template',
      name: 'Новый шаблон',
      tasks: [
        { id: 'remote-task', title: 'Задание', rewards: [{ id: 'remote-reward', rewardText: 'Награда', threshold: 1 }] }
      ],
      bonuses: [{ id: 'remote-bonus', needTasks: 1, text: 'Бонус' }]
    });
    remoteState.marathons.push(
      createMarathon({
        id: 'remote-marathon',
        title: 'Новый марафон',
        source: { type: 'template', templateId: 'remote-template' },
        startDate: '2026-10-01',
        endDate: '2026-10-31'
      })
    );
    const planned = planSyncIdentities({ snapshot: remoteState, cryptoSource: webcrypto }).snapshot;
    f.cloud = buildPublicSnapshot(planned, { settingsSelections: ['appearance'] });
    f.localState.characters[0].notes = 'МЕСТНАЯ ЗАМЕТКА';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const applied = preparePublicSnapshotApply({
      localState: f.localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    }).candidateState();
    const template = applied.marathonTemplates.find(item => item.name === 'Новый шаблон');
    const marathon = applied.marathons.find(item => item.title === 'Новый марафон');
    expect(template.tasks[0].rewards[0].rewardText).toBe('Награда');
    expect(template.bonuses[0].text).toBe('Бонус');
    expect(template.tasks[0].id).not.toBe('remote-task');
    expect(marathon.source.templateId).toBe(template.id);
    expect(applied.characters[0].notes).toBe('МЕСТНАЯ ЗАМЕТКА');
  });

  it('добавляет задания и бонусы в конец шаблона, не меняя прежние местные ID', () => {
    const f = fixture();
    f.localState.marathonTemplates[0].tasks = [
      {
        id: 'local-task',
        title: 'Исходное',
        rewards: [{ id: 'local-reward', threshold: 1, rewardText: 'Старая награда' }]
      }
    ];
    f.localState.marathonTemplates[0].bonuses = [{ id: 'local-bonus', needTasks: 1, text: 'Старый бонус' }];
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.local = structuredClone(f.base);
    f.cloud = structuredClone(f.base);
    const template = f.cloud.sections.marathons.records[0];
    const added = structuredClone(template.fields.tasks[0]);
    added.title = 'Новое задание';
    template.fields.tasks.push(added);
    template.fields.bonuses.push({ needTasks: 2, text: 'Новый бонус' });
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const applied = preparePublicSnapshotApply({
      localState: f.localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    }).candidateState();
    const result = applied.marathonTemplates[0];
    expect(result.tasks[0].id).toBe('local-task');
    expect(result.tasks[0].rewards[0].id).toBe('local-reward');
    expect(result.bonuses[0].id).toBe('local-bonus');
    expect(result.tasks[1].title).toBe('Новое задание');
    expect(result.tasks[1].id).not.toBe('local-task');
    expect(result.bonuses[1].text).toBe('Новый бонус');
    expect(result.bonuses[1].id).not.toBe('local-bonus');
  });

  it('не теряет местное добавление шаблона при конфликтующем облачном добавлении', () => {
    const f = fixture();
    const local = f.local.sections.marathons.records[0];
    const remote = f.cloud.sections.marathons.records[0];
    const task = title => ({
      title,
      siteTitle: null,
      description: '',
      descriptionSource: '',
      targetChecks: 1,
      schedule: { mode: 'everyDay', dates: [], weekStartDay: 1 },
      rewards: []
    });
    local.fields.tasks.push(task('Местное'));
    remote.fields.tasks.push(task('Облачное'));
    expect(merge(f).status).toBe('conflicts');
    const resolution = {
      reviewHash: 'a'.repeat(64),
      cloudRecords: [{ section: 'marathons', id: local.id }],
      cloudSettings: [],
      cloudFinanceSettings: false
    };
    expect(planConservativePublicMerge({ base: f.base, local: f.local, cloud: f.cloud, resolution }).status).toBe(
      'incoming_section_unsupported'
    );
  });

  it('обновляет название шаблона без замены локальных ID его заданий и наград', () => {
    const f = fixture();
    f.localState.marathonTemplates[0].tasks = [
      { id: 'local-task', title: 'Задание', rewards: [{ id: 'local-reward', threshold: 1, rewardText: 'Награда' }] }
    ];
    f.localState.marathonTemplates[0].bonuses = [{ id: 'local-bonus', needTasks: 1, text: 'Бонус' }];
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.local = structuredClone(f.base);
    f.cloud = structuredClone(f.base);
    f.cloud.sections.marathons.records[0].fields.name = 'Изменённый шаблон';
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const applied = preparePublicSnapshotApply({
      localState: f.localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    }).candidateState();
    expect(applied.marathonTemplates[0]).toMatchObject({
      name: 'Изменённый шаблон',
      tasks: [{ id: 'local-task', rewards: [{ id: 'local-reward' }] }],
      bonuses: [{ id: 'local-bonus' }]
    });
  });

  it('запрещает изменение состава в промежуточной версии, даже если затем он восстановлен', () => {
    const f = fixture();
    const removed = structuredClone(f.base);
    removed.sections.characters.records = [];
    removed.sections.characters.order.active = [];
    expect(conservativeTransition(f.base, removed)).toBe(false);
    expect(conservativeTransition(removed, f.base)).toBe(true); // добавление не исправляет предыдущее исчезновение
  });
});
