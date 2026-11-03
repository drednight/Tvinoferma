import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION } from '../js/core/migrations.js';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { webcrypto as cryptoSource } from 'node:crypto';
import {
  CHARACTER_UPDATE_FIELDS,
  characterUpdateReview,
  prepareCharacterUpdates,
  readCharacterMatches
} from '../js/modules/cloudSync/characterUpdates.js';
const account = 'a'.repeat(64);
const normalize = raw => {
  const { ui: _ui, ...persisted } = normalizeState({ schemaVersion: SCHEMA_VERSION, ...raw });
  return persisted;
};
function fixture() {
  const localState = normalize({
    characters: [
      {
        id: 'local',
        nick: 'Тот же',
        level: 10,
        contacts: { email: 'private@local', password: 'KEEP' },
        launch: {
          gcPath: 'C:/PC_ONLY/GameCenter.exe',
          gcNick: 'LOCAL_ACCOUNT',
          gcAccount: true,
          gcIds: ['gc'],
          gcAccounts: { gc: { nick: 'LOCAL_ACCOUNT' } }
        }
      },
      { id: 'keep', nick: 'Только здесь' }
    ],
    parties: [{ id: 'p', name: 'Своя' }],
    plannerEntries: [{ id: 'task', title: 'Не удалять', date: '2026-11-03' }]
  });
  const source = planSyncIdentities({
    snapshot: normalize({ characters: [{ id: 'remote', nick: 'Тот же', level: 20, notes: 'Из облака' }] }),
    cryptoSource
  }).snapshot;
  const cloud = buildPublicSnapshot(source);
  const id = cloud.sections.characters.records[0].id;
  return { localState, cloud, id, select: fields => [{ cloudId: id, localId: 'local', fields }] };
}
describe('explicit non-deleting character updates', () => {
  it('nickname is only a suggestion; no automatic match for different identities', () => {
    const f = fixture(),
      v = characterUpdateReview(f.localState, f.cloud, account);
    expect(v.records[0]).toMatchObject({ matchedLocalId: '', suggestedLocalIds: ['local'] });
    expect(JSON.stringify(v)).not.toContain('private@local');
    expect(JSON.stringify(v)).not.toContain('PC_ONLY');
  });
  it('updates exactly selected fields, preserves every other character/section/local binding and IDs', () => {
    const f = fixture(),
      before = structuredClone(f.localState);
    const { candidate, changes } = prepareCharacterUpdates({ ...f, account, selections: f.select(['level']) });
    expect(candidate.characters[0].level).toBe(20);
    const expected = structuredClone(before);
    expected.characters[0].level = 20;
    expected.settings.cloudCharacterMatches = candidate.settings.cloudCharacterMatches;
    expect(candidate).toEqual(expected);
    expect(f.localState).toEqual(before);
    expect(changes).toEqual([{ cloudId: f.id, localId: 'local', fields: ['level'] }]);
    expect(characterUpdateReview(candidate, f.cloud, account).records[0].matchedLocalId).toBe('local');
    expect(characterUpdateReview(candidate, f.cloud, 'b'.repeat(64)).records[0].matchedLocalId).toBe('');
    expect(
      buildPublicSnapshot(planSyncIdentities({ snapshot: candidate, cryptoSource }).snapshot).sections.preferences
    ).not.toHaveProperty('cloudCharacterMatches');
  });
  it('can remember an explicit correspondence with zero field changes, without relabeling identity', () => {
    const f = fixture(),
      { candidate } = prepareCharacterUpdates({ ...f, account, selections: f.select([]) });
    expect(candidate.characters).toEqual(f.localState.characters);
    expect(readCharacterMatches(candidate.settings, account)).toEqual([{ cloudId: f.id, localId: 'local' }]);
  });
  it.each([
    'id',
    'syncId',
    'contacts',
    'launch',
    'partyIds',
    'mainPartyId',
    'archived',
    '__proto__',
    'constructor',
    'statsHistory',
    'marathonData'
  ])('rejects forbidden field %s', field => {
    const f = fixture();
    expect(() => prepareCharacterUpdates({ ...f, account, selections: f.select([field]) })).toThrow(
      'character_update_invalid'
    );
  });
  it('duplicate local nicknames do not choose a winner; explicit local target is preserved', () => {
    const f = fixture();
    f.localState.characters[1].nick = 'Тот же';
    const view = characterUpdateReview(f.localState, f.cloud, account);
    expect(view.records[0]).toMatchObject({ matchedLocalId: '', suggestedLocalIds: ['local', 'keep'] });
    const { candidate } = prepareCharacterUpdates({
      ...f,
      account,
      selections: [{ cloudId: f.id, localId: 'keep', fields: ['level'] }]
    });
    expect(candidate.characters[0]).toEqual(f.localState.characters[0]);
    expect(candidate.characters[1].level).toBe(20);
  });
  it('cannot override an existing strong identity by mapping it to a different local row', () => {
    const f = fixture();
    f.localState.characters[0].syncId = f.id;
    expect(characterUpdateReview(f.localState, f.cloud, account).records[0].matchedLocalId).toBe('local');
    expect(() =>
      prepareCharacterUpdates({ ...f, account, selections: [{ cloudId: f.id, localId: 'keep', fields: [] }] })
    ).toThrow('character_update_invalid');
  });
  it('never reuses a local target or remote source in the same update', () => {
    const f = fixture();
    expect(() => prepareCharacterUpdates({ ...f, account, selections: [...f.select([]), ...f.select([])] })).toThrow(
      'character_update_invalid'
    );
  });
  it('rejects stale/unknown targets and malformed stored mappings rather than repairing them', () => {
    const f = fixture();
    expect(() =>
      prepareCharacterUpdates({ ...f, account, selections: [{ cloudId: f.id, localId: 'missing', fields: [] }] })
    ).toThrow();
    f.localState.settings.cloudCharacterMatches = { version: 99, accounts: [] };
    expect(() => characterUpdateReview(f.localState, f.cloud, account)).toThrow('character_update_invalid');
  });
  it('keeps archived characters archived even if the source is active', () => {
    const f = fixture();
    f.localState.archivedCharacters.push(f.localState.characters.shift());
    const { candidate } = prepareCharacterUpdates({ ...f, account, selections: f.select(['level']) });
    expect(candidate.characters.map(c => c.id)).toEqual(['keep']);
    expect(candidate.archivedCharacters[0]).toMatchObject({ id: 'local', level: 20 });
  });
  it('does not repair duplicate local party IDs or overwrite memberships', () => {
    const f = fixture();
    f.localState.parties.push(structuredClone(f.localState.parties[0]));
    f.localState.characters[0].partyIds = ['p'];
    f.localState.characters[0].mainPartyId = 'p';
    const { candidate } = prepareCharacterUpdates({ ...f, account, selections: f.select(['level']) });
    expect(candidate.parties).toEqual(f.localState.parties);
    expect(candidate.characters[0].partyIds).toEqual(['p']);
  });
  it('all allowed update fields are an explicit safe set, with no private/identity/reference fields', () => {
    expect(Object.keys(CHARACTER_UPDATE_FIELDS)).toEqual([
      'nick',
      'class',
      'level',
      'sky',
      'favorite',
      'notes',
      'tags',
      'stats',
      'dungeonPasses',
      'ancientCoins',
      'lastCoinUpdate'
    ]);
  });
});

