import { it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState } from '../js/core/state.js';
import { planComparisonIdentities } from '../js/modules/cloudSync/comparisonIdentities.js';
import { planSyncIdentities } from '../js/modules/cloudSync/identityMigration.js';
const snapshot = raw => {
  const { ui, ...s } = normalizeState(raw);
  return s;
};
it('keeps every duplicate party for a read-only full-file diff; never repairs the actual snapshot', () => {
  const original = snapshot({
    characters: [{ id: 'a', nick: 'A', partyIds: ['p'], mainPartyId: 'p' }],
    parties: [
      { id: 'p', name: 'Active' },
      { id: 'p', name: 'Other' }
    ],
    archivedParties: [{ id: 'p', name: 'Archived', memberLinks: [{ characterId: 'a', isMain: true }] }]
  });
  const before = structuredClone(original);
  expect(() => planSyncIdentities({ snapshot: original, cryptoSource: webcrypto })).toThrow();
  const p = planComparisonIdentities({ snapshot: original, cryptoSource: webcrypto });
  expect(p.duplicatePartyIds).toBe(2);
  expect(original).toEqual(before);
  const rows = [...p.snapshot.parties, ...p.snapshot.archivedParties];
  expect(rows.map(r => r.name)).toEqual(['Active', 'Other', 'Archived']);
  expect(new Set(rows.map(r => r.id)).size).toBe(3);
  expect(p.snapshot.characters[0].partyIds).toEqual(['p']);
  expect(p.snapshot.archivedParties[0].memberLinks).toEqual(before.archivedParties[0].memberLinks);
  expect(() => planSyncIdentities({ snapshot: original, cryptoSource: webcrypto })).toThrow();
});
it('can inspect a duplicated party mirror with the same syncId without merging it', () => {
  const original = planSyncIdentities({
    snapshot: snapshot({ parties: [{ id: 'p', name: 'A' }] }),
    cryptoSource: webcrypto
  }).snapshot;
  original.archivedParties = [{ ...original.parties[0], memberLinks: [] }];
  const p = planComparisonIdentities({ snapshot: original, cryptoSource: webcrypto });
  expect(p.duplicatePartyIds).toBe(1);
  expect(p.snapshot.parties[0].syncId).not.toBe(p.snapshot.archivedParties[0].syncId);
});
it('does not relax unrelated identity corruption (characters or unique-party syncIds)', () => {
  const s = snapshot({
    characters: [{ id: 'a', nick: 'A' }],
    parties: [
      { id: 'p', name: 'A' },
      { id: 'q', name: 'B' }
    ]
  });
  s.characters.push({ ...s.characters[0] });
  expect(() => planComparisonIdentities({ snapshot: s, cryptoSource: webcrypto })).toThrow();
  s.characters.pop();
  s.parties[0].syncId = s.parties[1].syncId = webcrypto.randomUUID();
  expect(() => planComparisonIdentities({ snapshot: s, cryptoSource: webcrypto })).toThrow();
});
