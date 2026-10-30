import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { conservativeTransition, planConservativePublicMerge } from '../js/modules/cloudSync/conservativeMerge.js';
import { preparePublicSnapshotApply } from '../js/modules/cloudSync/applyPublicSnapshot.js';
import { comparePublicSnapshots } from '../js/modules/cloudSync/compareSnapshots.js';
import { generateSyncId } from '../js/modules/cloudSync/envelope.js';
import { setMembership, setMainParty } from '../js/modules/parties/membership.js';

// The same pure membership helpers and sequence used by archive/archive.js.
function move(state, restoring = false, id = 'p') {
  const all = [...state.characters, ...state.archivedCharacters];
  if (!restoring) {
    const party = state.parties.find(row => row.id === id),
      memberLinks = [];
    for (const char of all)
      if (char.partyIds.includes(id)) {
        memberLinks.push({
          characterId: char.id,
          isMain: char.mainPartyId === id,
          order: Number.isFinite(Number(char.partyOrder[id])) ? Number(char.partyOrder[id]) : null
        });
        setMembership(char, id, false);
        delete char.partyOrder[id];
      }
    state.parties = state.parties.filter(row => row.id !== id);
    state.archivedParties.push({ ...party, memberLinks });
  } else {
    const party = state.archivedParties.find(row => row.id === id);
    for (const link of party.memberLinks) {
      const char = all.find(row => row.id === link.characterId);
      setMembership(char, id, true);
      if (link.isMain) setMainParty(char, id);
      if (link.order !== null) char.partyOrder[id] = link.order;
    }
    const { memberLinks, ...active } = party;
    state.archivedParties = state.archivedParties.filter(row => row.id !== id);
    state.parties.push(active);
  }
  state.parties.sort((a, b) => a.order - b.order);
  state.archivedParties.sort((a, b) => a.order - b.order);
  return state;
}
function fixture(restoring = false) {
  const { ui, ...raw } = normalizeState({
    schemaVersion: 10,
    parties: [
      { id: 'p', name: 'Пати', order: 1 },
      { id: 'q', name: 'Дополнительная', order: 2 }
    ],
    archivedParties: [{ id: 'r', name: 'Старый архив', order: 3, memberLinks: [] }],
    characters: [
      {
        id: 'a',
        nick: 'А',
        partyIds: ['p', 'q'],
        mainPartyId: 'p',
        partyOrder: { p: 7, q: 11 },
        contacts: { password: 'LOCAL_SECRET' },
        launch: { gcPath: '/local/path' }
      },
      { id: 'c', nick: 'В', partyIds: ['q'], mainPartyId: 'q' }
    ],
    archivedCharacters: [
      {
        id: 'b',
        nick: 'Б',
        partyIds: ['p'],
        mainPartyId: 'p',
        partyOrder: { p: 9 },
        contacts: { password: 'ARCHIVED_SECRET' }
      }
    ]
  });
  const state = planSyncIdentities({ snapshot: raw, cryptoSource: webcrypto }).snapshot;
  if (restoring) move(state);
  return { state, base: buildPublicSnapshot(state) };
}
const publicOf = state => buildPublicSnapshot(state);
const merge = (f, local, cloud, extra = {}) =>
  planConservativePublicMerge({ base: f.base, local: publicOf(local), cloud: publicOf(cloud), ...extra });
