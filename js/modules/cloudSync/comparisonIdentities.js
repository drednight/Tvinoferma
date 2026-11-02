// @ts-check
// Read-only projection for FULL-FILE comparison, never migration/publication.
// Broken local party IDs must not prevent inspecting a valid remote file. Keep
// every local row in the diff; do not guess which duplicate should own links.
import { planSyncIdentities } from './identityMigration.js';
import { validateJsonSnapshot } from './envelope.js';

/** @param {{snapshot?:any,cryptoSource?:Crypto}} [options] */
export function planComparisonIdentities({ snapshot, cryptoSource } = {}) {
  validateJsonSnapshot(snapshot);
  const copy = structuredClone(snapshot);
  const parties = [...(copy.parties || []), ...(copy.archivedParties || [])];
  const reserved = new Set(parties.map(row => row.id));
  const seen = new Set(),
    syncIds = new Set();
  let duplicates = 0,
    serial = 0;
  for (const row of parties) {
    if (seen.has(row.id)) {
      duplicates++;
      let temporary;
      do {
        temporary = `__comparison_only_party_${++serial}`;
      } while (reserved.has(temporary));
      reserved.add(temporary);
      row.id = temporary;
      if (syncIds.has(row.syncId)) delete row.syncId;
    }
    seen.add(row.id);
    if (row.syncId) syncIds.add(row.syncId);
  }
  return {
    ...planSyncIdentities({ snapshot: copy, cryptoSource }),
    duplicatePartyIds: duplicates
  };
}
