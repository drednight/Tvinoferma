// @ts-check
// Process-local capability issued only after re-reading the saved merge intent.
// This is not a cross-process lock, fsync proof, or protection against rollback.
import { forgetLoadedState, loadData } from '../../core/storage.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { isVerifiedConservativeAdoption } from './cloudReview.js';
import { cloudSnapshotMatchesDisk, currentCloudStateSnapshot } from './guardedStateWrite.js';
import { conservativeSnapshotHash, readPendingConservativeMerge } from './pendingConservativeMerge.js';

const authorizations = new WeakSet();
function samePin(left, right) {
  return left?.versionId === right?.versionId && left?.sha256 === right?.sha256;
}
function freezeMarker(marker) {
  return Object.freeze({
    ...marker,
    ...(marker.resolution
      ? {
          resolution: Object.freeze({
            ...marker.resolution,
            cloudRecords: Object.freeze(marker.resolution.cloudRecords.map(row => Object.freeze({ ...row }))),
            cloudSettings: Object.freeze([...marker.resolution.cloudSettings])
          })
        }
      : {}),
    basePin: Object.freeze({ ...marker.basePin }),
    targetPin: Object.freeze({ ...marker.targetPin }),
    pendingPin: marker.pendingPin ? Object.freeze({ ...marker.pendingPin }) : null,
    retainedIntents: Object.freeze(
      marker.retainedIntents.map(row => Object.freeze({ pin: Object.freeze({ ...row.pin }), phase: row.phase }))
    ),
    settingsSelections: Object.freeze([...marker.settingsSelections]),
    previousBase: marker.previousBase
      ? Object.freeze({ pin: Object.freeze({ ...marker.previousBase.pin }), anchorId: marker.previousBase.anchorId })
      : null
  });
}

/** @param {any} value @param {any} proof */
export function isVerifiedConservativeAuthorization(value, proof) {
  return !!value && typeof value === 'object' && authorizations.has(value) && value.proof === proof;
}

/**
 * The stored state must still contain exactly the intended original snapshot.
 * Caller must separately recheck the cloud and perform a guarded final write.
 * @param {{proof:any,cryptoSource?:Crypto}} options
 */
export async function authorizeSavedConservativeMerge({ proof, cryptoSource }) {
  if (!isVerifiedConservativeAdoption(proof)) throw new Error('Не подтверждена история объединения');
  const original = currentCloudStateSnapshot();
  const witness = JSON.stringify(original);
  const marker = readPendingConservativeMerge(original.settings);
  if (
    !marker ||
    marker.provider !== proof.provider ||
    marker.datasetId !== proof.datasetId ||
    !samePin(marker.basePin, proof.basePin) ||
    !samePin(marker.targetPin, proof.pin) ||
    JSON.stringify(marker.resolution || null) !== JSON.stringify(proof.resolution())
  )
    return null;
  const selections = proof.localSnapshot().sections.preferences.selections;
  if (JSON.stringify(selections) !== JSON.stringify(marker.settingsSelections)) return null;
  const local = buildPublicSnapshot(original, { settingsSelections: selections });
  if (
    (await conservativeSnapshotHash(local, cryptoSource)) !== marker.localHash ||
    (await conservativeSnapshotHash(proof.localSnapshot(), cryptoSource)) !== marker.localHash ||
    (await conservativeSnapshotHash(proof.plan().snapshot(), cryptoSource)) !== marker.mergedHash
  )
    return null;
  let disk;
  try {
    disk = await loadData();
    if (JSON.stringify(currentCloudStateSnapshot()) !== witness || !cloudSnapshotMatchesDisk(original, disk))
      return null;
  } finally {
    if (disk) forgetLoadedState(disk);
  }
  const authorization = Object.freeze({ proof, marker: freezeMarker(marker) });
  authorizations.add(authorization);
  return authorization;
}
