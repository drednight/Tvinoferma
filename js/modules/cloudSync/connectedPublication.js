// @ts-check
// Ограниченное продолжение линейной ветки. Очередь готовится без сети, отправка
// возможна только после сверки наблюдаемых голов. Восстановленный ПК допускается
// после отдельного принятия полностью совпавшей основы; расхождения и удаления
// блокируются. Межпроцессной блокировки state и доказательства полноты списка нет.
// Не выводить значения снимков, ключи, ответы IPC и исходные ошибки.
import { forgetLoadedState, loadData } from '../../core/storage.js';
import { object } from './exportSchema.js';
import { buildPublicSnapshot } from './publicSnapshot.js';
import { requireResolvedSelectiveApply } from './pendingSelectiveApply.js';
import { requireMatchingCloudBase } from './acceptedCloudBase.js';
import { MAX_HISTORY_VERSIONS } from './history.js';
import { currentCloudStateSnapshot, cloudSnapshotMatchesDisk } from './guardedStateWrite.js';
import { stageSyncIdentities } from './commitSyncIdentities.js';
import { createDurableCloudOutbox } from './durableOutbox.js';
import { prepareCloudReview } from './cloudReview.js';
import { createNativeDatasetBindingStore } from './providers/nativeDatasetBindingStore.js';
import { createNativeKeyStateStore } from './providers/nativeKeyStateStore.js';
import { createNativeOutboxStore } from './providers/nativeOutboxStore.js';
import { readNativeCredentialBinding } from './providers/nativeCredentialStore.js';
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
function result(status) {
  return Object.freeze({ status });
}
function samePin(left, right, key) {
  return left?.[key] === right?.[key] && left?.sha256 === right?.sha256;
}
function validOptions(options, extra = []) {
  const input = object(options, ['provider', 'invoke'], ['cryptoSource', 'timeoutMs', ...extra]);
  if (!['google', 'yandex'].includes(input.provider) || typeof input.invoke !== 'function')
    throw new Error('Не удалось безопасно подготовить отправку');
  return input;
}

/** Внутренний контекст: содержит ключ, не журналировать и не показывать. Сеть не используется. */
export async function openConnectedPublicationContext(input) {
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const common = { invoke: input.invoke, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
  const keyOptions = { ...common, ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}) };
  const pin = /** @type {any} */ (await createNativeDatasetBindingStore({ provider, ...common }).read());
  if (pin.status !== 'ready') return null;
  const key = /** @type {any} */ (await createNativeKeyStateStore(keyOptions).read());
  const account = await readNativeCredentialBinding({ provider, ...common });
  if (
    key.status !== 'ready' ||
    account.status !== 'ready' ||
    key.state.slotId !== pin.binding.keySlotId ||
    key.state.datasetId !== pin.binding.datasetId ||
    account.binding.slotId !== pin.binding.accountSlotId ||
    !samePin(key.state.pin, pin.binding.keyPin, 'bundleId')
  )
    return null;
  const store = createNativeOutboxStore({ provider, ...common });
  const head = await store.read();
  if (head.status !== 'ready' || head.datasetId !== pin.binding.datasetId) return null;
  const queue = network =>
    createDurableCloudOutbox({
      provider,
      datasetId: pin.binding.datasetId,
      deviceId: head.deviceId,
      slotId: head.slotId,
      clientId: account.binding.clientId,
      accountKey: account.binding.accountKey,
      dataKey: key.state.dataKey,
      store,
      session: network,
      ...(provider === 'google' ? { folderId: pin.binding.folderId } : {}),
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
    });
  return {
    provider,
    key: key.state,
    binding: pin.binding,
    keyOptions,
    queue,
    pins: { expectedRootPin: pin.binding.rootPin, expectedKeyPin: pin.binding.keyPin }
  };
}

