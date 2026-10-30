import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { preparePublicSnapshotApply } from '../js/modules/cloudSync/applyPublicSnapshot.js';
import { conservativeTransition, planConservativePublicMerge } from '../js/modules/cloudSync/conservativeMerge.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';

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

  it('не применяет входящие записи неподдержанного раздела и не считает порядок неважным', () => {
    const f = fixture();
    f.cloud.sections.marathons.records.find(record => record.type === 'marathonTemplate').fields.name =
      'ОБЛАЧНЫЙ ШАБЛОН';
    expect(merge(f).status).toBe('incoming_section_unsupported');
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

  it('не угадывает порядок одновременных разных добавлений и не принимает вставку в середину', () => {
    const f = fixture();
    for (const snapshot of [f.local, f.cloud]) {
      const added = structuredClone(snapshot.sections.characters.records[0]);
      added.id = generateSyncId(webcrypto);
      snapshot.sections.characters.records.push(added);
      snapshot.sections.characters.order.active.push(added.id);
    }
    const result = merge(f);
    expect(result.status).toBe('conflicts');
    expect(result.conflicts.some(item => item.section === 'characters')).toBe(true);
    const g = fixture();
    const newId = generateSyncId(webcrypto);
    const added = structuredClone(g.cloud.sections.characters.records[0]);
    added.id = newId;
    g.cloud.sections.characters.records.unshift(added);
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

  it('новый облачный шаблон марафона не применяется автоматически', () => {
    const f = fixture();
    const added = structuredClone(f.cloud.sections.marathons.records[0]);
    added.id = generateSyncId(webcrypto);
    f.cloud.sections.marathons.records.push(added);
    f.cloud.sections.marathons.order.templates.push(added.id);
    expect(merge(f).status).toBe('incoming_section_unsupported');
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
