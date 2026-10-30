// @ts-check
// Narrow, explicitly confirmed three-way merge, including supported template
// additions, selected settings and authenticated manual-planner tombstones. The state marker is saved with backup BEFORE the queue anchor changes;
// it blocks publishing and makes interruptions resumable. An unattempted matching
// queue item is retained encrypted until a merged child is verified. This is not a
// cross-process transaction or proof of a complete cloud.
import { forgetLoadedState, loadData } from '../../core/storage.js';
import { object } from './exportSchema.js';
import { generateSyncId } from './envelope.js';
import { comparePublicSnapshots } from './compareSnapshots.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { preparePublicSnapshotApply } from './applyPublicSnapshot.js';
import { prepareCloudReview } from './cloudReview.js';
import {
  currentCloudStateSnapshot,
  cloudSnapshotMatchesDisk,
  stageGuardedCloudStateWrite
} from './guardedStateWrite.js';
import {
  requireResolvedSelectiveApply,
  pendingSelectiveApplyEvents,
  removePendingSelectiveApply
} from './pendingSelectiveApply.js';
import {
  addPendingConservativeMerge,
  mergeRetainsAppliedIntent,
  conservativeSnapshotHash,
  readPendingConservativeMerge,
  removePendingConservativeMerge
} from './pendingConservativeMerge.js';
import { authorizeSavedConservativeMerge } from './conservativeMergeAuthorization.js';
import { conservativeConflictReviewHash, parseConservativeMergeChoices } from './conservativeMergeChoices.js';
import { replaceAcceptedCloudBase, requireMatchingCloudBase } from './acceptedCloudBase.js';
import { openConnectedPublicationContext } from './connectedPublication.js';
import { openPinnedNativeCloudSession } from './providers/pinnedNativeCloudSession.js';
import { beginCloudDataOperation } from './credentialResetCoordination.js';

const NO_NETWORK = Object.freeze({
  async generateFileId() {
    throw new Error('not connected');
  },
  async upload() {
    throw new Error('not connected');
  },
  async verify() {
    throw new Error('not connected');
  }
});
function result(status, extra = {}) {
  return Object.freeze({ status, ...extra });
}
function samePin(left, right, key = 'versionId') {
  return !!left && !!right && left[key] === right[key] && left.sha256 === right.sha256;
}
function sameBase(left, right) {
  return left === null && right === null
    ? true
    : !!left && !!right && left.anchorId === right.anchorId && samePin(left.pin, right.pin);
}
function sameIntents(left, right) {
  return (
    left.length === right.length &&
    left.every((item, index) => samePin(item.pin, right[index].pin) && item.phase === right[index].phase)
  );
}
function resolutionFitsConflicts(choices, conflicts) {
  if (conflicts.some(conflict => conflict.reason === 'concurrent-order')) return false;
  const records = new Set(
    conflicts.filter(row => row.id && row.section !== 'preferences').map(row => `${row.section}:${row.id}`)
  );
  const settings = new Set(conflicts.filter(row => row.section === 'preferences').map(row => row.id));
  const finance = conflicts.some(row => row.section === 'finance' && !row.id);
  return (
    choices.cloudRecords.every(row => records.has(`${row.section}:${row.id}`)) &&
    choices.cloudSettings.every(group => settings.has(group)) &&
    (!choices.cloudFinanceSettings || finance)
  );
}
function matchesState(settings, context, base) {
  try {
    requireMatchingCloudBase(settings, {
      provider: context.provider,
      datasetId: context.binding.datasetId,
      adoptedBase: base
    });
    return true;
  } catch {
    return false;
  }
}
async function stillSaved(snapshot) {
  let loaded = null;
  try {
    if (JSON.stringify(currentCloudStateSnapshot()) !== JSON.stringify(snapshot)) return false;
    loaded = await loadData();
    return (
      JSON.stringify(currentCloudStateSnapshot()) === JSON.stringify(snapshot) &&
      cloudSnapshotMatchesDisk(snapshot, loaded)
    );
  } finally {
    if (loaded) forgetLoadedState(loaded);
  }
}
function materialize(original, plan, cryptoSource) {
  const merged = plan.snapshot();
  const prepared = preparePublicSnapshotApply({
    localState: original,
    cloudSnapshot: merged,
    selectedRecords: plan.selectedRecords(),
    selectedSettings: plan.selectedSettings(),
    selectedPlannerDeletions: plan.selectedPlannerDeletions?.() || [],
    includeFinanceSettings: plan.includeFinanceSettings,
    ...(cryptoSource ? { cryptoSource } : {})
  });
  const difference = comparePublicSnapshots({ local: merged, cloud: prepared.candidatePublicSnapshot() });
  if (difference.entries.length || difference.uncomparedSettings.length) throw new Error('Несовпадение кандидата');
  return prepared.candidateState();
}