// Чтение файла дожидается прежних сохранений. Совпадение в этом контексте не
// предотвращает запись другим процессом в следующий момент.
async function savedSnapshot() {
  let loaded = null;
  try {
    const snapshot = currentCloudStateSnapshot();
    requireResolvedSelectiveApply(snapshot.settings);
    loaded = await loadData();
    if (
      JSON.stringify(currentCloudStateSnapshot()) !== JSON.stringify(snapshot) ||
      !cloudSnapshotMatchesDisk(snapshot, loaded)
    )
      return null;
    return snapshot;
  } finally {
    if (loaded) forgetLoadedState(loaded);
  }
}
function stillSame(snapshot) {
  try {
    requireResolvedSelectiveApply(currentCloudStateSnapshot().settings);
    return JSON.stringify(currentCloudStateSnapshot()) === JSON.stringify(snapshot);
  } catch {
    return false;
  }
}

/**
 * Подготавливает последнюю подтверждённую локальную запись в шифрованной очереди.
 * Сеть не нужна. По отдельному разрешению внутренние ID назначаются с backup и
 * guarded записью. При сбое между сохранением state и очередью следующий запуск
 * должен снова вызвать этот метод; атомарной транзакции этих двух файлов нет.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,
 * prepareIdentities?:boolean,cryptoSource?:Crypto,timeoutMs?:number}} options
 */
export async function queueConnectedSavedSnapshot(options) {
  const input = validOptions(options, ['prepareIdentities']);
  if (input.prepareIdentities !== undefined && typeof input.prepareIdentities !== 'boolean')
    throw new Error('Не удалось безопасно подготовить отправку');
  let operation;
  let uncertain = false;
  try {
    operation = beginCloudDataOperation();
    const context = await openConnectedPublicationContext(input);
    if (!context) return result('binding_or_queue_blocked');
    const outbox = context.queue(NO_NETWORK);
    const head = await outbox.inspectLinearHead(context.pins);
    if (head.status !== 'ready') return result(head.status);
    if (!head.confirmedPin) return result('root_unconfirmed');
    let saved;
    try {
      saved = await savedSnapshot();
    } catch {
      return result('provenance_review_required');
    }
    if (!saved) return result('state_changed_or_unsaved');
    try {
      requireMatchingCloudBase(saved.settings, {
        provider: context.provider,
        datasetId: context.binding.datasetId,
        adoptedBase: head.adoptedBase
      });
    } catch {
      return result('accepted_base_mismatch');
    }
    if (input.prepareIdentities === true) {
      let staged;
      try {
        staged = stageSyncIdentities(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {});
      } catch {
        return result('identities_unavailable');
      }
      if (staged.status === 'prepared') {
        const assigned = await staged.operation.commit({ confirmed: true });
        if (assigned.status !== 'applied') return result(`identities_${assigned.status}`);
        try {
          saved = await savedSnapshot();
        } catch {
          return result('provenance_review_required');
        }
        if (!saved) return result('state_changed_or_unsaved');
      }
    }
    let publicSnapshot;
    try {
      publicSnapshot = buildPublicSnapshot(saved, { settingsSelections: head.settingsSelections });
    } catch {
      return result('data_unprepared');
    }
    if (!stillSame(saved)) return result('state_changed_or_unsaved');
    const queued = await outbox.queueLinearSnapshot({
      ...context.pins,
      expectedRevisionId: head.revisionId,
      keyBundle: context.key.bundle,
      publicSnapshot
    });
    uncertain = queued.status === 'journal_uncertain';
    return result(queued.status);
  } catch {
    return result('unavailable_or_busy');
  } finally {
    operation?.finish(uncertain);
  }
}

/**
 * Сверяет отправляемую версию с текущим сохранённым state и единственной
 * наблюдаемой головой облака. Облачный список может быть неполным или устареть
 * после проверки: одновременные ПК способны создать разные ветви. При уже
 * начатой попытке выполняется только точное чтение без повторной записи.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,
 * cryptoSource?:Crypto,timeoutMs?:number,now?:()=>number,signal?:AbortSignal,openSession?:typeof openPinnedNativeCloudSession}} options
 */
