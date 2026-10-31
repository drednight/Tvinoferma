// @ts-check
// Full-file exchange. No three-way merge, no inference of per-record tombstones.
// Existing immutable encrypted files are kept as backups. A parent only identifies
// the file the user replaced. Concurrent writes are retained, not silently lost.
import { verifyContactsSource } from '../../core/secrets.js';
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
import { object, array } from './exportSchema.js';
import {
  buildPrivateDelta,
  privateDifferences,
  applyPrivateSelection,
  mergePrivateSnapshots
} from './privateSnapshot.js';
import {
  privateSourceAvailable,
  privateConsent,
  privatePairs,
  selectPrivateDelta,
  prunePrivateSnapshot
} from './snapshotFilePrivate.js';
import {
  readSnapshotFileState,
  withSnapshotFileState,
  sameFilePin,
  snapshotFileHash,
  MAX_UNSETTLED_UPLOADS
} from './snapshotFileState.js';

const reviews = new WeakMap();
const choices = new WeakMap();
const releases = new WeakMap();
const privateExports = new WeakMap();
const privateImports = new WeakMap();
const sameHeads = (a, b) => a.length === b.length && a.every(pin => b.some(other => sameFilePin(pin, other)));
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
  const pins = new Map();
  const remember = pin => {
    if (pins.has(pin.versionId) && !sameFilePin(pins.get(pin.versionId), pin))
      throw new Error('Изменилась известная версия');
    pins.set(pin.versionId, pin);
  };
  for (const pin of legacy.confirmedPins || []) remember(pin);
  if (local?.acceptedPin) remember(local.acceptedPin);
  for (const receipt of local?.unsettled || [])
    if (envelopes.some(e => e.versionId === receipt.pin.versionId)) remember(receipt.pin);
  const history = await verifyHistory({
    envelopes,
    expectedDatasetId: context.binding.datasetId,
    root: context.binding.rootPin,
    knownPins: [...pins.values()],
    recoveryKey: context.key.dataKey,
    cryptoSource: input.cryptoSource
  });
  const heads = history.observedHeads();
  const pin = heads[0];
  return {
    status: heads.length === 1 ? 'ready' : 'multiple_files',
    heads,
    dates: listed.versions,
    history,
    pin,
    envelopes,
    snapshot: history.publicSnapshot(pin),
    modifiedAt: listed.versions.find(row => row.versionId === pin.versionId)?.modifiedAt ?? null
  };
}
function selectedCloud(cloud, pin) {
  return {
    ...cloud,
    status: 'ready',
    pin,
    snapshot: cloud.history.publicSnapshot(pin),
    modifiedAt: cloud.dates.find(row => row.versionId === pin.versionId)?.modifiedAt ?? null
  };
}
async function reviewedCloud(opened, input, review) {
  const cloud = await remote(opened, input);
  if (!sameHeads(cloud.heads, review.heads) || !cloud.heads.some(pin => sameFilePin(pin, review.pin)))
    return { status: 'remote_changed' };
  return selectedCloud(cloud, review.pin);
}
function settled(row, cloud, acceptedPin) {
  if (row.version !== 2) return row;
  return {
    ...row,
    unsettled: row.unsettled.filter(
      receipt =>
        !cloud.envelopes.some(e => e.versionId === receipt.pin.versionId) ||
        !cloud.history.covers(acceptedPin, receipt.pin)
    )
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
  const input = options(value, ['choice']);
  let operation, opened;
  const risk = { refresh: false };
  try {
    operation = beginCloudDataOperation();
    const original = await saved();
    if (!original) return outcome('state_changed_or_unsaved');
    opened = await open(input, risk);
    if (opened.status !== 'opened') return outcome(opened.status);
    let cloud = await remote(opened, input);
    if (input.choice !== undefined) {
      const choice = choices.get(input.choice);
      if (
        !choice ||
        choice.provider !== input.provider ||
        choice.datasetId !== opened.context.binding.datasetId ||
        choice.binding !== JSON.stringify(opened.context.binding) ||
        !sameHeads(choice.heads, cloud.heads)
      )
        return outcome('remote_changed');
      cloud = selectedCloud(cloud, choice.pin);
    } else if (cloud.heads.length !== 1) {
      if (!unchanged(original)) return outcome('state_changed_or_unsaved');
      const variants = cloud.heads.map(pin => {
        const choice = Object.freeze({
          pin: Object.freeze({ ...pin }),
          modifiedAt: cloud.dates.find(row => row.versionId === pin.versionId)?.modifiedAt ?? null
        });
        choices.set(choice, {
          provider: input.provider,
          datasetId: opened.context.binding.datasetId,
          binding: JSON.stringify(opened.context.binding),
          pin,
          heads: cloud.heads
        });
        return choice;
      });
      return Object.freeze({ status: 'multiple_files', provider: input.provider, choices: Object.freeze(variants) });
    }
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
      unsettled: opened.local?.unsettled?.length || 0,
      requiresResolution: cloud.heads.length > 1,
      privateOrphans: prunePrivateSnapshot(cloud.history.privateSnapshot(cloud.pin), snapshot).ids.length,
      privateCarry: cloud.history.privateSnapshot(cloud.pin) !== null,
      differences: comparePublicSnapshots({ local: snapshot, cloud: cloud.snapshot })
    });
    reviews.set(view, {
      original,
      snapshot,
      hash,
      remoteHash,
      pin: cloud.pin,
      heads: cloud.heads,
      cloudSnapshot: cloud.snapshot,
      binding: JSON.stringify(opened.context.binding),
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
    if (
      opened.context.binding.datasetId !== review.datasetId ||
      JSON.stringify(opened.context.binding) !== review.binding
    )
      return outcome('binding_blocked');
    if (opened.local?.pending) return outcome('pending_upload');
    const cloud = await reviewedCloud(opened, input, review);
    if (cloud.status !== 'ready') return outcome(cloud.status);
    const prepared = prepareFullPublicSnapshotReplace({
      localState: review.original,
      cloudSnapshot: cloud.snapshot,
      cryptoSource: input.cryptoSource
    });
    const candidate = prepared.candidateState();
    candidate.settings = withSnapshotFileState(
      candidate.settings,
      input.provider,
      settled(
        {
          ...(opened.local || initialRow(review.datasetId)),
          acceptedPin: cloud.pin,
          acceptedHash: review.remoteHash
        },
        cloud,
        cloud.pin
      )
    );
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
  const lineage = cloud.history.lineage(p.pin);
  if (
    !cloud.history.isFileSnapshot(p.pin) ||
    !sameFilePin(lineage.at(-2), p.parent) ||
    !sameHeads(cloud.history.replacedHeads(p.pin), p.replacedHeads || []) ||
    (await snapshotFileHash(cloud.history.publicSnapshot(p.pin), input.cryptoSource)) !== p.contentHash
  )
    return outcome('pending_invalid');
  const original = await saved();
  if (!original) return outcome('state_changed_or_unsaved');
  const current = readSnapshotFileState(original.settings, input.provider, row.datasetId);
  if (JSON.stringify(current) !== JSON.stringify(row)) return outcome('pending_changed');
  const done = await journal(
    original,
    input.provider,
    settled(
      {
        ...row,
        pending: null,
        acceptedPin: p.pin,
        acceptedHash: p.contentHash
      },
      cloud,
      p.pin
    )
  );
  return done.result.status === 'applied'
    ? outcome(
        cloud.heads.length > 1
          ? 'sent_with_conflicts'
          : sameFilePin(cloud.heads[0], p.pin)
            ? 'sent_verified'
            : 'sent_remote_advanced'
      )
    : done.result;
}

/** Saves encrypted pending bytes BEFORE the single upload. Unknown uploads are verify-only. */
export async function uploadSnapshotFile(value) {
  const input = options(value, [
    'review',
    'confirmed',
    'overwriteConfirmed',
    'privateCarryConfirmed',
    'resolutionConfirmed',
    'useCloudFile',
    'privateExport',
    'privateSelections',
    'privatePruningConfirmed'
  ]);
  if (input.confirmed !== true) return outcome('confirmation_required');
  let operation, opened;
  const risk = { refresh: false };
  try {
    const review = checkedReview(input);
    const secretExport = input.privateExport === undefined ? null : privateExports.get(input.privateExport);
    if (
      input.privateExport !== undefined &&
      (!secretExport || secretExport.review !== input.review || input.useCloudFile === true)
    )
      return outcome('private_review_changed');
    if (input.privateSelections !== undefined && !secretExport) return outcome('private_review_changed');
    if (secretExport && !privateSourceAvailable(review.original)) return outcome('private_source_unavailable');
    const selectedSecrets = secretExport ? privatePairs(input.privateSelections, secretExport.rows) : null;
    if (input.useCloudFile !== undefined && input.useCloudFile !== true) throw new Error('Некорректный выбор файла');
    if (input.useCloudFile === true && !input.review.requiresResolution) return outcome('selection_required');
    if (input.review.requiresResolution && input.resolutionConfirmed !== true)
      return outcome('resolution_confirmation_required');
    if (input.review.remoteChanged && input.overwriteConfirmed !== true)
      return outcome('overwrite_confirmation_required');
    operation = beginCloudDataOperation();
    if (!unchanged(review.original)) return outcome('state_changed_or_unsaved');
    opened = await open(input, risk);
    if (opened.status !== 'opened') return outcome(opened.status);
    if (
      opened.context.binding.datasetId !== review.datasetId ||
      JSON.stringify(opened.context.binding) !== review.binding
    )
      return outcome('binding_blocked');
    if (opened.local?.pending) return outcome('pending_upload');
    const cloud = await reviewedCloud(opened, input, review);
    if (cloud.status !== 'ready') return outcome(cloud.status);
    if (cloud.history.privateSnapshot(cloud.pin) !== null && input.privateCarryConfirmed !== true)
      return outcome('private_confirmation_required');
    if (cloud.envelopes.length >= MAX_HISTORY_VERSIONS) return outcome('history_limit');
    const context = opened.context;
    const snapshot = input.useCloudFile === true ? review.cloudSnapshot : review.snapshot;
    const contentHash = input.useCloudFile === true ? review.remoteHash : review.hash;
    const replacedHeads = cloud.heads.filter(pin => !sameFilePin(pin, cloud.pin));
    const prior = cloud.history.privateSnapshot(cloud.pin);
    const pruned = prunePrivateSnapshot(prior, snapshot);
    if (pruned.ids.length && input.privatePruningConfirmed !== true)
      return outcome('private_pruning_confirmation_required');
    if (
      secretExport &&
      (!privateSourceAvailable(currentCloudStateSnapshot()) || !(await verifyContactsSource(review.original)))
    )
      return outcome('private_source_unavailable');
    const privateSnapshot = secretExport
      ? mergePrivateSnapshots(
          pruned.snapshot,
          selectPrivateDelta(secretExport.delta, snapshot, selectedSecrets),
          snapshot
        )
      : pruned.snapshot;

    // Self-roundtrip prevents sending a state that this application cannot restore.
    prepareFullPublicSnapshotReplace({
      localState: review.original,
      cloudSnapshot: snapshot,
      cryptoSource: input.cryptoSource
    });
    const sealed = await sealFileSnapshot({
      publicSnapshot: snapshot,
      parent: cloud.pin,
      ...(replacedHeads.length ? { replacedHeads } : {}),
      recoveryKey: context.key.dataKey,
      datasetId: context.binding.datasetId,
      versionId: generateSyncId(input.cryptoSource),
      keyBundle: context.key.bundle,
      keyPin: context.binding.keyPin,
      privateSnapshot,
      ...(pruned.ids.length ? { privatePrunedIds: pruned.ids } : {}),
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
        contentHash,
        ...(input.useCloudFile === true ? { localHash: review.hash } : {}),
        ...(replacedHeads.length ? { replacedHeads } : {})
      }
    };
    const stored = await journal(review.original, input.provider, row);
    if (stored.result.status !== 'applied') return stored.result;
    reviews.delete(input.review);
    if (input.privateExport) privateExports.delete(input.privateExport);
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
  if (!sameHeads(cloud.heads, [row.pending.parent, ...(row.pending.replacedHeads || [])]))
    return outcome('remote_changed_pending');
  const original = await saved();
  if (!original) return outcome('state_changed_or_unsaved');
  if (JSON.stringify(readSnapshotFileState(original.settings, input.provider, row.datasetId)) !== JSON.stringify(row))
    return outcome('pending_changed');
  const pendingSnapshot = buildPublicSnapshot(original, {
    settingsSelections: cloud.history.publicSnapshot(row.pending.parent).sections.preferences.selections
  });
  if (
    (await snapshotFileHash(pendingSnapshot, input.cryptoSource)) !== (row.pending.localHash ?? row.pending.contentHash)
  )
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
    !sameHeads(history.replacedHeads(row.pending.pin), row.pending.replacedHeads || []) ||
    !sameHeads(history.observedHeads(), [row.pending.pin]) ||
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

/** Inspect local pending bytes without sending, cancelling or changing the cloud. */
export async function inspectSnapshotFileUpload(value) {
  const input = options(value);
  let operation;
  try {
    operation = beginCloudDataOperation();
    const original = await saved();
    if (!original) return outcome('state_changed_or_unsaved');
    const context = await openConnectedPublicationContext(input);
    if (!context) return outcome('binding_blocked');
    const row = readSnapshotFileState(original.settings, input.provider, context.binding.datasetId);
    if (!row?.pending) return outcome('idle');
    const p = row.pending;
    if (
      !sameFilePin(
        await historyEnvelopePin({
          envelope: p.envelope,
          expectedDatasetId: row.datasetId,
          cryptoSource: input.cryptoSource
        }),
        p.pin
      )
    )
      return outcome('pending_invalid');
    if (!unchanged(original)) return outcome('state_changed_or_unsaved');
    const view = Object.freeze({
      status: 'pending',
      provider: input.provider,
      phase: p.phase,
      pin: Object.freeze({ ...p.pin })
    });
    releases.set(view, { original, row, binding: JSON.stringify(context.binding) });
    return view;
  } catch {
    return outcome('unavailable_or_changed');
  } finally {
    operation?.finish(false);
  }
}
/** Cancels only local preparation. Unknown attempts are explicitly released, never called cancelled. */
export async function releaseSnapshotFileUpload(value) {
  const input = options(value, ['review', 'confirmed', 'unknownOutcomeAcknowledged']);
  if (input.confirmed !== true) return outcome('confirmation_required');
  let operation;
  try {
    const review = releases.get(input.review);
    if (!review || input.review.provider !== input.provider) return outcome('pending_changed');
    if (review.row.pending.phase === 'attempting' && input.unknownOutcomeAcknowledged !== true)
      return outcome('unknown_acknowledgement_required');
    operation = beginCloudDataOperation();
    const original = await saved();
    if (!original || !unchanged(review.original) || JSON.stringify(original) !== JSON.stringify(review.original))
      return outcome('state_changed_or_unsaved');
    const context = await openConnectedPublicationContext(input);
    if (!context || JSON.stringify(context.binding) !== review.binding) return outcome('binding_blocked');
    const row = readSnapshotFileState(original.settings, input.provider, context.binding.datasetId);
    if (JSON.stringify(row) !== JSON.stringify(review.row)) return outcome('pending_changed');
    let next = { ...row, pending: null };
    const unknown = row.pending.phase === 'attempting';
    if (unknown) {
      const unsettled = [...(row.unsettled || [])];
      if (unsettled.length >= MAX_UNSETTLED_UPLOADS) return outcome('unsettled_limit');
      const { pin, parent, fileId, contentHash } = row.pending;
      unsettled.push({ pin, parent, fileId, contentHash });
      next = { ...next, version: 2, unsettled };
    }
    const stored = await journal(original, input.provider, next, 'pre-cloud-file-release');
    if (stored.result.status !== 'applied') return stored.result;
    releases.delete(input.review);
    return outcome(unknown ? 'pending_released_uncertain' : 'prepared_cancelled');
  } catch {
    return outcome('unavailable_or_changed');
  } finally {
    operation?.finish(false);
  }
}

/** Explicit, one-batch local export capability. Values never leave this module unencrypted. */
export async function prepareSnapshotFilePrivateExport(value) {
  const input = options(value, ['review', 'fields', 'contactsSourceConfirmed', 'acknowledgePasswordRisk']);
  // Capture category consent before any await; a caller cannot add password later.
  if (!Array.isArray(input.fields)) return outcome('private_consent_required');
  input.fields = array(input.fields, field => field);
  if (!privateConsent(input, input.fields)) return outcome('private_consent_required');
  let operation;
  try {
    const review = checkedReview(input);
    if (input.review.requiresResolution) return outcome('multiple_files');
    operation = beginCloudDataOperation();
    const original = await saved();
    if (!original || JSON.stringify(original) !== JSON.stringify(review.original))
      return outcome('state_changed_or_unsaved');
    if (!privateSourceAvailable(original) || !(await verifyContactsSource(original)))
      return outcome('private_source_unavailable');
    const delta = buildPrivateDelta(original, review.snapshot, input.fields);
    const chars = new Map([...original.characters, ...original.archivedCharacters].map(row => [row.syncId, row]));
    const rows = delta.records.flatMap(row =>
      Object.entries(row.fields).map(([field, value]) =>
        Object.freeze({
          characterId: row.characterId,
          field,
          label: chars.get(row.characterId).nick,
          clears: value === '',
          localPresent: value !== '',
          selectable: true
        })
      )
    );
    const view = Object.freeze({
      status: 'private_export_review',
      fields: Object.freeze([...input.fields]),
      rows: Object.freeze(rows),
      cancel() {
        privateExports.delete(view);
      }
    });
    privateExports.set(view, { review: input.review, delta, rows });
    return view;
  } catch {
    return outcome('unavailable_or_changed');
  } finally {
    operation?.finish(false);
  }
}
/** Authenticated private comparison. Only presence/clearing facts, never values, are returned. */
export async function checkSnapshotFilePrivate(value) {
  const input = options(value, ['review', 'fields', 'contactsSourceConfirmed', 'acknowledgePasswordRisk']);
  // Capture category consent before any await; a caller cannot add password later.
  if (!Array.isArray(input.fields)) return outcome('private_consent_required');
  input.fields = array(input.fields, field => field);
  if (!privateConsent(input, input.fields)) return outcome('private_consent_required');
  let operation, opened;
  const risk = { refresh: false };
  try {
    const review = checkedReview(input);
    if (input.review.requiresResolution) return outcome('multiple_files');
    operation = beginCloudDataOperation();
    const original = await saved();
    if (!original || JSON.stringify(original) !== JSON.stringify(review.original))
      return outcome('state_changed_or_unsaved');
    if (!privateSourceAvailable(original) || !(await verifyContactsSource(original)))
      return outcome('private_source_unavailable');
    opened = await open(input, risk);
    if (opened.status !== 'opened') return outcome(opened.status);
    if (JSON.stringify(opened.context.binding) !== review.binding) return outcome('binding_blocked');
    const cloud = await reviewedCloud(opened, input, review);
    if (cloud.status !== 'ready') return outcome(cloud.status);
    const snapshot = cloud.history.privateSnapshot(cloud.pin);
    const rows = privateDifferences(snapshot, cloud.snapshot, original, input.fields).map(row =>
      Object.freeze({ ...row })
    );
    if (!unchanged(original)) return outcome('state_changed_or_unsaved');
    const view = Object.freeze({
      status: 'private_ready',
      pin: Object.freeze({ ...cloud.pin }),
      fields: Object.freeze([...input.fields]),
      rows: Object.freeze(rows),
      cancel() {
        privateImports.delete(view);
      }
    });
    privateImports.set(view, { original, review, snapshot, rows });
    return view;
  } catch {
    return outcome('unavailable_or_changed');
  } finally {
    opened?.session?.dispose();
    operation?.finish(risk.refresh);
  }
}
/** Manual-only fields: does NOT accept the public file or advance its baseline. */
export async function applySnapshotFilePrivate(value) {
  const input = options(value, [
    'review',
    'selections',
    'confirmed',
    'contactsSourceConfirmed',
    'independentBackupConfirmed',
    'acknowledgePasswordRisk'
  ]);
  if (input.confirmed !== true) return outcome('confirmation_required');
  if (input.independentBackupConfirmed !== true) return outcome('private_backup_required');
  let operation, opened;
  const risk = { refresh: false };
  try {
    const held = privateImports.get(input.review);
    if (!held) return outcome('private_review_changed');
    const selected = privatePairs(input.selections, held.rows);
    if (!privateConsent(input, [...new Set(selected.map(row => row.field))]))
      return outcome('private_consent_required');
    operation = beginCloudDataOperation();
    const original = await saved();
    if (!original || JSON.stringify(original) !== JSON.stringify(held.original))
      return outcome('state_changed_or_unsaved');
    if (!privateSourceAvailable(original) || !(await verifyContactsSource(original)))
      return outcome('private_source_unavailable');
    opened = await open(input, risk);
    if (opened.status !== 'opened') return outcome(opened.status);
    if (opened.local?.pending) return outcome('pending_upload');
    if (JSON.stringify(opened.context.binding) !== held.review.binding) return outcome('binding_blocked');
    const cloud = await reviewedCloud(opened, input, held.review);
    if (cloud.status !== 'ready') return outcome(cloud.status);
    const candidate = applyPrivateSelection(
      cloud.history.privateSnapshot(cloud.pin),
      cloud.snapshot,
      original,
      selected
    );
    candidate.settings = withSnapshotFileState(
      candidate.settings,
      input.provider,
      opened.local || initialRow(opened.context.binding.datasetId)
    );
    if (!privateSourceAvailable(currentCloudStateSnapshot())) return outcome('private_source_unavailable');
    const result = await stageGuardedCloudStateWrite({
      original,
      candidate,
      backupLabel: 'pre-cloud-file-private-apply',
      selectedCount: selected.length
    }).commit({ confirmed: true });
    if (result.status === 'applied') privateImports.delete(input.review);
    return result;
  } catch {
    return outcome('unavailable_or_changed');
  } finally {
    opened?.session?.dispose();
    operation?.finish(risk.refresh);
  }
}
