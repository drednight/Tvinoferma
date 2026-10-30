import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import {
  parsePrivateSnapshot,
  buildPrivateDelta,
  mergePrivateSnapshots,
  privateDifferences,
  applyPrivateSelection
} from '../js/modules/cloudSync/privateSnapshot.js';
import {
  sealHistoryVersion,
  sealHistoryChildWithPlannerTombstones,
  verifyHistory,
  historyEnvelopePin
} from '../js/modules/cloudSync/history.js';
import { encryptSnapshot, generateRecoveryKey, generateSyncId } from '../js/modules/cloudSync/envelope.js';
function fixture() {
  const { ui, ...raw } = normalizeState({
    schemaVersion: 10,
    characters: [
      {
        id: 'hero',
        nick: 'Герой',
        contacts: {
          password: 'LOCAL_PASSWORD',
          email: 'LOCAL_EMAIL',
          phone: 'LOCAL_PHONE',
          recoveryEmail: 'LOCAL_RECOVERY'
        }
      }
    ],
    archivedCharacters: [{ id: 'archived', nick: 'Архив', contacts: { password: 'ARCHIVED_PASSWORD' } }],
    plannerEntries: [{ id: 'task', title: 'Задача', date: '2026-10-30' }]
  });
  const state = planSyncIdentities({ snapshot: raw, cryptoSource: webcrypto }).snapshot;
  const publicSnapshot = buildPublicSnapshot(state);
  const id = state.characters[0].syncId;
  return {
    state,
    publicSnapshot,
    id,
    delta: { schemaVersion: 1, records: [{ characterId: id, fields: { password: 'CLOUD_PASSWORD', email: '' } }] }
  };
}
describe('строгая отдельная приватная схема и закрытое сравнение', () => {
  it('экспортирует ровно выбранные поля активных и архивных персонажей без пути или входа', () => {
    const f = fixture();
    const delta = buildPrivateDelta(f.state, f.publicSnapshot, ['phone', 'email']);
    expect(delta.records).toHaveLength(2);
    expect(delta.records.every(row => Object.keys(row.fields).join(',') === 'email,phone')).toBe(true);
    expect(JSON.stringify(delta)).not.toContain('LOCAL_PASSWORD');
    expect(JSON.stringify(delta)).not.toContain('ARCHIVED_PASSWORD');
  });
  it.each(['password', 'email', 'phone', 'recoveryEmail'])('экспортирует независимую категорию %s', field => {
    const f = fixture();
    expect(
      buildPrivateDelta(f.state, f.publicSnapshot, [field]).records.every(
        row => Object.keys(row.fields).length === 1 && Object.hasOwn(row.fields, field)
      )
    ).toBe(true);
  });
  it('не считает невыбранное удалением или обновлением, а пустую строку передаёт явно', () => {
    const f = fixture();
    const old = buildPrivateDelta(f.state, f.publicSnapshot, ['password', 'phone']);
    const delta = buildPrivateDelta(f.state, f.publicSnapshot, ['email']);
    const merged = mergePrivateSnapshots(old, delta, f.publicSnapshot);
    expect(merged.records.find(row => row.characterId === f.id).fields).toEqual({
      password: 'LOCAL_PASSWORD',
      phone: 'LOCAL_PHONE',
      email: 'LOCAL_EMAIL'
    });
    delta.records.find(row => row.characterId === f.id).fields.email = '';
    expect(
      mergePrivateSnapshots(merged, delta, f.publicSnapshot).records.find(row => row.characterId === f.id).fields.email
    ).toBe('');
  });
  it('показывает только факт различия и явной очистки, не значения', () => {
    const f = fixture();
    const diff = privateDifferences(f.delta, f.publicSnapshot, f.state, ['email', 'password']);
    expect(diff).toMatchObject([
      { field: 'email', clears: true, cloudPresent: false, localPresent: true },
      { field: 'password', clears: false, cloudPresent: true }
    ]);
    for (const secret of ['LOCAL_EMAIL', 'LOCAL_PASSWORD', 'CLOUD_PASSWORD'])
      expect(JSON.stringify(diff)).not.toContain(secret);
    expect(privateDifferences(f.delta, f.publicSnapshot, f.state, [])).toEqual([]);
  });
  it('меняет только выбранную пару и не мутирует исходное состояние', () => {
    const f = fixture();
    const original = structuredClone(f.state);
    const candidate = applyPrivateSelection(f.delta, f.publicSnapshot, f.state, [
      { characterId: f.id, field: 'email' }
    ]);
    expect(candidate.characters[0].contacts).toMatchObject({
      email: '',
      password: 'LOCAL_PASSWORD',
      phone: 'LOCAL_PHONE'
    });
    expect(f.state).toEqual(original);
  });
  it('не угадывает отсутствующего местного персонажа по имени', () => {
    const f = fixture();
    f.state.characters = [];
    expect(privateDifferences(f.delta, f.publicSnapshot, f.state, ['password'])[0].selectable).toBe(false);
    expect(() =>
      applyPrivateSelection(f.delta, f.publicSnapshot, f.state, [{ characterId: f.id, field: 'password' }])
    ).toThrow();
  });
  it.each([
    value => {
      value.schemaVersion = 2;
    },
    value => {
      value.records = [];
    },
    value => {
      value.records.push(structuredClone(value.records[0]));
    },
    value => {
      value.records[0].characterId = 'not-id';
    },
    value => {
      value.records[0].characterId = '11111111-1111-4111-8111-111111111111';
    },
    value => {
      value.records[0].fields = {};
    },
    value => {
      value.records[0].fields.cookies = 'not-allowed';
    },
    value => {
      value.records[0].fields.password = null;
    },
    value => {
      value.records[0].fields.password = 'x'.repeat(100001);
    },
    value => {
      value.extra = true;
    }
  ])('отклоняет повреждённую или расширенную приватную схему %#', mutate => {
    const f = fixture();
    mutate(f.delta);
    expect(() => parsePrivateSnapshot(f.delta, f.publicSnapshot)).toThrow();
  });
  it('не вызывает getter при проверке приватных значений', () => {
    const f = fixture();
    let calls = 0;
    Object.defineProperty(f.delta.records[0].fields, 'password', {
      enumerable: true,
      get() {
        calls++;
        throw Error('SECRET_ERROR');
      }
    });
    expect(() => parsePrivateSnapshot(f.delta, f.publicSnapshot)).toThrow();
    expect(calls).toBe(0);
  });
  it.each([[], ['unknown'], ['password', 'password']])('не угадывает состав выбранных категорий %j', fields => {
    const f = fixture();
    expect(() => buildPrivateDelta(f.state, f.publicSnapshot, fields)).toThrow();
  });
});
async function historyFixture() {
  const f = fixture();
  const key = generateRecoveryKey(webcrypto);
  const datasetId = generateSyncId(webcrypto);
  const root = await sealHistoryVersion({
    publicSnapshot: f.publicSnapshot,
    parent: null,
    recoveryKey: key,
    datasetId,
    versionId: generateSyncId(webcrypto),
    cryptoSource: webcrypto
  });
  const child = await sealHistoryChildWithPlannerTombstones({
    publicSnapshot: f.publicSnapshot,
    parent: root.pin,
    parentSnapshot: f.publicSnapshot,
    privateSnapshot: f.delta,
    previousTombstones: [],
    deletedIds: [],
    confirmedDeletion: false,
    recoveryKey: key,
    datasetId,
    versionId: generateSyncId(webcrypto),
    cryptoSource: webcrypto
  });
  const verify = envelopes =>
    verifyHistory({
      envelopes,
      expectedDatasetId: datasetId,
      recoveryKey: key,
      root: root.pin,
      knownPins: [root.pin],
      cryptoSource: webcrypto
    });
  return { ...f, key, datasetId, root, child, verify };
}
describe('аутентифицированная v4-история ручной передачи', () => {
  it('читает v1→v4, связывает приватные записи с public sync-ID и возвращает независимые копии', async () => {
    const f = await historyFixture();
    const history = await f.verify([f.root.envelope, f.child.envelope]);
    expect(history.privateSnapshot(f.root.pin)).toBeNull();
    expect(history.privateSnapshot(f.child.pin)).toEqual(f.delta);
    const copy = history.privateSnapshot(f.child.pin);
    copy.records[0].fields.password = 'MUTATED';
    expect(history.privateSnapshot(f.child.pin)).toEqual(f.delta);
    expect(history.usesPlannerTombstones(f.child.pin)).toBe(true);
    expect(JSON.stringify(f.child.envelope)).not.toContain('CLOUD_PASSWORD');
  });
  it('несёт cumulative метки календаря вместе с приватной частью', async () => {
    const f = await historyFixture();
    const next = structuredClone(f.publicSnapshot);
    const id = next.sections.planner.records[0].id;
    next.sections.planner.records = [];
    next.sections.planner.order = [];
    const child = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot: next,
      parent: f.child.pin,
      parentSnapshot: f.publicSnapshot,
      privateSnapshot: f.delta,
      previousTombstones: [],
      deletedIds: [id],
      confirmedDeletion: true,
      recoveryKey: f.key,
      datasetId: f.datasetId,
      versionId: generateSyncId(webcrypto),
      cryptoSource: webcrypto
    });
    const history = await f.verify([f.root.envelope, f.child.envelope, child.envelope]);
    expect(history.plannerTombstones(child.pin)).toEqual([id]);
    expect(history.privateSnapshot(child.pin)).toEqual(f.delta);
  });
  it('не позволяет понизить приватную v4 до v1 или v3', async () => {
    const f = await historyFixture();
    const child = await sealHistoryVersion({
      publicSnapshot: f.publicSnapshot,
      parent: f.child.pin,
      recoveryKey: f.key,
      datasetId: f.datasetId,
      versionId: generateSyncId(webcrypto),
      cryptoSource: webcrypto
    });
    await expect(f.verify([f.root.envelope, f.child.envelope, child.envelope])).rejects.toThrow();
  });
  it('не позволяет исчезнуть прежней категории: очистка возможна только явной пустой строкой', async () => {
    const f = await historyFixture();
    const delta = structuredClone(f.delta);
    delete delta.records[0].fields.email;
    const child = await sealHistoryChildWithPlannerTombstones({
      publicSnapshot: f.publicSnapshot,
      parent: f.child.pin,
      parentSnapshot: f.publicSnapshot,
      privateSnapshot: delta,
      previousTombstones: [],
      deletedIds: [],
      confirmedDeletion: false,
      recoveryKey: f.key,
      datasetId: f.datasetId,
      versionId: generateSyncId(webcrypto),
      cryptoSource: webcrypto
    });
    await expect(f.verify([f.root.envelope, f.child.envelope, child.envelope])).rejects.toThrow();
  });
  it('не принимает v4 без privateSnapshot и v1 с посторонним privateSnapshot', async () => {
    const f = await historyFixture();
    for (const version of [1, 4]) {
      const payload = {
        format: 'tvinoferma-public-history',
        version,
        parent: f.root.pin,
        publicSnapshot: f.publicSnapshot,
        ...(version === 1 ? { privateSnapshot: f.delta } : { plannerDeletedIds: [], plannerTombstones: [] })
      };
      const envelope = await encryptSnapshot({
        snapshot: payload,
        recoveryKey: f.key,
        datasetId: f.datasetId,
        versionId: generateSyncId(webcrypto),
        cryptoSource: webcrypto
      });
      await expect(f.verify([f.root.envelope, envelope])).rejects.toThrow();
    }
  });
  it('привязывает приватные значения к точному зашифрованному отпечатку', async () => {
    const f = await historyFixture();
    const pin = await historyEnvelopePin({
      envelope: f.child.envelope,
      expectedDatasetId: f.datasetId,
      cryptoSource: webcrypto
    });
    expect(pin).toEqual(f.child.pin);
    const changed = structuredClone(f.child.envelope);
    changed.ciphertext = (changed.ciphertext[0] === 'A' ? 'B' : 'A') + changed.ciphertext.slice(1);
    await expect(f.verify([f.root.envelope, changed])).rejects.toThrow();
  });
});
