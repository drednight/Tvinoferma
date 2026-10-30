import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { preparePublicSnapshotApply } from '../js/modules/cloudSync/applyPublicSnapshot.js';
import { conservativeTransition, planConservativePublicMerge } from '../js/modules/cloudSync/conservativeMerge.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { parseConservativeMergeChoices } from '../js/modules/cloudSync/conservativeMergeChoices.js';
import { createMarathon, createTask } from '../js/modules/marathons/model.js';
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

  it('принимает штатное добавление сверху с обрезанием хвоста истории характеристик при лимите приложения', () => {
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
    expect(conservativeTransition(f.base, f.cloud)).toBe(true);
    expect(merge(f).status).toBe('prepared');
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

  it('не выводит удаление из отсутствия sync-ID или неизвестного поля', () => {
    for (const mutate of [
      value => {
        value.sections.characters.records = [];
        value.sections.characters.order.active = [];
      },
      value => delete value.sections.characters.records[0].fields.partyOrder.extra
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

  it('принимает изменение копируемых значений шаблона, но не перестановку sync-сущностей', () => {
    const f = fixture();
    f.localState.marathonTemplates[0].tasks = [{ id: 'local', title: 'Исходное' }];
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.local = structuredClone(f.base);
    f.cloud = structuredClone(f.base);
    f.cloud.sections.marathons.records.find(record => record.type === 'marathonTemplate').fields.tasks[0].title =
      'Изменённое';
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    expect(plan.snapshot().sections.marathons.records[0].fields.tasks[0].title).toBe('Изменённое');
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
    const plan = planConservativePublicMerge({ base: f.base, local: f.local, cloud: f.cloud, resolution });
    expect(plan.status).toBe('prepared');
    expect(plan.snapshot().sections.marathons.records[0].fields.tasks.map(task => task.title)).toEqual(['Облачное']);
    const kept = planConservativePublicMerge({
      base: f.base,
      local: f.local,
      cloud: f.cloud,
      resolution: { ...resolution, cloudRecords: [] }
    });
    expect(kept.status).toBe('prepared');
    expect(kept.snapshot().sections.marathons.records[0].fields.tasks.map(task => task.title)).toEqual(['Местное']);
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

describe('объединение подтверждённых v3-удалений ручного календаря', () => {
  const resolution = id => ({
    reviewHash: 'a'.repeat(64),
    cloudRecords: id ? [{ section: 'planner', id }] : [],
    cloudSettings: [],
    cloudFinanceSettings: false
  });
  it('требует явный выбор удаления даже неизменённой местной записи и сохраняет независимые поля', () => {
    const f = fixture();
    const id = f.base.sections.planner.records[0].id;
    f.cloud.sections.planner.records = [];
    f.cloud.sections.planner.order = [];
    f.local.sections.characters.records[0].fields.notes = 'МЕСТНАЯ ЗАМЕТКА';
    const options = { base: f.base, local: f.local, cloud: f.cloud, cloudPlannerTombstones: [id] };
    expect(planConservativePublicMerge(options)).toMatchObject({
      status: 'conflicts',
      conflicts: [{ reason: 'cloud-planner-deletion', id }]
    });
    expect(planConservativePublicMerge({ ...options, resolution: resolution(null) }).status).toBe(
      'deletion_not_accepted'
    );
    const plan = planConservativePublicMerge({ ...options, resolution: resolution(id) });
    expect(plan.status).toBe('prepared');
    expect(plan.snapshot().sections.planner.records).toEqual([]);
    expect(plan.snapshot().sections.characters.records[0].fields.notes).toBe('МЕСТНАЯ ЗАМЕТКА');
    expect(plan.selectedPlannerDeletions()).toEqual([id]);
    f.localState.characters[0].notes = 'МЕСТНАЯ ЗАМЕТКА';
    const prepared = preparePublicSnapshotApply({
      localState: f.localState,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedSettings: plan.selectedSettings(),
      selectedPlannerDeletions: plan.selectedPlannerDeletions(),
      includeFinanceSettings: plan.includeFinanceSettings,
      cryptoSource: webcrypto
    });
    expect(prepared.candidateState().plannerEntries).toEqual([]);
    expect(prepared.candidateState().characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
  });

  it('не превращает немаркированное отсутствие, удаление других сущностей и перестановку в разрешение', () => {
    const f = fixture();
    const id = f.base.sections.planner.records[0].id;
    f.cloud.sections.planner.records = [];
    f.cloud.sections.planner.order = [];
    expect(merge(f).status).toBe('structure_or_deletion_unsupported');
    f.cloud.sections.characters.records = [];
    f.cloud.sections.characters.order.active = [];
    expect(
      planConservativePublicMerge({ base: f.base, local: f.local, cloud: f.cloud, cloudPlannerTombstones: [id] }).status
    ).toBe('structure_or_deletion_unsupported');
  });

  it('не воскрешает ранее удалённый ID и не угадывает удаление кланового события', () => {
    const f = fixture();
    const id = f.base.sections.planner.records[0].id;
    f.cloud.sections.planner.records = [];
    f.cloud.sections.planner.order = [];
    f.base.sections.planner.records = [];
    f.base.sections.planner.order = [];
    expect(
      planConservativePublicMerge({ base: f.base, local: f.local, cloud: f.cloud, cloudPlannerTombstones: [id] }).status
    ).toBe('deleted_identity_resurrection');
    const g = fixture();
    const gid = g.base.sections.planner.records[0].id;
    for (const value of [g.base, g.local])
      value.sections.planner.records[0].fields.source = { kind: 'guild', eventId: 'event-1' };
    g.cloud.sections.planner.records = [];
    g.cloud.sections.planner.order = [];
    expect(
      planConservativePublicMerge({ base: g.base, local: g.local, cloud: g.cloud, cloudPlannerTombstones: [gid] })
        .status
    ).toBe('structure_or_deletion_unsupported');
  });
});

function valueTemplateFixture() {
  const f = fixture();
  f.localState.marathonTemplates[0].tasks = ['Первое', 'Второе', 'Третье'].map((title, i) => ({
    id: `local-task-${i}`,
    title,
    rewards: [{ id: `local-reward-${i}`, threshold: 1, rewardText: `Награда ${i}` }]
  }));
  f.localState.marathonTemplates[0].bonuses = [
    { id: 'local-bonus-0', needTasks: 1, text: 'Первый бонус' },
    { id: 'local-bonus-1', needTasks: 2, text: 'Второй бонус' }
  ];
  f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
  f.local = structuredClone(f.base);
  f.cloud = structuredClone(f.base);
  return f;
}
function applyPlan(f, plan) {
  return preparePublicSnapshotApply({
    localState: f.localState,
    cloudSnapshot: plan.snapshot(),
    selectedRecords: plan.selectedRecords(),
    selectedSettings: plan.selectedSettings(),
    includeFinanceSettings: plan.includeFinanceSettings,
    cryptoSource: webcrypto
  }).candidateState();
}
const valueResolution = (section, id, cloud) => ({
  reviewHash: 'a'.repeat(64),
  cloudRecords: cloud ? [{ section, id }] : [],
  cloudSettings: [],
  cloudFinanceSettings: false
});

describe('копируемые значения шаблона без общей идентичности вложенных элементов', () => {
  it.each([
    [
      'правка награды',
      f => {
        f.tasks[1].rewards[0].rewardText = 'Новая награда';
      },
      1
    ],
    [
      'удаление задания',
      f => {
        f.tasks.splice(1, 1);
      },
      1
    ],
    [
      'перестановка заданий',
      f => {
        f.tasks.reverse();
      },
      0
    ],
    [
      'очистка заданий',
      f => {
        f.tasks = [];
      },
      0
    ],
    [
      'дублирующиеся названия',
      f => {
        f.tasks[1].title = f.tasks[0].title;
      },
      1
    ]
  ])('%s: заменяет значения, сохраняя ID только точного прежнего префикса', (_label, change, prefix) => {
    const f = valueTemplateFixture();
    f.localState.characters[0].notes = 'Независимая местная заметка';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    const fields = f.cloud.sections.marathons.records[0].fields;
    change(fields);
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const applied = applyPlan(f, plan);
    const template = applied.marathonTemplates[0];
    expect(
      buildPublicSnapshot(applied, { settingsSelections: ['appearance'] }).sections.marathons.records[0].fields
    ).toEqual(fields);
    template.tasks.forEach((task, index) => {
      if (index < prefix) {
        expect(task.id).toBe(`local-task-${index}`);
        expect(task.rewards[0].id).toBe(`local-reward-${index}`);
      } else {
        expect(f.localState.marathonTemplates[0].tasks.map(row => row.id)).not.toContain(task.id);
        expect(f.localState.marathonTemplates[0].tasks.flatMap(row => row.rewards.map(r => r.id))).not.toContain(
          task.rewards[0].id
        );
      }
    });
    expect(template.bonuses).toEqual(f.localState.marathonTemplates[0].bonuses);
    expect(applied.characters[0].notes).toBe('Независимая местная заметка');
    expect(applied.characters[0].contacts.password).toBe('PRIVATE_PASSWORD');
  });

  it.each([true, false])('разные изменения в одном списке требуют целой стороны, облако=%s', useCloud => {
    const f = valueTemplateFixture();
    f.localState.marathonTemplates[0].tasks[0].title = 'Местное задание';
    f.localState.marathonTemplates[0].name = 'Местное название';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    const remote = f.cloud.sections.marathons.records[0];
    remote.fields.tasks[1].title = 'Облачное задание';
    remote.fields.bonuses[1].text = 'Облачный бонус';
    const unresolved = merge(f);
    expect(unresolved.status).toBe('conflicts');
    expect(unresolved.conflicts).toMatchObject([{ section: 'marathons', id: remote.id, path: ['fields', 'tasks'] }]);
    expect(JSON.stringify(unresolved)).not.toContain('Облачное задание');
    const plan = planConservativePublicMerge({
      ...{ base: f.base, local: f.local, cloud: f.cloud },
      resolution: valueResolution('marathons', remote.id, useCloud)
    });
    expect(plan.status).toBe('prepared');
    const applied = applyPlan(f, plan).marathonTemplates[0];
    expect(applied.name).toBe('Местное название');
    expect(applied.tasks.map(row => row.title)).toEqual(
      useCloud ? ['Первое', 'Облачное задание', 'Третье'] : ['Местное задание', 'Второе', 'Третье']
    );
    expect(applied.bonuses[1].text).toBe('Облачный бонус');
    expect(applied.bonuses[0].id).toBe('local-bonus-0');
    expect(applied.bonuses[1].id).not.toBe('local-bonus-1');
    if (!useCloud) expect(applied.tasks).toEqual(f.localState.marathonTemplates[0].tasks);
  });

  it('передаёт обрезание списка бонусов без смены ID оставшегося точного префикса', () => {
    const f = valueTemplateFixture();
    f.cloud.sections.marathons.records[0].fields.bonuses.pop();
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const applied = applyPlan(f, plan).marathonTemplates[0];
    expect(applied.bonuses).toEqual([f.localState.marathonTemplates[0].bonuses[0]]);
    expect(applied.tasks).toEqual(f.localState.marathonTemplates[0].tasks);
  });

  it('не изменяет уже созданный по шаблону марафон, его задания, связи и прогресс', () => {
    const f = valueTemplateFixture();
    const instance = createMarathon({
      id: 'instance',
      title: 'Созданный марафон',
      source: { type: 'template', templateId: 'template' },
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      participantIds: ['hero'],
      tasks: [createTask({ id: 'instance-task', title: 'Скопированное задание' })],
      assignments: { hero: ['instance-task'] },
      progress: { hero: { 'instance-task': { site: 1, marks: ['2026-10-02'], history: { '2026-10-02': 1 } } } }
    });
    f.localState.marathons.push(instance);
    f.localState = planSyncIdentities({ snapshot: f.localState, cryptoSource: webcrypto }).snapshot;
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.local = structuredClone(f.base);
    f.cloud = structuredClone(f.base);
    f.cloud.sections.marathons.records.find(row => row.type === 'marathonTemplate').fields.tasks = [];
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const applied = applyPlan(f, plan);
    expect(applied.marathonTemplates[0].tasks).toEqual([]);
    expect(applied.marathons).toEqual(f.localState.marathons);
  });

  it.each([
    f => {
      f.cloud.sections.marathons.records[0].fields.tasks[0].rewards[0].threshold = 0;
    },
    f => {
      f.cloud.sections.marathons.records[0].fields.tasks[0].schedule.dates = ['bad-date'];
    }
  ])('не материализует недопустимое вложенное значение из облака', change => {
    const f = valueTemplateFixture();
    change(f);
    const original = structuredClone(f.localState);
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    expect(() => applyPlan(f, plan)).toThrow();
    expect(f.localState).toEqual(original);
  });
});

describe('изменения значений без удаления sync-сущности', () => {
  it('согласует удаление тега с независимой местной заметкой', () => {
    const f = fixture();
    f.localState.characters[0].notes = 'Местная заметка';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.cloud.sections.characters.records[0].fields.tags = [];
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    expect(applyPlan(f, plan).characters[0]).toMatchObject({ tags: [], notes: 'Местная заметка' });
    expect(plan.selectedRecords()).toEqual([{ section: 'characters', id: f.cloud.sections.characters.records[0].id }]);
  });

  it.each([true, false])(
    'разрешает конфликт очистки тегов против добавления только явной стороной, облако=%s',
    useCloud => {
      const f = fixture();
      f.localState.characters[0].tags.push('Местный');
      f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
      f.cloud.sections.characters.records[0].fields.tags = [];
      const id = f.cloud.sections.characters.records[0].id;
      expect(merge(f).status).toBe('conflicts');
      const plan = planConservativePublicMerge({
        base: f.base,
        local: f.local,
        cloud: f.cloud,
        resolution: valueResolution('characters', id, useCloud)
      });
      expect(plan.status).toBe('prepared');
      expect(applyPlan(f, plan).characters[0].tags).toEqual(useCloud ? [] : ['старый', 'Местный']);
    }
  );

  it('согласует снятие отметки повтора отдельно от правки другой даты и названия', () => {
    const f = fixture();
    f.localState.plannerEntries[0].statusByDate = { '2026-10-29': 'done', '2026-10-30': 'done' };
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.localState.plannerEntries[0].statusByDate['2026-10-30'] = 'doing';
    f.localState.plannerEntries[0].title = 'Местное название';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.cloud = structuredClone(f.base);
    delete f.cloud.sections.planner.records[0].fields.statusByDate['2026-10-29'];
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    expect(applyPlan(f, plan).plannerEntries[0]).toMatchObject({
      title: 'Местное название',
      statusByDate: { '2026-10-30': 'doing' }
    });
    expect(Object.keys(applyPlan(f, plan).plannerEntries[0].statusByDate)).toEqual(['2026-10-30']);
  });

  it.each([true, false])('снятие отметки против местного изменения той же даты требует выбора, облако=%s', useCloud => {
    const f = fixture();
    f.localState.plannerEntries[0].statusByDate = { '2026-10-30': 'done' };
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.localState.plannerEntries[0].statusByDate['2026-10-30'] = 'doing';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.cloud = structuredClone(f.base);
    f.cloud.sections.planner.records[0].fields.statusByDate = {};
    expect(merge(f)).toMatchObject({
      status: 'conflicts',
      conflicts: [{ reason: 'delete-versus-edit', path: ['fields', 'statusByDate', '2026-10-30'] }]
    });
    const plan = planConservativePublicMerge({
      base: f.base,
      local: f.local,
      cloud: f.cloud,
      resolution: valueResolution('planner', f.cloud.sections.planner.records[0].id, useCloud)
    });
    expect(plan.status).toBe('prepared');
    expect(applyPlan(f, plan).plannerEntries[0].statusByDate).toEqual(useCloud ? {} : { '2026-10-30': 'doing' });
  });

  it('согласует порядок и показ разделов в отдельно выбранной группе навигации', () => {
    const f = fixture();
    const selections = ['appearance', 'navigation'];
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: selections });
    f.localState.characters[0].notes = 'Местная заметка';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: selections });
    f.cloud = structuredClone(f.base);
    const order = f.cloud.sections.preferences.values.navigation.order;
    order.splice(1, order.length - 2, ...order.slice(1, -1).reverse());
    f.cloud.sections.preferences.values.navigation.hidden = ['finance'];
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    expect(plan.selectedSettings()).toEqual(['navigation']);
    const applied = applyPlan(f, plan);
    expect(applied.settings.ui.sections).toEqual(f.cloud.sections.preferences.values.navigation);
    expect(applied.characters[0].notes).toBe('Местная заметка');
  });
});

describe('конфликты и проверка навигации без ослабления сущностей', () => {
  it.each([true, false])('одновременная перестановка разделов требует выбора, облако=%s', useCloud => {
    const f = fixture();
    const settingsSelections = ['navigation'];
    f.base = buildPublicSnapshot(f.localState, { settingsSelections });
    const localOrder = f.localState.settings.ui.sections.order;
    [localOrder[1], localOrder[2]] = [localOrder[2], localOrder[1]];
    f.local = buildPublicSnapshot(f.localState, { settingsSelections });
    f.cloud = structuredClone(f.base);
    const remoteOrder = f.cloud.sections.preferences.values.navigation.order;
    [remoteOrder[2], remoteOrder[3]] = [remoteOrder[3], remoteOrder[2]];
    f.cloud.sections.preferences.values.navigation.hidden = ['finance'];
    expect(merge(f)).toMatchObject({
      status: 'conflicts',
      conflicts: [{ section: 'preferences', id: 'navigation', path: ['order'] }]
    });
    const plan = planConservativePublicMerge({
      base: f.base,
      local: f.local,
      cloud: f.cloud,
      resolution: {
        ...valueResolution('preferences', 'navigation', false),
        cloudSettings: useCloud ? ['navigation'] : []
      }
    });
    expect(plan.status).toBe('prepared');
    const applied = applyPlan(f, plan);
    expect(applied.settings.ui.sections.order).toEqual(useCloud ? remoteOrder : localOrder);
    expect(applied.settings.ui.sections.hidden).toEqual(['finance']);
  });
  it('не разрешает спрятать обязательные настройки или сдвинуть закреплённые разделы', () => {
    for (const mutate of [nav => nav.order.reverse(), nav => nav.hidden.push('settings')]) {
      const f = fixture();
      f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['navigation'] });
      f.local = structuredClone(f.base);
      f.cloud = structuredClone(f.base);
      mutate(f.cloud.sections.preferences.values.navigation);
      const plan = merge(f);
      expect(plan.status).toBe('prepared');
      expect(() => applyPlan(f, plan)).toThrow();
    }
  });
  it('не выводит удаление sync-задания марафона из исчезновения массива', () => {
    const f = valueTemplateFixture();
    f.localState.marathons.push(
      createMarathon({
        id: 'instance',
        title: 'Марафон',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        tasks: [createTask({ id: 'existing-task', title: 'Не копируемое значение' })]
      })
    );
    f.localState = planSyncIdentities({ snapshot: f.localState, cryptoSource: webcrypto }).snapshot;
    f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.local = structuredClone(f.base);
    f.cloud = structuredClone(f.base);
    f.cloud.sections.marathons.records.find(row => row.type === 'marathon').fields.tasks = [];
    expect(merge(f).status).toBe('structure_or_deletion_unsupported');
    expect(conservativeTransition(f.base, f.cloud)).toBe(false);
  });
});

function cappedHistoryFixture() {
  const f = fixture();
  const char = f.localState.characters[0];
  for (let i = 1; i <= 11; i++) {
    const previous = structuredClone(char.stats);
    char.stats.strength = i;
    rememberStatsBefore(char, previous, `2026-10-${String(i).padStart(2, '0')}T00:00:00.000Z`);
  }
  f.base = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
  f.local = structuredClone(f.base);
  f.cloud = structuredClone(f.base);
  return f;
}
describe('штатный лимит истории характеристик без угадывания по датам', () => {
  it('материализует настоящий одиннадцатый сдвиг с местной заметкой без потери остальных полей', () => {
    const f = cappedHistoryFixture();
    const remote = structuredClone(f.localState);
    const char = remote.characters[0];
    const previous = structuredClone(char.stats);
    char.stats.strength = 12;
    rememberStatsBefore(char, previous, '2000-01-01T00:00:00.000Z'); // дата не выбирает победителя
    f.cloud = buildPublicSnapshot(remote, { settingsSelections: ['appearance'] });
    f.localState.characters[0].notes = 'Независимая заметка';
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    const plan = merge(f);
    expect(plan.status).toBe('prepared');
    const applied = applyPlan(f, plan).characters[0];
    expect(applied.statsHistory).toEqual(char.statsHistory);
    expect(applied.statsHistory).toHaveLength(10);
    expect(applied).toMatchObject({ stats: { strength: 12 }, notes: 'Независимая заметка' });
  });
  it.each(['clear', 'middle', 'edit', 'shorten', 'replace-all', 'ambiguous', 'reused-head'])(
    'не принимает произвольное изменение %s за штатное обрезание хвоста',
    kind => {
      const f = cappedHistoryFixture();
      const original = f.base.sections.characters.records[0].fields.statsHistory;
      let next = structuredClone(original);
      if (kind === 'clear') next = [];
      if (kind === 'middle') next.splice(4, 1);
      if (kind === 'edit') next[5].stats.strength = 900;
      if (kind === 'shorten') next.pop();
      if (kind === 'replace-all') next = next.map(row => ({ ...row, stats: { ...row.stats, strength: 900 } }));
      if (kind === 'ambiguous') {
        original[1] = structuredClone(original[0]);
        f.local = structuredClone(f.base);
        f.cloud = structuredClone(f.base);
        next = [
          { at: '2026-11-01', stats: { ...original[0].stats, strength: 200 } },
          ...structuredClone(original.slice(0, 9))
        ];
      }
      if (kind === 'reused-head') next = [structuredClone(original[9]), ...structuredClone(original.slice(0, 9))];
      f.cloud.sections.characters.records[0].fields.statsHistory = next;
      expect(conservativeTransition(f.base, f.cloud)).toBe(false);
      expect(merge(f).status).toBe('structure_or_deletion_unsupported');
    }
  );
  it.each([true, false])('разные штатные обрезания на двух ПК остаются конфликтом, облако=%s', useCloud => {
    const f = cappedHistoryFixture();
    const remote = structuredClone(f.localState);
    const local = f.localState.characters[0];
    const cloud = remote.characters[0];
    const before = structuredClone(local.stats);
    local.stats.strength = 12;
    cloud.stats.strength = 13;
    rememberStatsBefore(local, before, '2026-11-01T00:00:00.000Z');
    rememberStatsBefore(cloud, before, '2026-11-02T00:00:00.000Z');
    f.local = buildPublicSnapshot(f.localState, { settingsSelections: ['appearance'] });
    f.cloud = buildPublicSnapshot(remote, { settingsSelections: ['appearance'] });
    const preview = merge(f);
    expect(preview.status).toBe('conflicts');
    expect(preview.conflicts.some(row => row.path.at(-1) === 'statsHistory')).toBe(true);
    const plan = planConservativePublicMerge({
      base: f.base,
      local: f.local,
      cloud: f.cloud,
      resolution: valueResolution('characters', local.syncId, useCloud)
    });
    expect(plan.status).toBe('prepared');
    const applied = applyPlan(f, plan).characters[0];
    expect(applied.statsHistory).toEqual(useCloud ? cloud.statsHistory : local.statsHistory);
    expect(applied.stats.strength).toBe(useCloud ? 13 : 12);
  });
});
