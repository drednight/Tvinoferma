import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { planConservativePublicMerge } from '../js/modules/cloudSync/conservativeMerge.js';
import { parseConservativeMergeChoices } from '../js/modules/cloudSync/conservativeMergeChoices.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { preparePublicSnapshotApply } from '../js/modules/cloudSync/applyPublicSnapshot.js';
function fixture() {
  const { ui, ...raw } = normalizeState({
    schemaVersion: 10,
    characters: [{ id: 'hero', nick: 'Герой', contacts: { password: 'LOCAL_PASSWORD' } }],
    plannerEntries: [
      {
        id: 'one',
        title: 'Задача',
        date: '2026-10-30',
        recurrence: 'daily',
        recurrenceEnd: '2026-11-30',
        statusByDate: { '2026-10-30': 'done' }
      },
      { id: 'two', title: 'Вторая', date: '2026-10-30' }
    ]
  });
  const state = planSyncIdentities({ snapshot: raw, cryptoSource: webcrypto }).snapshot;
  const base = buildPublicSnapshot(state);
  state.plannerEntries[0].title = 'МЕСТНАЯ ПРАВКА';
  const local = buildPublicSnapshot(state),
    cloud = structuredClone(base);
  const ids = cloud.sections.planner.order;
  cloud.sections.planner.records = [];
  cloud.sections.planner.order = [];
  const newId = generateSyncId(webcrypto);
  const resolution = {
    reviewHash: 'a'.repeat(64),
    cloudRecords: [{ section: 'planner', id: ids[1] }],
    cloudSettings: [],
    cloudFinanceSettings: false,
    plannerCopies: [{ id: ids[0], newId }]
  };
  return { state, base, local, cloud, ids, newId, resolution };
}
function merge(f) {
  return planConservativePublicMerge({
    base: f.base,
    local: f.local,
    cloud: f.cloud,
    cloudPlannerTombstones: f.ids,
    resolution: f.resolution
  });
}
describe('явное сохранение местной задачи новой копией при облачном удалении', () => {
  it('удаляет старые ID и материализует одну новую задачу с точными местными полями', () => {
    const f = fixture(),
      plan = merge(f);
    expect(plan.status).toBe('prepared');
    const expected = { ...structuredClone(f.local.sections.planner.records[0]), id: f.newId };
    expect(plan.snapshot().sections.planner.records).toEqual([expected]);
    expect(plan.selectedPlannerDeletions().sort()).toEqual([...f.ids].sort());
    expect(plan.selectedRecords()).toEqual([{ section: 'planner', id: f.newId }]);
    expect(plan.selectedCount).toBe(3);
    const applied = preparePublicSnapshotApply({
      localState: f.state,
      cloudSnapshot: plan.snapshot(),
      selectedRecords: plan.selectedRecords(),
      selectedPlannerDeletions: plan.selectedPlannerDeletions(),
      cryptoSource: webcrypto
    });
    expect(applied.candidatePublicSnapshot()).toEqual(plan.snapshot());
    expect(applied.candidateState().plannerEntries).toEqual([
      expect.objectContaining({
        syncId: f.newId,
        title: 'МЕСТНАЯ ПРАВКА',
        recurrence: 'daily',
        statusByDate: { '2026-10-30': 'done' }
      })
    ]);
    expect(applied.candidateState().characters[0].contacts.password).toBe('LOCAL_PASSWORD');
    expect(f.state.plannerEntries).toHaveLength(2);
    expect(f.local.sections.planner.records[0].id).toBe(f.ids[0]);
    const copy = plan.snapshot();
    copy.sections.planner.records[0].fields.title = 'ПОДМЕНА';
    expect(plan.snapshot().sections.planner.records[0].fields.title).toBe('МЕСТНАЯ ПРАВКА');
  });
  it('не заменяет отсутствующее согласие копированием по умолчанию', () => {
    const f = fixture();
    delete f.resolution.plannerCopies;
    expect(merge(f).status).toBe('deletion_not_accepted');
  });
  it.each(['old', 'character', 'otherDeleted', 'cloudNew'])('отклоняет новый ID, занятый как %s', where => {
    const f = fixture();
    let id;
    if (where === 'old') id = f.ids[0];
    else if (where === 'character') id = f.base.sections.characters.records[0].id;
    else if (where === 'otherDeleted') id = f.ids[1];
    else {
      id = generateSyncId(webcrypto);
      const row = { ...structuredClone(f.base.sections.planner.records[0]), id };
      f.cloud.sections.planner.records.push(row);
      f.cloud.sections.planner.order.push(id);
    }
    f.resolution.plannerCopies[0].newId = id;
    expect(() => merge(f)).toThrow();
  });
  it('отклоняет отсутствующую метку и источник, который не удалён в облаке', () => {
    const f = fixture();
    expect(() =>
      planConservativePublicMerge({
        base: f.base,
        local: f.local,
        cloud: f.cloud,
        resolution: f.resolution,
        cloudPlannerTombstones: []
      })
    ).toThrow();
    f.cloud = structuredClone(f.base);
    expect(merge(f).status).toBe('structure_or_deletion_unsupported');
  });
  it('отклоняет неизвестный источник копии', () => {
    const f = fixture();
    f.resolution.plannerCopies[0].id = generateSyncId(webcrypto);
    expect(() => merge(f)).toThrow();
  });
  it('требует решение для каждого удаления, а не только для копируемой задачи', () => {
    const f = fixture();
    f.resolution.cloudRecords = [];
    expect(merge(f).status).toBe('deletion_not_accepted');
  });
  it('не копирует новое воскрешение ранее удалённой идентичности', () => {
    const f = fixture();
    f.base.sections.planner.records.shift();
    f.base.sections.planner.order.shift();
    expect(merge(f).status).toBe('deleted_identity_resurrection');
  });
  it.each(['empty', 'duplicateSource', 'duplicateTarget', 'deleteAndCopy', 'unknownField', 'badId', 'extraSecret'])(
    'отклоняет некорректный выбор %s',
    kind => {
      const f = fixture(),
        r = f.resolution;
      if (kind === 'empty') r.plannerCopies = [];
      if (kind === 'duplicateSource') r.plannerCopies.push({ ...r.plannerCopies[0], newId: generateSyncId(webcrypto) });
      if (kind === 'duplicateTarget') r.plannerCopies.push({ id: f.ids[1], newId: f.newId });
      if (kind === 'deleteAndCopy') r.cloudRecords.push({ section: 'planner', id: f.ids[0] });
      if (kind === 'unknownField') r.plannerCopies[0].unknown = true;
      if (kind === 'badId') r.plannerCopies[0].newId = 'bad';
      if (kind === 'extraSecret') r.plannerCopies[0].password = 'NEVER_SERIALIZE';
      expect(() => parseConservativeMergeChoices(r)).toThrow();
    }
  );
  it('возвращает независимые копии выбора', () => {
    const f = fixture(),
      parsed = parseConservativeMergeChoices(f.resolution);
    parsed.plannerCopies[0].newId = generateSyncId(webcrypto);
    expect(f.resolution.plannerCopies[0].newId).toBe(f.newId);
  });
});