export async function sendConnectedQueuedSnapshot(options) {
  const input = validOptions(options, ['now', 'openSession', 'signal']);
  if (
    (input.now !== undefined && typeof input.now !== 'function') ||
    (input.openSession !== undefined && typeof input.openSession !== 'function') ||
    (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== 'boolean'))
  )
    throw new Error('Не удалось безопасно подготовить отправку');
  let operation;
  let session = null;
  let uncertain = false;
  try {
    operation = beginCloudDataOperation();
    if (input.signal?.aborted) return result('cancelled');
    const context = await openConnectedPublicationContext(input);
    if (!context) return result('binding_or_queue_blocked');
    if (input.signal?.aborted) return result('cancelled');
    const offline = context.queue(NO_NETWORK);
    let head = await offline.inspectLinearHead(context.pins);
    if (head.status !== 'ready') return result(head.status);
    if (!head.confirmedPin) return result('root_unconfirmed');
    if (!head.nextPin) return result('idle');
    let saved;
    let publicSnapshot;
    // Сверка уже начатой попытки ничего не записывает в облако и разрешена,
    // даже если новые изменения ещё не удалось поставить в очередь.
    if (head.nextPhase !== 'attempting') {
      try {
        saved = await savedSnapshot();
      } catch {
        return result('provenance_review_required');
      }
      if (!saved) return result('state_changed_or_unsaved');
      try {
        publicSnapshot = buildPublicSnapshot(saved, { settingsSelections: head.settingsSelections });
      } catch {
        return result('data_unprepared');
      }
      head = await offline.inspectLinearHead({ ...context.pins, publicSnapshot });
      if (head.status !== 'ready' || !head.confirmedPin || !head.nextPin) return result('queue_changed');
      try {
        requireMatchingCloudBase(saved.settings, {
          provider: context.provider,
          datasetId: context.binding.datasetId,
          adoptedBase: head.adoptedBase
        });
      } catch {
        return result('accepted_base_mismatch');
      }
      if (head.tailMatches !== true) return result('latest_not_queued');
      if (!stillSame(saved)) return result('state_changed_or_unsaved');
    }
    if (input.signal?.aborted) return result('cancelled');
    // Потерянный ответ Google refresh может означать уже изменённый credential.
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
    const outbox = context.queue(session);
    if (head.nextPhase === 'attempting') {
      const verified = await outbox.verifyNext();
      uncertain = verified.status === 'journal_uncertain';
      if (uncertain) return result('journal_uncertain');
      if (verified.status === 'confirmed') return result('verified_previous_attempt');
      if (verified.status === 'needs_review') return result('cloud_content_mismatch');
      return result('verification_pending');
    }
    const review = /** @type {any} */ (
      await prepareCloudReview({
        provider: context.provider,
        session,
        datasetId: context.binding.datasetId,
        dataKey: context.key.dataKey,
        rootPin: context.binding.rootPin,
        knownPins: head.confirmedPins,
        localSnapshot: publicSnapshot,
        localSavedAt: null,
        ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
        ...(input.now ? { now: input.now } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      })
    );
    if (input.signal?.aborted) return result('cancelled');
    if (review.status !== 'ready_for_review') return result(review.status);
    if (review.versions.length >= MAX_HISTORY_VERSIONS) return result('history_limit');
    const heads = review.versions.filter(version => version.observedHead);
    if (heads.length !== 1) return result('remote_branches_require_review');
    if (!samePin(heads[0].pin, head.confirmedPin, 'versionId')) return result('remote_changes_require_review');
    try {
      const again = await savedSnapshot();
      if (!again || JSON.stringify(again) !== JSON.stringify(saved)) return result('state_changed_or_unsaved');
    } catch {
      return result('provenance_review_required');
    }
    if (!stillSame(saved)) return result('state_changed_or_unsaved');
    if (input.signal?.aborted) return result('cancelled');
    const sent = await outbox.sendLinearNext({
      ...context.pins,
      expectedConfirmedPin: head.confirmedPin,
      expectedNextPin: head.nextPin,
      expectedRevisionId: head.revisionId
    });
    uncertain = sent.status === 'journal_uncertain';
    if (sent.status !== 'needs_verification') return result(sent.status);
    const verified = await outbox.verifyNext();
    uncertain = verified.status === 'journal_uncertain';
    if (uncertain) return result('journal_uncertain');
    if (verified.status === 'confirmed') return result('sent_verified');
    if (verified.status === 'needs_review') return result('cloud_content_mismatch');
    return result('verification_pending');
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