/**
 * Repeats all checks against the exact pin, even if the UI already displayed it.
 * With a saved marker the same request resumes; no new choice is inferred by time.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,pin:any,confirmed:boolean,
 * settingsSelections?:string[],resolution?:any,privateCarryConfirmed?:boolean,cryptoSource?:Crypto,timeoutMs?:number,now?:()=>number,signal?:AbortSignal,openSession?:Function}} options
 */
export async function reconcileConservativeMerge(options) {
  const input = object(
    options,
    ['provider', 'invoke', 'pin', 'confirmed'],
    [
      'settingsSelections',
      'resolution',
      'privateCarryConfirmed',
      'cryptoSource',
      'timeoutMs',
      'now',
      'signal',
      'openSession'
    ]
  );
  if (
    !['google', 'yandex'].includes(input.provider) ||
    typeof input.invoke !== 'function' ||
    input.confirmed !== true ||
    (input.settingsSelections !== undefined && !Array.isArray(input.settingsSelections)) ||
    (input.privateCarryConfirmed !== undefined && typeof input.privateCarryConfirmed !== 'boolean') ||
    (input.openSession !== undefined && typeof input.openSession !== 'function') ||
    (input.now !== undefined && typeof input.now !== 'function') ||
    (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== 'boolean'))
  )
    throw new Error('Не удалось безопасно объединить изменения');
  const suppliedResolution = input.resolution === undefined ? null : parseConservativeMergeChoices(input.resolution);
  const targetPin = structuredClone(input.pin);
  const requestedSettings = input.settingsSelections ? [...input.settingsSelections] : [];
  let operation;
  let session = null;
  let uncertain = false;
  try {
    operation = beginCloudDataOperation();
    if (input.signal?.aborted) return result('cancelled');
    const context = await openConnectedPublicationContext(input);
    if (!context) return result('binding_or_queue_blocked');
    let original = currentCloudStateSnapshot();
    let marker = readPendingConservativeMerge(original.settings);
    const appliedEvents = pendingSelectiveApplyEvents(original.settings);
    if (marker) {
      if (
        marker.provider !== context.provider ||
        marker.datasetId !== context.binding.datasetId ||
        !samePin(marker.targetPin, targetPin)
      )
        return result('other_merge_pending');
      if (appliedEvents.length && !mergeRetainsAppliedIntent(marker)) return result('unresolved_sources');
      if (mergeRetainsAppliedIntent(marker) && !appliedEvents.length) return result('unresolved_sources');
    } else if (!appliedEvents.length) {
      requireResolvedSelectiveApply(original.settings);
    }
    if (
      marker &&
      suppliedResolution &&
      JSON.stringify(suppliedResolution) !== JSON.stringify(marker.resolution || null)
    )
      return result('merge_intent_mismatch');
    if (
      marker &&
      input.privateCarryConfirmed !== undefined &&
      input.privateCarryConfirmed !== (marker.privateCarryConfirmed === true)
    )
      return result('merge_intent_mismatch');
    const privateCarryConfirmed = marker ? marker.privateCarryConfirmed === true : input.privateCarryConfirmed === true;
    const resolution = marker?.resolution || suppliedResolution;
    if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
    let local;
    try {
      local = buildPublicSnapshot(original, { settingsSelections: requestedSettings });
    } catch {
      return result('data_unprepared');
    }
    const queue = context.queue(NO_NETWORK);
    const head = await queue.inspectLinearHead({ ...context.pins, publicSnapshot: local });
    if (head.status !== 'ready') return result(head.status);
    if (head.privateIntentPending) return result('private_transfer_pending');
    if (!head.confirmedPin) return result('no_local_lineage');
    if (head.retainedIntents.length >= 16 && head.pendingCount) return result('retained_intent_limit');
    if (head.pendingCount && (head.pendingCount !== 1 || !['queued', 'prepared'].includes(head.nextPhase)))
      return result('queue_not_empty');
    if (head.pendingCount && !head.tailMatches && !appliedEvents.length) return result('queue_snapshot_mismatch');
    if (
      JSON.stringify(head.settingsSelections) !== JSON.stringify(requestedSettings) ||
      (marker && JSON.stringify(marker.settingsSelections) !== JSON.stringify(head.settingsSelections))
    )
      return result('settings_mismatch');
    const resumedAfterAnchor =
      !!marker &&
      !!head.adoptedBase &&
      samePin(head.adoptedBase.pin, marker.targetPin) &&
      samePin(head.tailPin, marker.targetPin);
    const basePin = marker ? marker.basePin : head.confirmedPin;
    const previousBase = marker ? marker.previousBase : head.adoptedBase;
    if (!matchesState(original.settings, context, previousBase)) return result('accepted_base_mismatch');
    if (marker) {
      if (resumedAfterAnchor) {
        const expectedRetained = [...marker.retainedIntents];
        if (marker.pendingPin) expectedRetained.push({ pin: marker.pendingPin, phase: marker.pendingPhase });
        const retainedMatches = sameIntents(head.retainedIntents, expectedRetained);
        if (
          !retainedMatches ||
          !samePin(head.priorConfirmedPin, marker.basePin) ||
          !sameBase(head.previousBase, marker.previousBase)
        )
          return result('merge_base_mismatch');
      } else if (
        head.revisionId !== marker.queueRevisionId ||
        !samePin(head.confirmedPin, marker.basePin) ||
        !sameBase(head.adoptedBase, marker.previousBase) ||
        !sameIntents(head.retainedIntents, marker.retainedIntents) ||
        (marker.pendingPin
          ? !samePin(head.nextPin, marker.pendingPin) || head.nextPhase !== marker.pendingPhase
          : !!head.nextPin)
      ) {
        return result('merge_base_mismatch');
      }
    }
    let appliedIntentSnapshot = null;
    if (appliedEvents.length) {
      const sourcePin = marker?.pendingPin || head.nextPin;
      if (!sourcePin) return result('unresolved_sources');
      const intent = /** @type {any} */ (
        await queue.readConservativeIntent({ ...context.pins, expectedRevisionId: head.revisionId, pin: sourcePin })
      );
      if (intent.status !== 'ready') return result(intent.status);
      appliedIntentSnapshot = intent.snapshot();
      if (
        mergeRetainsAppliedIntent(marker) &&
        (await conservativeSnapshotHash(appliedIntentSnapshot, input.cryptoSource)) !== marker.appliedIntentHash
      )
        return result('merge_intent_mismatch');
    }
    if (input.signal?.aborted) return result('cancelled');
    uncertain = context.provider === 'google';
    const opened = /** @type {any} */ (
      await (input.openSession || openPinnedNativeCloudSession)({
        provider: context.provider,
        ...context.keyOptions,
        ...(input.now ? { now: input.now } : {})
      })
    );
    if (opened.status !== 'opened') return result(opened.status || 'unavailable');
    uncertain = false;
    session = opened.session;
    if (
      opened.datasetId !== context.binding.datasetId ||
      !samePin(opened.keyPin, context.binding.keyPin, 'bundleId') ||
      !samePin(opened.rootPin, context.binding.rootPin)
    )
      return result('binding_or_queue_blocked');
    const review = async knownPins =>
      /** @type {any} */ (
        await prepareCloudReview({
          provider: context.provider,
          session,
          datasetId: context.binding.datasetId,
          dataKey: context.key.dataKey,
          rootPin: context.binding.rootPin,
          knownPins,
          localSnapshot: local,
          localSavedAt: null,
          ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
          ...(input.now ? { now: input.now } : {}),
          ...(input.signal ? { signal: input.signal } : {})
        })
      );
    const first = await review(head.confirmedPins);
    if (first.status !== 'ready_for_review') return result(first.status);
    const unchecked = first.prepareConservativeAdoption(
      targetPin,
      basePin,
      original.settings,
      !!marker,
      undefined,
      appliedIntentSnapshot,
      privateCarryConfirmed
    );
    let proof = unchecked;
    if (unchecked.status === 'conflicts') {
      const localHash = await conservativeSnapshotHash(local, input.cryptoSource);
      const reviewHash = await conservativeConflictReviewHash(
        {
          provider: context.provider,
          datasetId: context.binding.datasetId,
          basePin,
          targetPin,
          queueRevisionId: marker?.queueRevisionId || head.revisionId,
          localHash,
          settingsSelections: head.settingsSelections,
          conflicts: unchecked.conflicts
        },
        input.cryptoSource
      );
      if (!resolution) {
        if (marker) return result('merge_intent_mismatch');
        if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
        const sameQueue = await queue.inspectLinearHead(context.pins);
        if (sameQueue.status !== 'ready' || sameQueue.revisionId !== head.revisionId) return result('queue_changed');
        return result('conflicts', {
          conflictCount: unchecked.conflicts.length,
          reviewHash,
          conflicts: structuredClone(unchecked.conflicts)
        });
      }
      if (resolution.reviewHash !== reviewHash || !resolutionFitsConflicts(resolution, unchecked.conflicts))
        return result('conflicts_changed');
      proof = first.prepareConservativeAdoption(
        targetPin,
        basePin,
        original.settings,
        !!marker,
        resolution,
        appliedIntentSnapshot,
        privateCarryConfirmed
      );
    } else if (resolution) {
      return result(unchecked.status === 'ready_for_adoption' ? 'conflicts_changed' : unchecked.status);
    }
    if (proof.status !== 'ready_for_adoption') return result(proof.status);
    try {
      materialize(original, proof.plan(), input.cryptoSource);
    } catch {
      return result('candidate_unrepresentable');
    }
    if (input.signal?.aborted) return result('cancelled');
    if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
    const before = await queue.inspectLinearHead(context.pins);
    if (before.status !== 'ready' || before.revisionId !== head.revisionId) return result('queue_changed');
    if (!marker) {
      marker = {
        version: proof.privateCarryConfirmed ? 4 : appliedIntentSnapshot ? 3 : resolution ? 2 : 1,
        operationId: generateSyncId(input.cryptoSource),
        provider: context.provider,
        datasetId: context.binding.datasetId,
        basePin,
        targetPin: proof.pin,
        previousBase,
        queueRevisionId: head.revisionId,
        pendingPin: head.nextPin,
        pendingPhase: head.nextPhase,
        retainedIntents: head.retainedIntents,
        settingsSelections: [...head.settingsSelections],
        localHash: await conservativeSnapshotHash(local, input.cryptoSource),
        mergedHash: await conservativeSnapshotHash(proof.plan().snapshot(), input.cryptoSource),
        ...(proof.privateCarryConfirmed
          ? {
              privateCarryConfirmed: true,
              resolution: resolution || null,
              appliedIntentHash: appliedIntentSnapshot
                ? await conservativeSnapshotHash(appliedIntentSnapshot, input.cryptoSource)
                : null
            }
          : appliedIntentSnapshot
            ? {
                resolution: resolution || null,
                appliedIntentHash: await conservativeSnapshotHash(appliedIntentSnapshot, input.cryptoSource)
              }
            : resolution
              ? { resolution }
              : {})
      };
      const checkpoint = structuredClone(original);
      checkpoint.settings = addPendingConservativeMerge(checkpoint.settings, marker);
      const staged = stageGuardedCloudStateWrite({
        original,
        candidate: checkpoint,
        backupLabel: 'pre-cloud-merge-intent',
        selectedCount: 0
      });
      const saved = /** @type {any} */ (await staged.commit({ confirmed: true }));
      if (saved.status !== 'applied') return result(saved.status);
      original = currentCloudStateSnapshot();
    }
    if (input.signal?.aborted) return result('cancelled_with_merge_pending');
    const authorization = await authorizeSavedConservativeMerge({ proof, cryptoSource: input.cryptoSource });
    if (!authorization) return result('merge_intent_mismatch');
    const adopted = await queue.adoptReviewedBase({ ...context.pins, proof, authorization });
    uncertain = adopted.status === 'journal_uncertain';
    if (!['adopted', 'already_adopted'].includes(adopted.status)) return result(adopted.status);
    const fixed = await queue.inspectLinearHead(context.pins);
    const expectedRetained = [...marker.retainedIntents];
    if (marker.pendingPin) expectedRetained.push({ pin: marker.pendingPin, phase: marker.pendingPhase });
    if (
      fixed.status !== 'ready' ||
      fixed.nextPin ||
      !fixed.adoptedBase ||
      !samePin(fixed.tailPin, proof.pin) ||
      !samePin(fixed.confirmedPin, proof.pin) ||
      !samePin(fixed.priorConfirmedPin, marker.basePin) ||
      !sameBase(fixed.previousBase, marker.previousBase) ||
      !sameIntents(fixed.retainedIntents, expectedRetained)
    )
      return result('queue_changed');
    if (input.signal?.aborted) return result('cancelled_with_merge_pending');
    const again = await review(fixed.confirmedPins);
    if (again.status !== 'ready_for_review') return result('cloud_changed_after_checkpoint');
    const repeated = again.prepareConservativeAdoption(
      targetPin,
      marker.basePin,
      original.settings,
      true,
      marker.resolution,
      appliedIntentSnapshot,
      privateCarryConfirmed
    );
    if (
      repeated.status !== 'ready_for_adoption' ||
      (await conservativeSnapshotHash(repeated.plan().snapshot(), input.cryptoSource)) !== marker.mergedHash
    )
      return result('cloud_changed_after_checkpoint');
    if (!(await stillSaved(original))) return result('state_changed_after_checkpoint');
    const current = await queue.inspectLinearHead(context.pins);
    if (current.status !== 'ready' || current.revisionId !== fixed.revisionId) return result('queue_changed');
    let candidate;
    try {
      candidate = materialize(original, repeated.plan(), input.cryptoSource);
      candidate.settings = removePendingConservativeMerge(candidate.settings, marker.operationId);
      if (mergeRetainsAppliedIntent(marker)) candidate.settings = removePendingSelectiveApply(candidate.settings);
      candidate.settings = replaceAcceptedCloudBase(
        candidate.settings,
        {
          version: 1,
          provider: context.provider,
          datasetId: context.binding.datasetId,
          pin: fixed.adoptedBase.pin,
          anchorId: fixed.adoptedBase.anchorId
        },
        marker.previousBase
      );
    } catch {
      return result('candidate_unrepresentable');
    }
    const staged = stageGuardedCloudStateWrite({
      original,
      candidate,
      backupLabel: 'pre-cloud-merge',
      selectedCount: repeated.plan().selectedCount
    });
    const committed = /** @type {any} */ (await staged.commit({ confirmed: true }));
    if (committed.status !== 'applied') return result(committed.status);
    const observedHead = again.versions.find(version => version.observedHead);
    return result('merged', {
      backup: committed.backup,
      selectedCount: committed.selectedCount,
      newerHeadObserved: !!observedHead && !samePin(observedHead.pin, proof.pin)
    });
  } catch {
    return result('unavailable_or_busy');
  } finally {
    try {
      session?.dispose?.();
    } finally {
      operation?.finish(uncertain);
    }
  }
}