function materialize(local, plan) {
  return preparePublicSnapshotApply({
    localState: local,
    cloudSnapshot: plan.snapshot(),
    selectedRecords: plan.selectedRecords(),
    selectedSettings: plan.selectedSettings(),
    includeFinanceSettings: plan.includeFinanceSettings,
    cryptoSource: webcrypto
  }).candidateState();
}
const resolution = (id, cloud) => ({
  reviewHash: 'a'.repeat(64),
  cloudRecords: cloud ? [{ section: 'parties', id }] : [],
  cloudSettings: [],
  cloudFinanceSettings: false
});
describe('архив пати — связанное перемещение состава, не удаление', () => {
  for (const restoring of [false, true])
    for (const side of ['local', 'cloud'])
      for (const normalized of [false, true]) {
        it(`${restoring ? 'восстановление' : 'архивирование'} на ${side}, нормализация=${normalized}`, () => {
          const f = fixture(restoring);
          let local = structuredClone(f.state),
            cloud = structuredClone(f.state);
          move(side === 'local' ? local : cloud, restoring);
          local.characters[0].notes = 'НЕЗАВИСИМАЯ ЗАМЕТКА';
          cloud.characters[0].level = 42;
          [...cloud.parties, ...cloud.archivedParties].find(row => row.id === 'p').name = 'Новое имя';
          if (normalized) {
            const { ui: localUi, ...normalizedLocal } = normalizeState(local);
            local = normalizedLocal;
            const { ui: cloudUi, ...normalizedCloud } = normalizeState(cloud);
            cloud = normalizedCloud;
          }
          expect(conservativeTransition(f.base, publicOf(local))).toBe(true);
          expect(conservativeTransition(f.base, publicOf(cloud))).toBe(true);
          const plan = merge(f, local, cloud);
          expect(plan.status).toBe('prepared');
          const result = materialize(local, plan);
          expect((restoring ? result.parties : result.archivedParties).find(row => row.id === 'p').name).toBe(
            'Новое имя'
          );
          expect(result.characters[0]).toMatchObject({
            level: 42,
            notes: 'НЕЗАВИСИМАЯ ЗАМЕТКА',
            contacts: { password: 'LOCAL_SECRET' },
            launch: { gcPath: '/local/path' },
            mainPartyId: restoring ? 'p' : 'q',
            partyOrder: restoring ? { p: 7, q: 11 } : { q: 11 }
          });
          expect(result.archivedCharacters[0]).toMatchObject({
            mainPartyId: restoring ? 'p' : null,
            partyIds: restoring ? ['p'] : [],
            contacts: { password: 'ARCHIVED_SECRET' }
          });
          expect(comparePublicSnapshots({ local: publicOf(result), cloud: plan.snapshot() }).entries).toEqual([]);
          expect(JSON.stringify(plan.snapshot())).not.toContain('LOCAL_SECRET');
        });
      }
  it.each(['main', 'order', 'newMember'])('спрашивает выбор всей группы при правке %s на другом ПК', field => {
    const f = fixture(),
      local = move(structuredClone(f.state)),
      cloud = structuredClone(f.state);
    if (field === 'main') cloud.characters[0].mainPartyId = 'q';
    if (field === 'order') cloud.characters[0].partyOrder.p = 99;
    if (field === 'newMember') setMembership(cloud.characters[1], 'p', true);
    local.characters[0].notes = 'МЕСТНОЕ';
    cloud.characters[0].level = 42;
    const found = merge(f, local, cloud);
    expect(found).toMatchObject({
      status: 'conflicts',
      conflicts: [{ section: 'parties', id: f.state.parties[0].syncId, reason: 'party-archive-membership' }]
    });
    for (const useCloud of [false, true]) {
      const plan = merge(f, local, cloud, { resolution: resolution(f.state.parties[0].syncId, useCloud) });
      expect(plan.status).toBe('prepared');
      const result = materialize(local, plan);
      expect(result.characters[0]).toMatchObject({ notes: 'МЕСТНОЕ', level: 42 });
      expect(result.archivedParties.some(row => row.id === 'p')).toBe(!useCloud);
      expect(result.characters[0].partyIds).toEqual((useCloud ? cloud : local).characters[0].partyIds);
      expect(result.characters[0].mainPartyId).toEqual((useCloud ? cloud : local).characters[0].mainPartyId);
      expect(result.characters[0].partyOrder).toEqual((useCloud ? cloud : local).characters[0].partyOrder);
    }
  });
  it('согласует восстановление против правки архивного порядка только после выбора группы', () => {
    const f = fixture(true),
      local = move(structuredClone(f.state), true),
      cloud = structuredClone(f.state);
    cloud.archivedParties.find(row => row.id === 'p').memberLinks[0].order = 88;
    expect(merge(f, local, cloud).status).toBe('conflicts');
    const plan = merge(f, local, cloud, {
      resolution: resolution(f.state.archivedParties.find(row => row.id === 'p').syncId, true)
    });
    expect(plan.status).toBe('prepared');
    expect(materialize(local, plan).archivedParties.find(row => row.id === 'p').memberLinks[0].order).toBe(88);
  });
  it.each(['missingLink', 'wrongMain', 'lostOrder', 'unrelatedRemoval', 'stillAttached'])(
    'не пропускает неполное архивирование: %s',
    kind => {
      const f = fixture(),
        next = move(structuredClone(f.state)),
        party = next.archivedParties.find(row => row.id === 'p');
      if (kind === 'missingLink') party.memberLinks.pop();
      if (kind === 'wrongMain') party.memberLinks[0].isMain = false;
      if (kind === 'lostOrder') party.memberLinks[0].order = null;
      if (kind === 'unrelatedRemoval') delete next.characters[0].partyOrder.q;
      if (kind === 'stillAttached') setMembership(next.characters[0], 'p', true);
      expect(conservativeTransition(f.base, publicOf(next))).toBe(false);
    }
  );
  it('не теряет перекрывающийся состав при архивировании разных пати на двух ПК', () => {
    const f = fixture(),
      local = move(structuredClone(f.state)),
      cloud = move(structuredClone(f.state), false, 'q');
    expect(merge(f, local, cloud).status).toBe('structure_or_deletion_unsupported');
  });
  it('объединяет независимые переносы пустых пати без подмены ID', () => {
    const f = fixture();
    f.state.parties.push({
      id: 'empty',
      syncId: generateSyncId(webcrypto),
      name: 'Пустая',
      order: 4,
      color: null,
      createdAt: null,
      updatedAt: null
    });
    const { ui, ...state } = normalizeState(f.state);
    f.state = state;
    f.base = publicOf(state);
    const local = move(structuredClone(state)),
      cloud = move(structuredClone(state), false, 'empty');
    const plan = merge(f, local, cloud);
    expect(plan.status).toBe('prepared');
    expect(materialize(local, plan).archivedParties.map(row => row.id)).toEqual(['p', 'r', 'empty']);
  });
  it('не разрешает удаление пати или перестановку её прежних участников под видом архива', () => {
    const f = fixture(),
      removed = structuredClone(f.state);
    removed.parties.shift();
    expect(() => merge(f, f.state, removed)).toThrow();
    const deleted = structuredClone(f.base),
      id = f.state.parties[0].syncId;
    deleted.sections.parties.records = deleted.sections.parties.records.filter(row => row.id !== id);
    deleted.sections.parties.order.active = deleted.sections.parties.order.active.filter(value => value !== id);
    for (const char of deleted.sections.characters.records) {
      char.fields.partyIds = char.fields.partyIds.filter(value => value !== id);
      delete char.fields.partyOrder[id];
      if (char.fields.mainPartyId === id) char.fields.mainPartyId = char.fields.partyIds[0] || null;
    }
    expect(planConservativePublicMerge({ base: f.base, local: f.base, cloud: deleted }).status).toBe(
      'structure_or_deletion_unsupported'
    );
    const next = move(structuredClone(f.state));
    next.archivedParties.find(row => row.id === 'p').memberLinks.reverse();
    expect(conservativeTransition(f.base, publicOf(next))).toBe(false);
  });
});

