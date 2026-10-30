// @ts-check
// Узкое согласование восстановленного ПК: только полное совпадение с единственной
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
import { requireMatchingCloudBase, withAcceptedCloudBase } from './acceptedCloudBase.js';
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
    const adopted = await queue.adoptReviewedBase({ ...context.pins, proof });
    uncertain = adopted.status === 'journal_uncertain';
    if (!['adopted', 'already_adopted'].includes(adopted.status)) return result(adopted.status);
    if (input.signal?.aborted) return result('cancelled');
    // Повторно читаем список и выбранную голову ПОСЛЕ фиксации очереди: между
    // этими действиями другие ПК всё равно могут изменить облако.
    const known = [context.binding.rootPin];
    if (context.binding.rootPin.versionId !== adopted.pin.versionId) known.push(adopted.pin);
    const again = await review(known);
    if (again.status !== 'ready_for_review') return result('cloud_changed_after_queue');
    const repeated = again.prepareExactAdoption(input.pin, original.settings);
    if (repeated.status !== 'ready_for_adoption' || !samePin(repeated.pin, adopted.pin, 'versionId'))
      return result('cloud_changed_after_queue');
    if (input.signal?.aborted) return result('cancelled');
    if (!(await stillSaved(original))) return result('state_changed_after_queue');
    const accepted = {
      version: 1,
      provider: context.provider,
      datasetId: context.binding.datasetId,
      pin: adopted.pin,
      anchorId: adopted.anchorId
    };
    if (!events.length) {
      try {
        requireMatchingCloudBase(original.settings, {
          provider: context.provider,
          datasetId: context.binding.datasetId,
          adoptedBase: { pin: adopted.pin, anchorId: adopted.anchorId }
        });
        return result('already_reconciled');
      } catch {
        // Первая установка или продолжение после записи одной только очереди.
      }
    }
    let candidate;
    try {
      candidate = structuredClone(original);
      candidate.settings = withAcceptedCloudBase(removePendingSelectiveApply(candidate.settings), accepted);
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