/**
 * Cancels only while the original outbox revision and accepted base are still
 * intact. Once the anchor changed, only a verified resume may clear the marker.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,confirmed:boolean,cryptoSource?:Crypto,timeoutMs?:number}} options
 */
export async function cancelPendingConservativeMerge(options) {
  const input = object(options, ['provider', 'invoke', 'confirmed'], ['cryptoSource', 'timeoutMs']);
  if (!['google', 'yandex'].includes(input.provider) || typeof input.invoke !== 'function' || input.confirmed !== true)
    throw new Error('Не удалось безопасно отменить объединение');
  let operation;
  try {
    operation = beginCloudDataOperation();
    const context = await openConnectedPublicationContext(input);
    if (!context) return result('binding_or_queue_blocked');
    const original = currentCloudStateSnapshot();
    const marker = readPendingConservativeMerge(original.settings);
    if (!marker) return result('no_merge_pending');
    if (marker.provider !== context.provider || marker.datasetId !== context.binding.datasetId)
      return result('other_merge_pending');
    if (!matchesState(original.settings, context, marker.previousBase)) return result('accepted_base_mismatch');
    if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
    const queue = context.queue(NO_NETWORK);
    const head = await queue.inspectLinearHead(context.pins);
    if (head.status !== 'ready') return result(head.status);
    if (head.privateIntentPending) return result('private_transfer_pending');
    if (
      head.revisionId !== marker.queueRevisionId ||
      !sameIntents(head.retainedIntents, marker.retainedIntents) ||
      (marker.pendingPin
        ? head.pendingCount !== 1 || !samePin(head.nextPin, marker.pendingPin) || head.nextPhase !== marker.pendingPhase
        : !!head.nextPin || !!head.pendingCount) ||
      !samePin(head.confirmedPin, marker.basePin) ||
      !sameBase(head.adoptedBase, marker.previousBase)
    )
      return result('already_anchored');
    const again = await queue.inspectLinearHead(context.pins);
    if (again.status !== 'ready' || again.revisionId !== head.revisionId || !(await stillSaved(original)))
      return result('queue_changed');
    const candidate = structuredClone(original);
    candidate.settings = removePendingConservativeMerge(candidate.settings, marker.operationId);
    const staged = stageGuardedCloudStateWrite({
      original,
      candidate,
      backupLabel: 'pre-cloud-cancel-merge',
      selectedCount: 0
    });
    const saved = /** @type {any} */ (await staged.commit({ confirmed: true }));
    return saved.status === 'applied' ? result('merge_cancelled', { backup: saved.backup }) : result(saved.status);
  } catch {
    return result('unavailable_or_busy');
  } finally {
    operation?.finish(false);
  }
}
