// @ts-check
// Full-file exchange. No three-way merge, no inference of per-record tombstones.
// Existing immutable encrypted files are kept as backups. A parent only identifies
// the file the user replaced. Concurrent writes are retained, not silently lost.
import { loadData, forgetLoadedState } from '../../core/storage.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { comparePublicSnapshots } from './compareSnapshots.js';
import { prepareFullPublicSnapshotReplace } from './applyPublicSnapshot.js';
import {
  currentCloudStateSnapshot,
  cloudSnapshotMatchesDisk,
  stageGuardedCloudStateWrite
} from './guardedStateWrite.js';
import { requireResolvedSelectiveApply } from './pendingSelectiveApply.js';
import { openConnectedPublicationContext } from './connectedPublication.js';
import { openPinnedNativeCloudSession } from './providers/pinnedNativeCloudSession.js';
import { beginCloudDataOperation } from './credentialResetCoordination.js';
import { generateSyncId } from './envelope.js';
import { historyEnvelopePin, verifyHistory, sealFileSnapshot, MAX_HISTORY_VERSIONS } from './history.js';
import { object } from './exportSchema.js';
import { readSnapshotFileState, withSnapshotFileState, sameFilePin, snapshotFileHash } from './snapshotFileState.js';

const reviews = new WeakMap();
const savedTimes = new WeakMap();
const NO_NETWORK = Object.freeze({
  generateFileId: async () => {
    throw new Error('offline');
  },
  upload: async () => {
    throw new Error('offline');
  },
  verify: async () => {
    throw new Error('offline');
  }
});
const outcome = status => Object.freeze({ status });
function options(value, extra = []) {
  const input = object(value, ['provider', 'invoke'], ['cryptoSource', 'openSession', 'timeoutMs', ...extra]);
  if (
    !['google', 'yandex'].includes(input.provider) ||
    typeof input.invoke !== 'function' ||
    (input.openSession !== undefined && typeof input.openSession !== 'function')
  )
    throw new Error('Некорректная операция с файлом');
  return input;
}
async function saved() {
  let loaded;
  try {
    const original = currentCloudStateSnapshot();
    requireResolvedSelectiveApply(original.settings);
    loaded = await loadData();
    if (
      JSON.stringify(original) !== JSON.stringify(currentCloudStateSnapshot()) ||
      !cloudSnapshotMatchesDisk(original, loaded)
    )
      return null;
    savedTimes.set(original, loaded.savedAt ?? null);
    return original;
  } finally {
    if (loaded) forgetLoadedState(loaded);
  }
}
function unchanged(original) {
  return JSON.stringify(original) === JSON.stringify(currentCloudStateSnapshot());
}
async function open(input, risk) {
  const context = await openConnectedPublicationContext(input);
  if (!context) return { status: 'binding_blocked' };
  const local = readSnapshotFileState(currentCloudStateSnapshot().settings, input.provider, context.binding.datasetId);
  // Never silently abandon an old queued/prepared/private intent on migration.
  const legacy = await context.queue(NO_NETWORK).inspectLinearHead(context.pins);
  if (!['ready', 'no_local_lineage'].includes(legacy.status)) return { status: 'legacy_queue_pending' };
  if (legacy.status === 'ready' && (legacy.nextPin || legacy.retainedIntents.length))
    return { status: 'legacy_queue_pending' };
  risk.refresh = input.provider === 'google';
  const opened = await (input.openSession || openPinnedNativeCloudSession)({
    provider: input.provider,
    ...context.keyOptions
  });
  if (opened.status !== 'opened') return { status: opened.status || 'unavailable' };
  risk.refresh = false;
  if (
    opened.datasetId !== context.binding.datasetId ||
    !sameFilePin(opened.rootPin, context.binding.rootPin) ||
    opened.keyPin.bundleId !== context.binding.keyPin.bundleId ||
    opened.keyPin.sha256 !== context.binding.keyPin.sha256
  ) {
    opened.session.dispose();
    return { status: 'binding_blocked' };
  }
  return { status: 'opened', context, session: opened.session, local, legacy };
}
async function remote(opened, input) {
  const { session, context, local, legacy } = opened;
  const listed = await session.listWithDates();
  if (listed.status !== 'listed' || !listed.versions.length || listed.versions.length > MAX_HISTORY_VERSIONS)
    throw new Error('Файл недоступен');
  const envelopes = [];
  let total = 0;
  for (const row of listed.versions) {
    const found = await session.read(row.versionId);
    if (found.status !== 'found' || found.envelope.versionId !== row.versionId) throw new Error('Файл изменился');
    total += found.envelope.ciphertext.length + (found.envelope.keyCapsule?.length || 0);
    if (total > 64 * 1024 * 1024) throw new Error('Слишком большой набор файлов');
    envelopes.push(found.envelope);
  }
  const again = await session.listWithDates();
  if (again.status !== 'listed' || JSON.stringify(again.versions) !== JSON.stringify(listed.versions))
    throw new Error('Список файлов изменился');
  const pins = new Map((legacy.confirmedPins || []).map(pin => [pin.versionId, pin]));
  if (local?.acceptedPin) pins.set(local.acceptedPin.versionId, local.acceptedPin);
  const history = await verifyHistory({
    envelopes,
    expectedDatasetId: context.binding.datasetId,
    root: context.binding.rootPin,
    knownPins: [...pins.values()],
    recoveryKey: context.key.dataKey,
    cryptoSource: input.cryptoSource
  });
  const heads = history.observedHeads();
  if (heads.length !== 1) return { status: 'multiple_files' };
  const pin = heads[0];
  return {
    status: 'ready',
    history,
    pin,
    envelopes,
    snapshot: history.publicSnapshot(pin),
    modifiedAt: listed.versions.find(row => row.versionId === pin.versionId)?.modifiedAt ?? null
  };
}
async function journal(original, provider, row, label = 'pre-cloud-file-journal') {
  const candidate = structuredClone(original);
  candidate.settings = withSnapshotFileState(candidate.settings, provider, row);
  const result = await stageGuardedCloudStateWrite({
    original,
    candidate,
    backupLabel: label,
    selectedCount: 0
  }).commit({ confirmed: true });
  return { result, candidate };
}
function initialRow(datasetId) {
  return { version: 1, datasetId, acceptedPin: null, acceptedHash: null, pending: null };
}

