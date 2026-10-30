// @ts-check
// Узкое согласование любого подключённого ПК: только полное совпадение с единственной
// наблюдаемой головой и проверенная линия всех частично принятых источников. Это
// не слияние конфликтующих записей и не доказательство полноты списка провайдера.
// В очереди сначала закрепляется шифротекст и случайный anchorId; только затем
// marker заменяется связанной отметкой в state с backup. Откат двух хранилищ,
// другие процессы и прямые старые IPC остаются за пределами этой координации.
import { forgetLoadedState, loadData } from '../../core/storage.js';
import { object } from './exportSchema.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import {
  currentCloudStateSnapshot,
  cloudSnapshotMatchesDisk,
  stageGuardedCloudStateWrite
} from './guardedStateWrite.js';
import { pendingSelectiveApplyEvents, removePendingSelectiveApply } from './pendingSelectiveApply.js';
import { requireMatchingCloudBase, replaceAcceptedCloudBase } from './acceptedCloudBase.js';
import { prepareCloudReview } from './cloudReview.js';
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
function samePin(a, b, key) {
  return a?.[key] === b?.[key] && a?.sha256 === b?.sha256;
}
function sameBase(a, b) {
  return a === null && b === null
    ? true
    : !!a && !!b && a.anchorId === b.anchorId && samePin(a.pin, b.pin, 'versionId');
}
function matchesState(settings, context, adoptedBase) {
  try {
    requireMatchingCloudBase(settings, {
      provider: context.provider,
      datasetId: context.binding.datasetId,
      adoptedBase
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

/**
 * Повторно загружает выбранную версию, согласует только полное совпадение и
 * сохраняет новый marker с резервной копией. До этой операции сеть только читает.
 * Отмена/потеря ответа могут оставить принятую основу в очереди, но без связанной
 * отметки state её нельзя публиковать; прежняя отметка частичного применения не
 * снимается до подтверждённого state. Прямого атомарного CAS обоих файлов нет.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,
 * pin:{versionId:string,sha256:string},confirmed:boolean,settingsSelections?:string[],
 * cryptoSource?:Crypto,timeoutMs?:number,now?:()=>number,signal?:AbortSignal,
 * openSession?:typeof openPinnedNativeCloudSession}} options
 */
export async function reconcileExactCloudBase(options) {
  const input = object(
    options,
    ['provider', 'invoke', 'pin', 'confirmed'],
    ['settingsSelections', 'cryptoSource', 'timeoutMs', 'now', 'signal', 'openSession']
  );
  if (
    !['google', 'yandex'].includes(input.provider) ||
    typeof input.invoke !== 'function' ||
    input.confirmed !== true ||
    (input.settingsSelections !== undefined && !Array.isArray(input.settingsSelections)) ||
    (input.openSession !== undefined && typeof input.openSession !== 'function') ||
    (input.now !== undefined && typeof input.now !== 'function') ||
    (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== 'boolean'))
  )
    throw new Error('Не удалось безопасно согласовать основу синхронизации');
  let operation;
  let session = null;
  let uncertain = false;
  try {
    operation = beginCloudDataOperation();
    if (input.signal?.aborted) return result('cancelled');
    const context = await openConnectedPublicationContext(input);
    if (!context) return result('binding_or_queue_blocked');
    const original = currentCloudStateSnapshot();
    // Повреждённый marker не может быть удалён как пустой.
    const events = pendingSelectiveApplyEvents(original.settings);
    if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
    let local;
    try {
      local = buildPublicSnapshot(original, { settingsSelections: input.settingsSelections || [] });
    } catch {
      return result('data_unprepared');
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
    if (input.signal?.aborted) return result('cancelled');
    if (
      opened.datasetId !== context.binding.datasetId ||
      !samePin(opened.keyPin, context.binding.keyPin, 'bundleId') ||
      !samePin(opened.rootPin, context.binding.rootPin, 'versionId')
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
    const first = await review([context.binding.rootPin]);
    if (first.status !== 'ready_for_review') return result(first.status);
    const proof = first.prepareExactAdoption(input.pin, original.settings);
    if (proof.status !== 'ready_for_adoption') return result(proof.status);
    if (input.signal?.aborted) return result('cancelled');
    if (!(await stillSaved(original))) return result('state_changed_or_unsaved');
    const queue = context.queue(NO_NETWORK);
    const before = await queue.inspectLinearHead(context.pins);
    if (before.status === 'ready') {
      const canResume =
        before.adoptedBase &&
        !before.nextPin &&
        samePin(before.adoptedBase.pin, proof.pin, 'versionId') &&
        samePin(before.tailPin, proof.pin, 'versionId') &&
        matchesState(original.settings, context, before.previousBase);
      if (!matchesState(original.settings, context, before.adoptedBase) && !canResume)
        return result('accepted_base_mismatch');
    } else if (before.status !== 'no_local_lineage') return result(before.status);
    else if (!matchesState(original.settings, context, null)) return result('accepted_base_mismatch');
    const adopted = await queue.adoptReviewedBase({ ...context.pins, proof });
    uncertain = adopted.status === 'journal_uncertain';
    if (!['adopted', 'already_adopted', 'already_head'].includes(adopted.status)) return result(adopted.status);
    const targetBase =
      adopted.status === 'already_head' ? adopted.adoptedBase : { pin: adopted.pin, anchorId: adopted.anchorId };
    const previousBase = adopted.status === 'already_head' ? targetBase : adopted.previousBase;
    if (
      !matchesState(original.settings, context, targetBase) &&
      !matchesState(original.settings, context, previousBase)
    )
      return result('accepted_base_mismatch');
    const fixed = await queue.inspectLinearHead(context.pins);
    if (
      fixed.status !== 'ready' ||
      fixed.nextPin ||
      !samePin(fixed.tailPin, adopted.pin, 'versionId') ||
      !samePin(fixed.confirmedPin, adopted.pin, 'versionId') ||
      !sameBase(fixed.adoptedBase, targetBase)
    )
      return result('queue_changed');
    if (input.signal?.aborted) return result('cancelled');
    // Повторно читаем список и выбранную голову ПОСЛЕ фиксации очереди: между
    // этими действиями другие ПК всё равно могут изменить облако.
    const again = await review(proof.lineage);
    if (again.status !== 'ready_for_review') return result('cloud_changed_after_queue');
    const repeated = again.prepareExactAdoption(input.pin, original.settings);
    if (repeated.status !== 'ready_for_adoption' || !samePin(repeated.pin, adopted.pin, 'versionId'))
      return result('cloud_changed_after_queue');
    if (input.signal?.aborted) return result('cancelled');
    if (!(await stillSaved(original))) return result('state_changed_after_queue');
    const currentQueue = await queue.inspectLinearHead(context.pins);
    if (currentQueue.status !== 'ready' || currentQueue.revisionId !== fixed.revisionId) return result('queue_changed');
    const currentMatches = matchesState(original.settings, context, targetBase);
    if (!events.length && currentMatches) return result('already_reconciled');
    let candidate;
    try {
      candidate = structuredClone(original);
      candidate.settings = removePendingSelectiveApply(candidate.settings);
      if (!currentMatches) {
        if (!targetBase) return result('accepted_base_mismatch');
        candidate.settings = replaceAcceptedCloudBase(
          candidate.settings,
          {
            version: 1,
            provider: context.provider,
            datasetId: context.binding.datasetId,
            pin: targetBase.pin,
            anchorId: targetBase.anchorId
          },
          previousBase
        );
      }
    } catch {
      return result('accepted_base_mismatch');
    }
    const staged = stageGuardedCloudStateWrite({
      original,
      candidate,
      backupLabel: 'pre-cloud-accept',
      selectedCount: events.length
    });
    const committed = /** @type {any} */ (await staged.commit({ confirmed: true }));
    if (committed.status !== 'applied') return result(committed.status);
    return result('reconciled', { backup: committed.backup });
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