it('supports all offered fields and verifies that mappings survive restart without exporting them', () => {
  const f = fixture();
  Object.assign(f.cloud.sections.characters.records[0].fields, {
    nick: 'Другой ник',
    favorite: true,
    class: 'Воин',
    sky: { name: 'Небо', level: 2 },
    dungeonPasses: { weapon: 3, armor: 4, relic: 5 },
    tags: ['облако'],
    ancientCoins: 35,
    lastCoinUpdate: '2026-11-03T10:00:00.000Z'
  });
  f.cloud.sections.characters.records[0].fields.stats.hp = 1234;
  const { candidate } = prepareCharacterUpdates({
    ...f,
    account,
    selections: f.select(Object.keys(CHARACTER_UPDATE_FIELDS))
  });
  expect(candidate.characters[0]).toMatchObject({
    id: 'local',
    nick: 'Другой ник',
    level: 20,
    stats: { hp: 1234 },
    contacts: f.localState.characters[0].contacts,
    launch: f.localState.characters[0].launch
  });
  expect(readCharacterMatches(normalize(candidate).settings, account)).toEqual([{ cloudId: f.id, localId: 'local' }]);
  expect(
    JSON.stringify(buildPublicSnapshot(planSyncIdentities({ snapshot: candidate, cryptoSource }).snapshot))
  ).not.toContain('cloudCharacterMatches');
});
