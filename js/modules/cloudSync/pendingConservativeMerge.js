// @ts-check
// Durable intent for a narrow three-way merge. Contains pins and hashes, never
// record values or secrets. Older clients do not understand it: update ALL PCs.
import { isSyncId } from './envelope.js';
import { publicSnapshotIdentityTypes } from './compareSnapshots.js';
import { PORTABLE_SETTING_GROUPS } from './settingsExport.js';
import { parseConservativeMergeChoices } from './conservativeMergeChoices.js';

const KEY = 'cloudSyncPendingMerge';
const HEX = /^[0-9a-f]{64}$/;

function invalid() {
  return new Error('Незавершённое объединение: требуется безопасное восстановление');
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalid();
  return value;
}
function pin(value) {
  const item = object(value, ['versionId', 'sha256']);
  if (!isSyncId(item.versionId) || typeof item.sha256 !== 'string' || !HEX.test(item.sha256)) throw invalid();
  return { versionId: item.versionId, sha256: item.sha256 };
}
function base(value) {
  if (value === null) return null;
  const item = object(value, ['pin', 'anchorId']);
  const clean = { pin: pin(item.pin), anchorId: item.anchorId };
  if (!isSyncId(clean.anchorId) || clean.pin.versionId === clean.anchorId) throw invalid();
  return clean;
}
function marker(value) {
  const version = value?.version;
  const item = object(value, [
    'version',
    'operationId',
    'provider',
    'datasetId',
    'basePin',
    'targetPin',
    'previousBase',
    'queueRevisionId',
    'pendingPin',
    'pendingPhase',
    'retainedIntents',
    'settingsSelections',
    'localHash',
    'mergedHash',
    ...(version === 2 ? ['resolution'] : [])
  ]);
  const basePin = pin(item.basePin);
  const targetPin = pin(item.targetPin);
  const pendingPin = item.pendingPin === null ? null : pin(item.pendingPin);
  if (!Array.isArray(item.retainedIntents) || item.retainedIntents.length > 16) throw invalid();
  const retainedIntents = item.retainedIntents.map(value => {
    const row = object(value, ['pin', 'phase']);
    if (!['queued', 'prepared'].includes(row.phase)) throw invalid();
    return { pin: pin(row.pin), phase: row.phase };
  });
  const retainedIds = retainedIntents.map(row => row.pin.versionId);
  if (
    new Set(retainedIds).size !== retainedIds.length ||
    retainedIds.some(id => [basePin.versionId, targetPin.versionId, pendingPin?.versionId].includes(id))
  )
    throw invalid();
  if (
    ![1, 2].includes(item.version) ||
    !isSyncId(item.operationId) ||
    !['google', 'yandex'].includes(item.provider) ||
    !isSyncId(item.datasetId) ||
    !isSyncId(item.queueRevisionId) ||
    (pendingPin === null ? item.pendingPhase !== null : !['queued', 'prepared'].includes(item.pendingPhase)) ||
    (pendingPin !== null && [basePin.versionId, targetPin.versionId].includes(pendingPin.versionId)) ||
    !Array.isArray(item.settingsSelections) ||
    JSON.stringify(item.settingsSelections) !==
      JSON.stringify(PORTABLE_SETTING_GROUPS.filter(group => item.settingsSelections.includes(group))) ||
    basePin.versionId === targetPin.versionId ||
    typeof item.localHash !== 'string' ||
    !HEX.test(item.localHash) ||
    typeof item.mergedHash !== 'string' ||
    !HEX.test(item.mergedHash)
  )
    throw invalid();
  return {
    version: item.version,
    operationId: item.operationId,
    provider: item.provider,
    datasetId: item.datasetId,
    basePin,
    targetPin,
    previousBase: base(item.previousBase),
    queueRevisionId: item.queueRevisionId,
    pendingPin,
    pendingPhase: item.pendingPhase,
    retainedIntents,
    settingsSelections: [...item.settingsSelections],
    localHash: item.localHash,
    mergedHash: item.mergedHash,
    ...(item.version === 2 ? { resolution: parseConservativeMergeChoices(item.resolution) } : {})
  };
}
function settingsObject(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid();
  return settings;
}

/** Returns a validated copy; malformed markers are never silently ignored. */
export function readPendingConservativeMerge(settings) {
  const source = settingsObject(settings);
  if (!Object.hasOwn(source, KEY)) return null;
  return marker(source[KEY]);
}

export function requireNoPendingConservativeMerge(settings) {
  if (readPendingConservativeMerge(settings)) throw invalid();
}

/** Add only to an otherwise unmarked state, before changing the queue. */
export function addPendingConservativeMerge(settings, value) {
  requireNoPendingConservativeMerge(settings);
  return { ...settings, [KEY]: marker(value) };
}

/** Only the operation that prepared the marker may remove it. */
export function removePendingConservativeMerge(settings, operationId) {
  const current = readPendingConservativeMerge(settings);
  if (!current || current.operationId !== operationId) throw invalid();
  const result = { ...settings };
  delete result[KEY];
  return result;
}

/** A hash is an equality witness, not a secret or a proof of ancestry. */
export async function conservativeSnapshotHash(snapshot, cryptoSource = globalThis.crypto) {
  publicSnapshotIdentityTypes(snapshot);
  if (!cryptoSource?.subtle) throw invalid();
  const data = new TextEncoder().encode(`Tvinoferma conservative merge v1\n${JSON.stringify(snapshot)}`);
  const digest = new Uint8Array(await cryptoSource.subtle.digest('SHA-256', data));
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
}