/** Read-only: no ID assignment, baseline update, upload, or application. */
export async function checkSnapshotFile(value) {
  const input = options(value);
  let operation, opened;
  const risk = { refresh: false };
  try {
    operation = beginCloudDataOperation();
    const original = await saved();
    if (!original) return outcome('state_changed_or_unsaved');
    opened = await open(input, risk);
    if (opened.status !== 'opened') return outcome(opened.status);
    const cloud = await remote(opened, input);
    if (cloud.status !== 'ready') return outcome(cloud.status);
    const snapshot = buildPublicSnapshot(original, {
      settingsSelections: cloud.snapshot.sections.preferences.selections
    });
    const hash = await snapshotFileHash(snapshot, input.cryptoSource);
    const remoteHash = await snapshotFileHash(cloud.snapshot, input.cryptoSource);
    if (!unchanged(original)) return outcome('state_changed_or_unsaved');
    const basePin = opened.local?.acceptedPin || opened.legacy.confirmedPin || null;
    const baseHash =
      opened.local?.acceptedHash ||
      (basePin ? await snapshotFileHash(cloud.history.publicSnapshot(basePin), input.cryptoSource) : null);
    const view = Object.freeze({
      status: 'ready',
      provider: input.provider,
      pin: Object.freeze({ ...cloud.pin }),
      checkedAt: new Date().toISOString(),
      modifiedAt: cloud.modifiedAt,
      localSavedAt: savedTimes.get(original) ?? null,
      localChanged: baseHash === null || hash !== baseHash,
      remoteChanged: !sameFilePin(basePin, cloud.pin),
      matches: hash === remoteHash,
      pending: opened.local?.pending?.phase || null,
      privateCarry: cloud.history.privateSnapshot(cloud.pin) !== null,
      differences: comparePublicSnapshots({ local: snapshot, cloud: cloud.snapshot })
    });
    reviews.set(view, {
      original,
      snapshot,
      hash,
      remoteHash,
      pin: cloud.pin,
      datasetId: opened.context.binding.datasetId
    });
    return view;
  } catch {
    return outcome('unavailable_or_changed');
  } finally {
    opened?.session?.dispose();
    operation?.finish(risk.refresh);
  }
}
function checkedReview(input) {
  const review = reviews.get(input.review);
  if (!review || input.review.provider !== input.provider) throw new Error('Повторите проверку файла');
  return review;
}

