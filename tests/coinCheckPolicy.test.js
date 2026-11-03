import { it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { latestCoinCheck } from '../js/modules/cloudSync/coinCheckPolicy.js';
import { normalizeState } from '../js/core/state.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import {
  prepareFullPublicSnapshotReplace,
  preparePublicSnapshotApply
} from '../js/modules/cloudSync/applyPublicSnapshot.js';
it('orders instants across timezones; missing/invalid values cannot displace a valid latest check', () => {
  expect(latestCoinCheck('2026-11-03T14:00:00Z', '2026-11-03T16:00:00+03:00')).toBe('2026-11-03T14:00:00Z');
  expect(latestCoinCheck(null, '2026-11-03T12:00:00Z')).toBe('2026-11-03T12:00:00Z');
  expect(latestCoinCheck('2026-11-03T12:00:00Z', 'invalid')).toBe('2026-11-03T12:00:00Z');
});
it.each(['2026-11-02T10:00:00Z', '2026-11-04T10:00:00Z', null])(
  'full replacement keeps the latest check (%s), without changing authenticated input or selecting balance',
  remote => {
    const { ui: _ui, ...raw } = normalizeState({
      schemaVersion: 10,
      characters: [{ id: 'a', nick: 'Hero', lastCoinUpdate: '2026-11-03T10:00:00Z', ancientCoins: 10 }]
    });
    const local = planSyncIdentities({ snapshot: raw, cryptoSource: webcrypto }).snapshot,
      cloud = buildPublicSnapshot(local);
    const record = cloud.sections.characters.records[0];
    record.fields.lastCoinUpdate = remote;
    record.fields.ancientCoins = 20;
    const original = structuredClone(cloud);
    const candidate = prepareFullPublicSnapshotReplace({
      localState: local,
      cloudSnapshot: cloud,
      cryptoSource: webcrypto
    }).candidateState();
    expect(candidate.characters[0].lastCoinUpdate).toBe(latestCoinCheck(local.characters[0].lastCoinUpdate, remote));
    expect(candidate.characters[0].ancientCoins).toBe(20);
    expect(local.characters[0].ancientCoins).toBe(10);
    expect(cloud).toEqual(original);
    const partial = preparePublicSnapshotApply({
      localState: local,
      cloudSnapshot: cloud,
      selectedRecords: [{ section: 'characters', id: record.id }],
      selectedSettings: [],
      cryptoSource: webcrypto
    });
    expect(partial.candidateState().characters[0].lastCoinUpdate).toBe(candidate.characters[0].lastCoinUpdate);
  }
);