describe('границы группового переноса пати', () => {
  it('объединяет непересекающиеся составы разных пати', () => {
    const f = fixture();
    f.state.characters[0].partyIds = ['p'];
    f.state.characters[0].partyOrder = { p: 7 };
    f.base = publicOf(f.state);
    const local = move(structuredClone(f.state)),
      cloud = move(structuredClone(f.state), false, 'q');
    const plan = merge(f, local, cloud);
    expect(plan.status).toBe('prepared');
    const result = materialize(local, plan);
    expect(result.parties).toEqual([]);
    expect(result.characters.every(row => !row.partyIds.length && row.mainPartyId === null)).toBe(true);
  });
  it('согласует перенос персонажа в архив после архива его пати', () => {
    const f = fixture(),
      local = move(structuredClone(f.state)),
      cloud = structuredClone(f.state);
    local.archivedCharacters.push(local.characters.shift());
    cloud.characters[0].level = 42;
    const plan = merge(f, local, cloud);
    expect(plan.status).toBe('prepared');
    const result = materialize(local, plan);
    expect(result.archivedCharacters.find(row => row.id === 'a')).toMatchObject({
      level: 42,
      mainPartyId: 'q',
      contacts: { password: 'LOCAL_SECRET' }
    });
  });
  it('не угадывает состав для нового персонажа, связанного с переносимой пати', () => {
    const f = fixture(),
      local = move(structuredClone(f.state)),
      cloud = structuredClone(f.state);
    cloud.characters.push({
      ...structuredClone(cloud.characters[0]),
      id: 'new',
      syncId: generateSyncId(webcrypto),
      nick: 'Новый'
    });
    expect(merge(f, local, cloud).status).toBe('structure_or_deletion_unsupported');
  });
});

it('не отменяет отдельное согласие на удаление задачи при переносе пати', () => {
  const f = fixture();
  const { ui, ...normalized } = normalizeState({
    ...f.state,
    plannerEntries: [{ id: 'task', title: 'Задача', date: '2026-10-30' }]
  });
  f.state = planSyncIdentities({ snapshot: normalized, cryptoSource: webcrypto }).snapshot;
  f.base = publicOf(f.state);
  const local = move(structuredClone(f.state)),
    cloud = structuredClone(f.state);
  cloud.plannerEntries = [];
  const id = f.state.plannerEntries[0].syncId;
  const options = { base: f.base, local: publicOf(local), cloud: publicOf(cloud), cloudPlannerTombstones: [id] };
  expect(planConservativePublicMerge(options)).toMatchObject({
    status: 'conflicts',
    conflicts: [{ id, reason: 'cloud-planner-deletion' }]
  });
  const plan = planConservativePublicMerge({
    ...options,
    resolution: {
      reviewHash: 'a'.repeat(64),
      cloudRecords: [{ section: 'planner', id }],
      cloudSettings: [],
      cloudFinanceSettings: false
    }
  });
  expect(plan.status).toBe('prepared');
  const result = preparePublicSnapshotApply({
    localState: local,
    cloudSnapshot: plan.snapshot(),
    selectedRecords: plan.selectedRecords(),
    selectedPlannerDeletions: plan.selectedPlannerDeletions(),
    cryptoSource: webcrypto
  }).candidateState();
  expect(result.plannerEntries).toEqual([]);
  expect(result.archivedParties.find(row => row.id === 'p').memberLinks).toHaveLength(2);
});
