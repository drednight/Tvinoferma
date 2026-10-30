import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { conservativeTransition, planConservativePublicMerge } from '../js/modules/cloudSync/conservativeMerge.js';
import { preparePublicSnapshotApply } from '../js/modules/cloudSync/applyPublicSnapshot.js';
const chars = () =>
  ['a', 'b', 'c', 'd'].map(id => ({
    id,
    nick: id,
    contacts: { password: `LOCAL_SECRET_${id}` },
    launch: { gcPath: `/local/${id}` }
  }));
function fixture() {
  const all = chars();
  const { ui, ...raw } = normalizeState({
    schemaVersion: 10,
    characters: all.slice(0, 2),
    archivedCharacters: all.slice(2)
  });
  const state = planSyncIdentities({ snapshot: raw, cryptoSource: webcrypto }).snapshot;
  return { state, base: buildPublicSnapshot(state) };
}
function move(state, mask) {
  const result = structuredClone(state);
  const all = [...state.characters, ...state.archivedCharacters];
  const archived = id => !!(mask & (1 << ['a', 'b', 'c', 'd'].indexOf(id)));
  result.characters = [
    ...state.characters.filter(row => !archived(row.id)),
    ...state.archivedCharacters.filter(row => !archived(row.id))
  ];
  result.archivedCharacters = [
    ...state.archivedCharacters.filter(row => archived(row.id)),
    ...state.characters.filter(row => archived(row.id))
  ];
  expect(result.characters.length + result.archivedCharacters.length).toBe(all.length);
  return result;
}
function plan(base, local, cloud, extra = {}) {
  return planConservativePublicMerge({
    base,
    local: buildPublicSnapshot(local),
    cloud: buildPublicSnapshot(cloud),
    ...extra
  });
}
function apply(local, prepared) {
  return preparePublicSnapshotApply({
    localState: local,
    cloudSnapshot: prepared.snapshot(),
    selectedRecords: prepared.selectedRecords(),
    selectedSettings: prepared.selectedSettings(),
    includeFinanceSettings: prepared.includeFinanceSettings,
    cryptoSource: webcrypto
  });
}
describe('архив персонажей — перемещение, не удаление sync-сущности', () => {
  it.each(['local', 'cloud'])('сохраняет архивирование и независимую правку на стороне %s', side => {
    const f = fixture();
    let local = structuredClone(f.state),
      cloud = structuredClone(f.state);
    if (side === 'local') local = move(local, 13);
    else cloud = move(cloud, 13); // a moves to archive
    local.characters.concat(local.archivedCharacters).find(row => row.id === 'a').notes = 'МЕСТНАЯ ЗАМЕТКА';
    cloud.characters.concat(cloud.archivedCharacters).find(row => row.id === 'a').level = 42;
    const prepared = plan(f.base, local, cloud);
    expect(prepared.status).toBe('prepared');
    const candidate = apply(local, prepared).candidateState();
    expect(candidate.archivedCharacters.find(row => row.id === 'a')).toMatchObject({
      syncId: f.state.characters[0].syncId,
      notes: 'МЕСТНАЯ ЗАМЕТКА',
      level: 42,
      contacts: { password: 'LOCAL_SECRET_a' },
      launch: { gcPath: '/local/a' }
    });
    expect(candidate.characters.map(row => row.id)).toEqual(['b']);
    expect(JSON.stringify(prepared.snapshot())).not.toContain('LOCAL_SECRET');
  });
  it.each(['local', 'cloud'])('сохраняет восстановление и независимую правку на стороне %s', side => {
    const f = fixture();
    let local = structuredClone(f.state),
      cloud = structuredClone(f.state);
    if (side === 'local') local = move(local, 8);
    else cloud = move(cloud, 8); // c restored
    local.characters.concat(local.archivedCharacters).find(row => row.id === 'c').notes = 'МЕСТНАЯ ЗАМЕТКА';
    cloud.characters.concat(cloud.archivedCharacters).find(row => row.id === 'c').level = 42;
    const prepared = plan(f.base, local, cloud);
    expect(prepared.status).toBe('prepared');
    const candidate = apply(local, prepared).candidateState();
    expect(candidate.characters.map(row => row.id)).toEqual(['a', 'b', 'c']);
    expect(candidate.characters.find(row => row.id === 'c')).toMatchObject({
      notes: 'МЕСТНАЯ ЗАМЕТКА',
      level: 42,
      contacts: { password: 'LOCAL_SECRET_c' }
    });
  });
  it('явно разрешает конфликт поля без отмены независимого перемещения', () => {
    const f = fixture(),
      local = move(f.state, 13),
      cloud = structuredClone(f.state);
    local.archivedCharacters.find(row => row.id === 'a').notes = 'Местное';
    cloud.characters[0].notes = 'Облачное';
    const found = plan(f.base, local, cloud);
    expect(found.status).toBe('conflicts');
    expect(found.conflicts).toEqual([
      expect.objectContaining({ section: 'characters', id: f.state.characters[0].syncId, reason: 'field' })
    ]);
    const prepared = plan(f.base, local, cloud, {
      resolution: {
        reviewHash: 'a'.repeat(64),
        cloudRecords: [{ section: 'characters', id: f.state.characters[0].syncId }],
        cloudSettings: [],
        cloudFinanceSettings: false
      }
    });
    expect(prepared.status).toBe('prepared');
    expect(
      apply(local, prepared)
        .candidateState()
        .archivedCharacters.find(row => row.id === 'a').notes
    ).toBe('Облачное');
  });
  it('не разрешает реальное исчезновение записи или вставку перемещённой записи перед прежними', () => {
    const f = fixture(),
      cloud = move(f.state, 13);
    cloud.archivedCharacters.unshift(cloud.archivedCharacters.pop());
    expect(conservativeTransition(f.base, buildPublicSnapshot(cloud))).toBe(false);
    const removed = structuredClone(f.state);
    removed.characters.shift();
    expect(plan(f.base, f.state, removed).status).toBe('structure_or_deletion_unsupported');
  });
  it('не превращает перемещение в разрешение перестановки оставшихся персонажей', () => {
    const f = fixture(),
      cloud = move(f.state, 8);
    cloud.characters.reverse();
    expect(plan(f.base, f.state, cloud).status).toBe('structure_or_deletion_unsupported');
  });
  it.each(['local', 'cloud'])('согласует добавленного персонажа и перенос прежнего на стороне %s', side => {
    const f = fixture();
    let local = structuredClone(f.state),
      cloud = structuredClone(f.state);
    const newCharacter = {
      ...structuredClone(f.state.characters[0]),
      id: 'e',
      nick: 'Новый',
      syncId: generateSyncId(webcrypto)
    };
    if (side === 'local') {
      local = move(local, 13);
      cloud.characters.push(newCharacter);
    } else {
      cloud = move(cloud, 13);
      local.characters.push(newCharacter);
    }
    const prepared = plan(f.base, local, cloud);
    expect(prepared.status).toBe('prepared');
    const candidate = apply(local, prepared).candidateState();
    expect(candidate.characters.map(row => row.syncId)).toEqual([f.state.characters[1].syncId, newCharacter.syncId]);
    expect(candidate.archivedCharacters.map(row => row.id)).toEqual(['c', 'd', 'a']);
  });
  it('отдельно спрашивает при разном архивном состоянии одновременно созданного sync-ID', () => {
    const f = fixture(),
      local = structuredClone(f.state),
      cloud = structuredClone(f.state);
    const created = {
      ...structuredClone(f.state.characters[0]),
      id: 'e',
      nick: 'Новый',
      syncId: generateSyncId(webcrypto)
    };
    local.characters.push(created);
    cloud.archivedCharacters.push(structuredClone(created));
    expect(plan(f.base, local, cloud)).toMatchObject({
      status: 'conflicts',
      conflicts: [{ section: 'characters', id: created.syncId, reason: 'concurrent-create' }]
    });
    const prepared = plan(f.base, local, cloud, {
      resolution: {
        reviewHash: 'a'.repeat(64),
        cloudRecords: [{ section: 'characters', id: created.syncId }],
        cloudSettings: [],
        cloudFinanceSettings: false
      }
    });
    expect(prepared.status).toBe('prepared');
    expect(
      apply(local, prepared)
        .candidateState()
        .archivedCharacters.map(row => row.id)
    ).toEqual(['c', 'd', 'e']);
  });
  it('не подменяет архивированием отдельное согласие на удаление правившейся задачи', () => {
    const f = fixture();
    const { ui, ...raw } = normalizeState({
      ...f.state,
      plannerEntries: [{ id: 'task', title: 'Задача', date: '2026-10-30' }]
    });
    const state = planSyncIdentities({ snapshot: raw, cryptoSource: webcrypto }).snapshot;
    const base = buildPublicSnapshot(state),
      local = move(state, 13),
      cloud = structuredClone(state);
    local.plannerEntries[0].title = 'МЕСТНАЯ ПРАВКА ПРОТИВ УДАЛЕНИЯ';
    cloud.plannerEntries = [];
    const id = state.plannerEntries[0].syncId;
    const options = { cloudPlannerTombstones: [id] };
    expect(plan(base, local, cloud, options)).toMatchObject({
      status: 'conflicts',
      conflicts: [{ id, reason: 'cloud-planner-deletion' }]
    });
    expect(
      plan(base, local, cloud, {
        ...options,
        resolution: { reviewHash: 'a'.repeat(64), cloudRecords: [], cloudSettings: [], cloudFinanceSettings: false }
      }).status
    ).toBe('deletion_not_accepted');
    const prepared = plan(base, local, cloud, {
      ...options,
      resolution: {
        reviewHash: 'a'.repeat(64),
        cloudRecords: [{ section: 'planner', id }],
        cloudSettings: [],
        cloudFinanceSettings: false
      }
    });
    expect(prepared.status).toBe('prepared');
    expect(prepared.selectedPlannerDeletions()).toEqual([id]);
    const candidate = preparePublicSnapshotApply({
      localState: local,
      cloudSnapshot: prepared.snapshot(),
      selectedRecords: prepared.selectedRecords(),
      selectedPlannerDeletions: prepared.selectedPlannerDeletions(),
      cryptoSource: webcrypto
    }).candidateState();
    expect(candidate.plannerEntries).toEqual([]);
    expect(candidate.archivedCharacters.map(row => row.id)).toEqual(['c', 'd', 'a']);
  });
  // Every possible final membership on either PC, including opposite transfers,
  // common transfers, batch moves, and cases with incompatible appended order.
  it.each(Array.from({ length: 256 }, (_, n) => [n >> 4, n & 15]))(
    'не теряет ID или местные секреты для масок %i / %i',
    (left, right) => {
      const f = fixture(),
        local = move(f.state, left),
        cloud = move(f.state, right);
      const localSnapshot = buildPublicSnapshot(local),
        cloudSnapshot = buildPublicSnapshot(cloud);
      expect(conservativeTransition(f.base, localSnapshot)).toBe(true);
      expect(conservativeTransition(f.base, cloudSnapshot)).toBe(true);
      const prepared = plan(f.base, local, cloud);
      if (prepared.status === 'conflicts') {
        expect(prepared.conflicts.length).toBeGreaterThan(0);
        expect(prepared.conflicts.every(row => row.reason === 'concurrent-order')).toBe(true);
        return;
      }
      expect(prepared.status).toBe('prepared');
      const applied = apply(local, prepared);
      expect(applied.candidatePublicSnapshot()).toEqual(prepared.snapshot());
      const candidate = applied.candidateState();
      const all = [...candidate.characters, ...candidate.archivedCharacters];
      expect(all.map(row => row.syncId).sort()).toEqual(f.base.sections.characters.records.map(row => row.id).sort());
      for (let i = 0; i < 4; i++) {
        const bit = 1 << i,
          original = !!(12 & bit);
        const wanted = !!(left & bit) !== original ? !!(left & bit) : !!(right & bit);
        const char = all.find(row => row.id === ['a', 'b', 'c', 'd'][i]);
        expect(candidate.archivedCharacters.includes(char)).toBe(wanted);
        expect(char.contacts.password).toBe(`LOCAL_SECRET_${char.id}`);
      }
    }
  );
});