/** Whole public replacement including deletions and order, only after explicit consent. */
export async function replaceFromSnapshotFile(value) {
  const input = options(value, ['review', 'confirmed']);
  if (input.confirmed !== true) return outcome('confirmation_required');
  let operation, opened;
  const risk = { refresh: false };
  try {
    const review = checkedReview(input);
    operation = beginCloudDataOperation();
    if (!unchanged(review.original)) return outcome('state_changed_or_unsaved');
    opened = await open(input, risk);
    if (opened.status !== 'opened') return outcome(opened.status);
    if (opened.context.binding.datasetId !== review.datasetId) return outcome('binding_blocked');
    if (opened.local?.pending) return outcome('pending_upload');
    const cloud = await remote(opened, input);
    if (cloud.status !== 'ready') return outcome(cloud.status);
    if (!sameFilePin(cloud.pin, review.pin)) return outcome('remote_changed');
    const prepared = prepareFullPublicSnapshotReplace({
      localState: review.original,
      cloudSnapshot: cloud.snapshot,
      cryptoSource: input.cryptoSource
    });
    const candidate = prepared.candidateState();
    candidate.settings = withSnapshotFileState(candidate.settings, input.provider, {
      ...initialRow(review.datasetId),
      acceptedPin: cloud.pin,
      acceptedHash: review.remoteHash
    });
    const result = await stageGuardedCloudStateWrite({
      original: review.original,
      candidate,
      backupLabel: 'pre-cloud-file-replace',
      selectedCount: review.original.characters.length + review.original.archivedCharacters.length
    }).commit({ confirmed: true });
    if (result.status === 'applied') reviews.delete(input.review);
    return result;
  } catch {
    return outcome('unavailable_or_changed');
  } finally {
    opened?.session?.dispose();
    operation?.finish(risk.refresh);
  }
}

async function verifyPending(opened, input, row) {
  const p = row.pending;
  const pin = await historyEnvelopePin({
    envelope: p.envelope,
    expectedDatasetId: row.datasetId,
    cryptoSource: input.cryptoSource
  });
  if (!sameFilePin(pin, p.pin)) return outcome('pending_invalid');
  const result = await opened.session.verify({ envelope: p.envelope, ...(p.fileId ? { fileId: p.fileId } : {}) });
  if (result.status !== 'verified')
    return outcome(result.status === 'mismatch' ? 'content_mismatch' : 'verification_pending');
  const cloud = await remote(opened, input);
  if (cloud.status !== 'ready') return outcome(cloud.status);
  const lineage = cloud.history.lineage(p.pin);
  if (
    !cloud.history.isFileSnapshot(p.pin) ||
    !sameFilePin(lineage.at(-2), p.parent) ||
    (await snapshotFileHash(cloud.history.publicSnapshot(p.pin), input.cryptoSource)) !== p.contentHash
  )
    return outcome('pending_invalid');
  const original = await saved();
  if (!original) return outcome('state_changed_or_unsaved');
  const current = readSnapshotFileState(original.settings, input.provider, row.datasetId);
  if (JSON.stringify(current) !== JSON.stringify(row)) return outcome('pending_changed');
  const done = await journal(original, input.provider, {
    ...row,
    pending: null,
    acceptedPin: p.pin,
    acceptedHash: p.contentHash
  });
  return done.result.status === 'applied' ? outcome('sent_verified') : done.result;
}

