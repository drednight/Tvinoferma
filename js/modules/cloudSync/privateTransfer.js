// @ts-check
// Manual, per-batch consent. Ordinary saves NEVER read/export local contacts.
// A staged private batch survives ordinary queue coalescing encrypted. Do not log.
import { hasSnapshotFileMode } from './snapshotFileState.js';
import { vaultStatus } from '../../core/secrets.js';
import { loadData, forgetLoadedState } from '../../core/storage.js';
import { object, array } from './exportSchema.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { buildPrivateDelta, PRIVATE_FIELDS } from './privateSnapshot.js';
import {
  currentCloudStateSnapshot,
  cloudSnapshotMatchesDisk,
  stageGuardedCloudStateWrite
} from './guardedStateWrite.js';
import { requireResolvedSelectiveApply } from './pendingSelectiveApply.js';
import { requireMatchingCloudBase } from './acceptedCloudBase.js';
import { openConnectedPublicationContext } from './connectedPublication.js';
import { isVerifiedCloudReview } from './cloudReview.js';
import { beginCloudDataOperation } from './credentialResetCoordination.js';

const result = status => Object.freeze({ status });
const NO_NETWORK = Object.freeze({
  async generateFileId() {
    throw new Error('offline');
  },
  async upload() {
    throw new Error('offline');
  },
  async verify() {
    throw new Error('offline');
  }
});
function sourceAvailable(snapshot) {
  const vault = vaultStatus();
  return !vault.blocked && (!snapshot.settings.security.useVault || (vault.checked && vault.ready));
}
async function stillSaved(snapshot) {
  let disk;
  try {
    disk = await loadData();
    return (
      JSON.stringify(currentCloudStateSnapshot()) === JSON.stringify(snapshot) &&
      cloudSnapshotMatchesDisk(snapshot, disk)
    );
  } finally {
    if (disk) forgetLoadedState(disk);
  }
}
function identity(context) {
  return JSON.stringify([context.provider, context.binding, context.key.pin]);
}
function consent(input, fields) {
  if (!fields.length || new Set(fields).size !== fields.length || fields.some(field => !PRIVATE_FIELDS.includes(field)))
    return false;
  return (
    input.contactsSourceConfirmed === true && (!fields.includes('password') || input.acknowledgePasswordRisk === true)
  );
}
/** Offline preparation only. No values are exposed in the returned review. */
export async function stagePrivatePublication(options) {
  const input = object(
    options,
    ['provider', 'invoke', 'fields', 'contactsSourceConfirmed'],
    ['acknowledgePasswordRisk', 'cryptoSource', 'timeoutMs']
  );
  const fields = array(input.fields, value => value);
  if (!consent(input, fields)) return result('private_consent_required');
  let operation;
  try {
    operation = beginCloudDataOperation();
    const context = await openConnectedPublicationContext(input);
    if (!context) return result('binding_or_queue_blocked');
    let original = currentCloudStateSnapshot();
    if (hasSnapshotFileMode(original.settings, input.provider)) return result('snapshot_file_mode');
    requireResolvedSelectiveApply(original.settings);
    if (!sourceAvailable(original)) return result('private_source_unavailable');
    if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
    const head = await context.queue(NO_NETWORK).inspectLinearHead(context.pins);
    if (head.status !== 'ready') return result(head.status);
    if (head.retainedIntents.length) return result('retained_intent_pending');
    requireMatchingCloudBase(original.settings, {
      provider: context.provider,
      datasetId: context.binding.datasetId,
      adoptedBase: head.adoptedBase
    });
    const publicSnapshot = buildPublicSnapshot(original, { settingsSelections: head.settingsSelections });
    let delta = buildPrivateDelta(original, publicSnapshot, fields);
    const count = delta.records.length;
    const bound = identity(context);
    let phase = 'ready';
    return Object.freeze({
      status: 'private_publication_review',
      characterCount: count,
      fields: Object.freeze([...fields]),
      cancel() {
        if (phase === 'running') return result('in_progress');
        phase = 'closed';
        original = null;
        delta = null;
        return result('cancelled');
      },
      async commit(answer) {
        if (phase !== 'ready') return result('closed');
        if (object(answer, ['confirmed']).confirmed !== true) return result('confirmation_required');
        let guard;
        let uncertain = false;
        try {
          guard = beginCloudDataOperation();
        } catch {
          return result('busy');
        }
        phase = 'running';
        try {
          const now = await openConnectedPublicationContext(input);
          if (!now || identity(now) !== bound) return result('binding_or_queue_blocked');
          if (!original || !delta || !sourceAvailable(original)) return result('private_source_unavailable');
          requireResolvedSelectiveApply(currentCloudStateSnapshot().settings);
          if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
          const queued = await now.queue(NO_NETWORK).queueLinearSnapshot({
            ...now.pins,
            expectedRevisionId: head.revisionId,
            keyBundle: now.key.bundle,
            publicSnapshot,
            privateDelta: delta
          });
          uncertain = queued.status === 'journal_uncertain';
          return result(queued.status);
        } catch {
          return result('unavailable_or_busy');
        } finally {
          phase = 'closed';
          original = null;
          delta = null;
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
/** Review is a process-local capability from authenticated, pinned history.
 * Only explicitly selected character/field pairs change. No auto-export policy
 * is enabled; no public provenance marker is needed for a manual-only field.
 */
export function stagePrivateCloudApply(options) {
  const input = object(
    options,
    ['review', 'pin', 'selections', 'contactsSourceConfirmed', 'independentBackupConfirmed'],
    ['acknowledgePasswordRisk']
  );
  if (!isVerifiedCloudReview(input.review)) throw new Error('Не подтверждён источник контактов');
  if (input.independentBackupConfirmed !== true)
    throw new Error('Нужна отдельная копия прежних контактов; state-backup не является копией vault');
  const selected = array(input.selections, row => object(row, ['characterId', 'field']));
  const fields = [...new Set(selected.map(row => row.field))];
  if (!consent(input, fields)) throw new Error('Не подтверждён выбор передачи контактов');
  const original = currentCloudStateSnapshot();
  requireResolvedSelectiveApply(original.settings);
  if (!sourceAvailable(original)) throw new Error('Локальное хранилище контактов недоступно');
  const candidate = input.review.preparePrivateApply(input.pin, original, selected);
  const staged = stageGuardedCloudStateWrite({
    original,
    candidate,
    backupLabel: 'pre-cloud-private-apply',
    selectedCount: selected.length
  });
  return Object.freeze({
    selectedCount: staged.selectedCount,
    cancel: () => staged.cancel(),
    async commit(answer) {
      let guard;
      try {
        guard = beginCloudDataOperation();
      } catch {
        return result('busy');
      }
      try {
        if (!sourceAvailable(currentCloudStateSnapshot())) return result('private_source_unavailable');
        return await staged.commit(answer);
      } finally {
        guard.finish(false);
      }
    }
  });
}
