// @ts-check
// Manual outgoing deletion review. It never removes local state or uploads data.
// Missing records alone are not an approval: the user confirms an exact set
// against one authenticated parent and queue revision. Secrets are not returned.
import { forgetLoadedState, loadData } from '../../core/storage.js';
import { object } from './exportSchema.js';
import { openConnectedPublicationContext } from './connectedPublication.js';
import { currentCloudStateSnapshot, cloudSnapshotMatchesDisk } from './guardedStateWrite.js';
import { requireResolvedSelectiveApply } from './pendingSelectiveApply.js';
import { requireMatchingCloudBase } from './acceptedCloudBase.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { beginCloudDataOperation } from './credentialResetCoordination.js';

const NO_NETWORK = Object.freeze({
  async generateFileId() {
    throw new Error('offline review');
  },
  async upload() {
    throw new Error('offline review');
  },
  async verify() {
    throw new Error('offline review');
  }
});
const result = status => Object.freeze({ status });
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
function identity(context) {
  return JSON.stringify([context.binding, context.key.slotId, context.key.pin]);
}

/**
 * Stage only already saved local removals of manual planner entries. Confirmation
 * adds encrypted cumulative tombstones to the outbox, not to state. Regular send
 * must still verify the cloud head; a concurrent cloud edit blocks that send.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,cryptoSource?:Crypto,timeoutMs?:number}} options
 */
export async function stagePlannerDeletionPublication(options) {
  const input = object(options, ['provider', 'invoke'], ['cryptoSource', 'timeoutMs']);
  if (!['google', 'yandex'].includes(input.provider) || typeof input.invoke !== 'function')
    throw new Error('Не удалось проверить удаления календаря');
  let operation;
  try {
    operation = beginCloudDataOperation();
    const context = await openConnectedPublicationContext(input);
    if (!context) return result('binding_or_queue_blocked');
    let original = currentCloudStateSnapshot();
    requireResolvedSelectiveApply(original.settings);
    if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
    const queue = context.queue(NO_NETWORK);
    const head = await queue.inspectLinearHead(context.pins);
    if (head.status !== 'ready') return result(head.status);
    requireMatchingCloudBase(original.settings, {
      provider: context.provider,
      datasetId: context.binding.datasetId,
      adoptedBase: head.adoptedBase
    });
    const publicSnapshot = buildPublicSnapshot(original, { settingsSelections: head.settingsSelections });
    const preview = /** @type {any} */ (
      await queue.inspectPlannerDeletions({ ...context.pins, publicSnapshot, expectedRevisionId: head.revisionId })
    );
    if (preview.status !== 'deletion_review') return result(preview.status);
    if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
    const capturedIdentity = identity(context);
    const approval = { parentPin: preview.parentPin, ids: preview.records.map(record => record.id) };
    let phase = 'ready';
    return Object.freeze({
      status: 'deletion_review',
      records: () => structuredClone(preview.records),
      cancel() {
        if (phase === 'running') return result('in_progress');
        phase = 'closed';
        original = null;
        return result('closed');
      },
      async commit(answer) {
        if (phase !== 'ready') return result('closed');
        const confirmation = object(answer, ['confirmed']);
        if (confirmation.confirmed !== true) return result('confirmation_required');
        let guard;
        let uncertain = false;
        try {
          guard = beginCloudDataOperation();
        } catch {
          return result('busy');
        }
        phase = 'running';
        try {
          const current = await openConnectedPublicationContext(input);
          if (!current || identity(current) !== capturedIdentity) return result('binding_or_queue_blocked');
          if (!original || !(await stillSaved(original))) return result('state_changed_or_unsaved');
          requireResolvedSelectiveApply(original.settings);
          const outbox = current.queue(NO_NETWORK);
          const now = await outbox.inspectLinearHead(current.pins);
          if (now.status !== 'ready' || now.revisionId !== preview.revisionId) return result('deletion_review_changed');
          requireMatchingCloudBase(original.settings, {
            provider: current.provider,
            datasetId: current.binding.datasetId,
            adoptedBase: now.adoptedBase
          });
          if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
          const queued = await outbox.queueLinearSnapshot({
            ...current.pins,
            keyBundle: current.key.bundle,
            publicSnapshot,
            expectedRevisionId: preview.revisionId,
            plannerDeletionApproval: approval
          });
          uncertain = queued.status === 'journal_uncertain';
          return result(queued.status);
        } catch {
          return result('unavailable_or_busy');
        } finally {
          phase = 'closed';
          original = null;
          guard.finish(uncertain);
        }
      }
    });
  } catch {
    return result('unavailable_or_busy');
  } finally {
    operation?.finish(false);
  }
}