/** Saves encrypted pending bytes BEFORE the single upload. Unknown uploads are verify-only. */
export async function uploadSnapshotFile(value) {
  const input = options(value, ['review', 'confirmed', 'overwriteConfirmed', 'privateCarryConfirmed']);
  if (input.confirmed !== true) return outcome('confirmation_required');
  let operation, opened;
  const risk = { refresh: false };
  try {
    const review = checkedReview(input);
    if (input.review.remoteChanged && input.overwriteConfirmed !== true)
      return outcome('overwrite_confirmation_required');
    operation = beginCloudDataOperation();
    if (!unchanged(review.original)) return outcome('state_changed_or_unsaved');
    opened = await open(input, risk);
    if (opened.status !== 'opened') return outcome(opened.status);
    if (opened.context.binding.datasetId !== review.datasetId) return outcome('binding_blocked');
    if (opened.local?.pending) return outcome('pending_upload');
    const cloud = await remote(opened, input);
    if (cloud.status !== 'ready') return outcome(cloud.status);
    if (!sameFilePin(cloud.pin, review.pin)) return outcome('remote_changed');
    if (cloud.history.privateSnapshot(cloud.pin) !== null && input.privateCarryConfirmed !== true)
      return outcome('private_confirmation_required');
    if (cloud.envelopes.length >= MAX_HISTORY_VERSIONS) return outcome('history_limit');
    const context = opened.context;
    // Self-roundtrip prevents sending a state that this application cannot restore.
    prepareFullPublicSnapshotReplace({
      localState: review.original,
      cloudSnapshot: review.snapshot,
      cryptoSource: input.cryptoSource
    });
    const sealed = await sealFileSnapshot({
      publicSnapshot: review.snapshot,
      parent: cloud.pin,
      recoveryKey: context.key.dataKey,
      datasetId: context.binding.datasetId,
      versionId: generateSyncId(input.cryptoSource),
      keyBundle: context.key.bundle,
      keyPin: context.binding.keyPin,
      privateSnapshot: cloud.history.privateSnapshot(cloud.pin),
      cryptoSource: input.cryptoSource
    });
    let fileId = null;
    if (input.provider === 'google') {
      const allocated = await opened.session.generateFileId();
      if (allocated.status !== 'generated') return outcome('unavailable_or_changed');
      fileId = allocated.fileId;
    }
    const row = {
      ...(opened.local || initialRow(review.datasetId)),
      pending: {
        phase: 'prepared',
        envelope: sealed.envelope,
        pin: sealed.pin,
        parent: cloud.pin,
        fileId,
        contentHash: review.hash
      }
    };
    const stored = await journal(review.original, input.provider, row);
    if (stored.result.status !== 'applied') return stored.result;
    reviews.delete(input.review);
    return await transmit(opened, input, row);
  } catch {
    return outcome('unavailable_or_changed');
  } finally {
    opened?.session?.dispose();
    operation?.finish(risk.refresh);
  }
}
async function transmit(opened, input, row) {
  if (row.pending.phase === 'attempting') return verifyPending(opened, input, row);
  // Recheck the latest file before sending, but do not claim cross-PC atomic CAS.
  const cloud = await remote({ ...opened, local: row }, input);
  if (cloud.status !== 'ready') return outcome(cloud.status);
  if (!sameFilePin(cloud.pin, row.pending.parent)) return outcome('remote_changed_pending');
  const original = await saved();
  if (!original) return outcome('state_changed_or_unsaved');
  if (JSON.stringify(readSnapshotFileState(original.settings, input.provider, row.datasetId)) !== JSON.stringify(row))
    return outcome('pending_changed');
  const pendingSnapshot = buildPublicSnapshot(original, {
    settingsSelections: cloud.snapshot.sections.preferences.selections
  });
  if ((await snapshotFileHash(pendingSnapshot, input.cryptoSource)) !== row.pending.contentHash)
    return outcome('prepared_local_changed');
  // Authenticate the pending envelope and its exact public hash, including after restart.
  const history = await verifyHistory({
    envelopes: [...cloud.envelopes, row.pending.envelope],
    expectedDatasetId: row.datasetId,
    root: opened.context.binding.rootPin,
    knownPins: [],
    recoveryKey: opened.context.key.dataKey,
    cryptoSource: input.cryptoSource
  });
  if (
    !history.isFileSnapshot(row.pending.pin) ||
    !sameFilePin(history.lineage(row.pending.pin).at(-2), row.pending.parent) ||
    (await snapshotFileHash(history.publicSnapshot(row.pending.pin), input.cryptoSource)) !== row.pending.contentHash
  )
    return outcome('pending_invalid');
  const attempting = { ...row, pending: { ...row.pending, phase: 'attempting' } };
  const stored = await journal(original, input.provider, attempting);
  if (stored.result.status !== 'applied') return stored.result;
  if (!unchanged(stored.candidate)) return outcome('verification_pending');
  const p = attempting.pending;
  try {
    const uploaded = await opened.session.upload({ envelope: p.envelope, ...(p.fileId ? { fileId: p.fileId } : {}) });
    if (uploaded.status === 'not_sent') {
      const current = await saved();
      if (
        !current ||
        JSON.stringify(readSnapshotFileState(current.settings, input.provider, row.datasetId)) !==
          JSON.stringify(attempting)
      )
        return outcome('pending_changed');
      const restored = await journal(current, input.provider, row);
      return restored.result.status === 'applied' ? outcome('upload_deferred') : restored.result;
    }
  } catch {
    /* No automatic retry after any unknown upload outcome. */
  }
  return verifyPending(opened, input, attempting);
}
export async function resumeSnapshotFileUpload(value) {
  const input = options(value, ['confirmed']);
  if (input.confirmed !== true) return outcome('confirmation_required');
  let operation, opened;
  const risk = { refresh: false };
  try {
    operation = beginCloudDataOperation();
    opened = await open(input, risk);
    if (opened.status !== 'opened') return outcome(opened.status);
    if (!opened.local?.pending) return outcome('idle');
    return await transmit(opened, input, opened.local);
  } catch {
    return outcome('unavailable_or_changed');
  } finally {
    opened?.session?.dispose();
    operation?.finish(risk.refresh);
  }
}
