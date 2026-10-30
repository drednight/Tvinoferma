// @ts-check
// Первичная ЛОКАЛЬНАЯ подготовка нового набора. Сеть не вызывается, никакой
// старый облачный файл не ищется, не меняется и не удаляется. Это пока не полная
// синхронизация: отдельные сценарии первой отправки и восстановления экспериментальны,
// а последующие публикации и согласование изменений ещё не реализованы.
// Все ключи и локальные данные остаются в памяти/хранилище ОС; не журналировать.
import { object } from './exportSchema.js';
import { generateSyncId } from './envelope.js';
import { createKeyProvisioner } from './keyProvisioning.js';
import { sealHistoryVersion } from './history.js';
import { createPairingCode } from './pairingCode.js';
import { captureInitialCloudBaseline } from './initialCloudBaseline.js';
import { createDurableCloudOutbox } from './durableOutbox.js';
import { createDatasetBindingRecord } from './datasetBindingRecord.js';
import { createNativeDatasetBindingStore } from './providers/nativeDatasetBindingStore.js';
import { createNativeKeyStateStore } from './providers/nativeKeyStateStore.js';
import { createNativeOutboxStore } from './providers/nativeOutboxStore.js';
import { readNativeCredentialBinding } from './providers/nativeCredentialStore.js';
import { beginCloudDataOperation } from './credentialResetCoordination.js';

// Нативный guarded install сериализует создание двух корней между участниками
// протокола. Эта дополнительная защита блокирует повтор после неизвестного IPC
// лишь в текущем JS-контексте до перезапуска.
let blockedAfterUncertain = false;
const NO_NETWORK = Object.freeze({
  async generateFileId() {
    throw new Error('Первичная настройка не отправляет данные');
  },
  async upload() {
    throw new Error('Первичная настройка не отправляет данные');
  },
  async verify() {
    throw new Error('Первичная настройка не отправляет данные');
  }
});
function result(status, extra = {}) {
  return Object.freeze({ status, ...extra });
}
function invalid() {
  return new Error('Не удалось безопасно подготовить новую синхронизацию');
}
function sameAccount(left, right) {
  return left?.slotId === right?.slotId && left?.clientId === right?.clientId && left?.accountKey === right?.accountKey;
}
function sameKeyPin(left, right) {
  return left?.bundleId === right?.bundleId && left?.sha256 === right?.sha256;
}
function otherProvider(provider) {
  return provider === 'google' ? 'yandex' : 'google';
}

/**
 * Для первого корня используется корень «Моего диска» Google (`root`), а не
 * автоматически создаваемая папка: иначе её ID и исход POST потребовали бы
 * отдельного устойчивого журнала. При желании пользователь может позже
 * перенести файлы, но тогда пока понадобится ручное восстановление привязки.
 * До включения отправки необходима проверка настоящего Google API.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,
 * cryptoSource?:Crypto,timeoutMs?:number,settingsSelections?:string[]}} options
 */
export function createInitialCloudSetup(options) {
  const input = object(options, ['provider', 'invoke'], ['cryptoSource', 'timeoutMs', 'settingsSelections']);
  if (
    !['google', 'yandex'].includes(input.provider) ||
    typeof input.invoke !== 'function' ||
    (input.timeoutMs !== undefined &&
      (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 20 || input.timeoutMs > 120_000)) ||
    (input.settingsSelections !== undefined && !Array.isArray(input.settingsSelections))
  )
    throw invalid();
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const common = { invoke: input.invoke, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
  const keyOptions = { ...common, ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}) };
  const cryptoSource = input.cryptoSource;
  const selection = input.settingsSelections ? [...input.settingsSelections] : [];
  let active = false;

  async function inspectLocal() {
    const account = await readNativeCredentialBinding({ provider, ...common });
    if (account.status !== 'ready') return result('credential_missing_or_blocked');
    const keys = createNativeKeyStateStore(keyOptions);
    const key = await keys.read();
    const pins = createNativeDatasetBindingStore({ provider, ...common });
    const otherPins = createNativeDatasetBindingStore({ provider: otherProvider(provider), ...common });
    const pin = await pins.read();
    const otherPin = await otherPins.read();
    if (pin.status !== 'empty' || otherPin.status !== 'empty') return result('dataset_binding_present');
    const store = createNativeOutboxStore({ provider, ...common });
    const otherStore = createNativeOutboxStore({ provider: otherProvider(provider), ...common });
    const head = await store.read();
    const otherHead = await otherStore.read();
    if (otherHead.status !== 'empty') return result('other_queue_present_or_blocked');
    if (!['empty', 'ready'].includes(head.status)) return result('queue_blocked');
    return { status: 'ready', account: account.binding, key, keys, pins, head };
  }

  /**
   * Возвращает только pin и код сверки. Установка журнала и pin — две разные
   * устойчивые операции; после сбоя между ними требуется явное продолжение.
   * @param {any} baseline
   * @param {any} expectedAccount
   * @param {string} datasetId
   * @param {any} expectedPin
   */
  async function finishLocal(baseline, expectedAccount, datasetId, expectedPin) {
    const found = /** @type {any} */ (await inspectLocal());
    if (found.status !== 'ready') return result(found.status);
    if (
      !sameAccount(found.account, expectedAccount) ||
      found.key.status !== 'ready' ||
      found.key.state.datasetId !== datasetId ||
      !sameKeyPin(found.key.state.pin, expectedPin)
    )
      return result('local_binding_changed');
    if (!(await baseline.stillCurrentAndSaved())) return result('key_installed_state_changed');
    const key = found.key.state;
    const guard = {
      accountSlotId: found.account.slotId,
      keySlotId: key.slotId,
      bundleId: key.pin.bundleId,
      fingerprint: key.pin.sha256
    };
    const store = createNativeOutboxStore({ provider, ...common, initialGuard: guard });
    const head = found.head;
    if (head.status === 'ready' && head.datasetId !== datasetId) return result('queue_blocked');
    const deviceId = head.status === 'ready' ? head.deviceId : generateSyncId(cryptoSource);
    const slotId = head.status === 'ready' ? head.slotId : generateSyncId(cryptoSource);
    const outbox = createDurableCloudOutbox({
      provider,
      datasetId,
      deviceId,
      slotId,
      clientId: found.account.clientId,
      accountKey: found.account.accountKey,
      dataKey: key.dataKey,
      store,
      session: NO_NETWORK,
      ...(provider === 'google' ? { folderId: 'root' } : {}),
      ...(cryptoSource ? { cryptoSource } : {})
    });
    let root;
    let resumed = false;
    if (head.status === 'ready') {
      const pending = await outbox.pendingInitializationRoot(key.pin);
      if (pending.status !== 'ready') return result('queue_blocked');
      root = pending.rootPin;
      resumed = true;
    } else {
      const version = await sealHistoryVersion({
        publicSnapshot: baseline.getPublicSnapshot(),
        parent: null,
        datasetId,
        versionId: generateSyncId(cryptoSource),
        recoveryKey: key.dataKey,
        keyBundle: key.bundle,
        keyPin: key.pin,
        ...(cryptoSource ? { cryptoSource } : {})
      });
      if (!(await baseline.stillCurrentAndSaved())) return result('key_installed_state_changed');
      const initialized = await outbox.initializeWithRoot(version.envelope, true);
      if (initialized.status === 'journal_uncertain') return result('setup_uncertain');
      if (initialized.status !== 'initialized') return result('queue_not_initialized');
      root = initialized.rootPin;
    }
    const binding = createDatasetBindingRecord({
      provider,
      accountSlotId: found.account.slotId,
      keySlotId: key.slotId,
      datasetId,
      keyPin: key.pin,
      rootPin: root,
      ...(provider === 'google' ? { folderId: 'root' } : {})
    });
    // С этого момента ошибка или потерянный ответ могут означать успешную запись.
    let installed;
    try {
      installed = await found.pins.install(binding.binding, true);
      if (installed.status === 'occupied' || installed.status === 'blocked') return result('binding_not_installed');
      if (installed.status !== 'installed') return result('setup_uncertain');
      const saved = await found.pins.read();
      if (saved.status !== 'ready' || saved.raw !== binding.raw) return result('setup_uncertain');
    } catch {
      return result('setup_uncertain');
    }
    return result('prepared', {
      backup: baseline.backup,
      resumed,
      pairingCode: createPairingCode({ datasetId, keyPin: key.pin, rootPin: root })
    });
  }

  return Object.freeze({
    /**
     * Начинает независимый набор после явного согласия. До confirmBackup ничего
     * кроме локальной резервной копии не сохраняется. Существующее облако этим
     * методом НЕ проверяется; оно может находиться в другой папке или Client ID.
     * @param {{primary:any,backup:any,newDatasetConfirmed:boolean}} value
     */
    async begin(value) {
      const params = object(value, ['primary', 'backup', 'newDatasetConfirmed']);
      if (params.newDatasetConfirmed !== true) throw invalid();
      if (active || blockedAfterUncertain) return result('busy_or_restart_required');
      active = true;
      let operation;
      let baseline = null;
      let attempt = null;
      let handedOff = false;
      let uncertain = false;
      try {
        operation = beginCloudDataOperation();
        const local = /** @type {any} */ (await inspectLocal());
        if (local.status !== 'ready') return result(local.status);
        if (local.key.status !== 'empty') return result('key_present');
        if (local.head.status !== 'empty') return result('queue_present');
        baseline = await captureInitialCloudBaseline({ settingsSelections: selection });
        if (baseline.status !== 'ready') return baseline;
        const provisioner = createKeyProvisioner({ store: local.keys, ...(cryptoSource ? { cryptoSource } : {}) });
        attempt = await provisioner.begin({
          primary: params.primary,
          backup: params.backup,
          newDatasetConfirmed: true
        });
        if (attempt.status !== 'prepared') return result(attempt.status);
        let phase = 'prepared';
        const close = () => {
          baseline?.close?.();
          baseline = null;
          attempt = null;
          phase = 'closed';
          if (uncertain) blockedAfterUncertain = true;
          operation.finish(uncertain);
          active = false;
        };
        const pending = attempt;
        const expectedAccount = local.account;
        const prepared = Object.freeze({
          status: 'prepared',
          generatedBackupSecret: pending.generatedBackupSecret,
          cancel() {
            if (phase === 'running') return result('in_progress');
            if (phase !== 'prepared') return result('closed');
            pending.cancel();
            close();
            return result('cancelled');
          },
          /** @param {{secret:string,savedSeparately:boolean}} confirmation */
          async confirmBackup(confirmation) {
            if (phase !== 'prepared') return result(phase === 'running' ? 'in_progress' : 'closed');
            const answer = object(confirmation, ['secret', 'savedSeparately']);
            if (typeof answer.secret !== 'string' || typeof answer.savedSeparately !== 'boolean') throw invalid();
            if (!answer.savedSeparately) return result('confirmation_required');
            phase = 'running';
            try {
              if (!(await baseline.stillCurrentAndSaved())) {
                pending.cancel();
                close();
                return result('state_changed');
              }
              const installed = await pending.confirmBackup(answer);
              if (installed.status === 'invalid_backup' || installed.status === 'confirmation_required') {
                phase = 'prepared';
                return result(installed.status);
              }
              if (installed.status === 'installation_uncertain') {
                uncertain = true;
                close();
                return result('setup_uncertain');
              }
              if (installed.status !== 'installed') {
                close();
                return result(installed.status);
              }
              const finished = await finishLocal(baseline, expectedAccount, pending.datasetId, pending.pin);
              uncertain = finished.status === 'setup_uncertain';
              close();
              return finished;
            } catch {
              // Исключение после запуска confirmBackup может скрывать запись ключа.
              uncertain = true;
              close();
              return result('setup_uncertain');
            }
          }
        });
        handedOff = true;
        return prepared;
      } catch {
        return result('unavailable');
      } finally {
        if (!handedOff) {
          attempt?.cancel?.();
          baseline?.close?.();
          operation?.finish(uncertain);
          active = false;
        }
      }
    },

    /**
     * Явное продолжение после перезапуска: установленный ключ не меняется;
     * ранее сохранённый неначатый root используется как есть. Если журнала ещё
     * нет, формируется новый root из проверенной сохранённой локальной копии.
     * @param {{resumeConfirmed:boolean,backupKeySaved:boolean}} value
     */
    async resume(value) {
      const params = object(value, ['resumeConfirmed', 'backupKeySaved']);
      if (params.resumeConfirmed !== true || params.backupKeySaved !== true) throw invalid();
      if (active || blockedAfterUncertain) return result('busy_or_restart_required');
      active = true;
      let operation;
      let baseline = null;
      let uncertain = false;
      try {
        operation = beginCloudDataOperation();
        const local = /** @type {any} */ (await inspectLocal());
        if (local.status !== 'ready') return result(local.status);
        if (local.key.status !== 'ready') return result('key_missing_or_blocked');
        baseline = await captureInitialCloudBaseline({ settingsSelections: selection });
        if (baseline.status !== 'ready') return baseline;
        const finished = await finishLocal(baseline, local.account, local.key.state.datasetId, local.key.state.pin);
        uncertain = finished.status === 'setup_uncertain';
        return finished;
      } catch {
        // Любой сбой после возможного начала записи требует проверки после рестарта.
        uncertain = true;
        return result('setup_uncertain');
      } finally {
        baseline?.close?.();
        if (uncertain) blockedAfterUncertain = true;
        operation?.finish(uncertain);
        active = false;
      }
    }
  });
}

/**
 * Повторно показывает только код уже закреплённого набора после сверки ключа,
 * аккаунта и зашифрованной очереди. Код не содержит секрет, но его необходимо
 * передать на другой ПК по независимому доверенному каналу. Сеть не вызывается.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,
 * cryptoSource?:Crypto,timeoutMs?:number}} options
 */
export async function readLocalCloudPairingCode(options) {
  const input = object(options, ['provider', 'invoke'], ['cryptoSource', 'timeoutMs']);
  if (!['google', 'yandex'].includes(input.provider) || typeof input.invoke !== 'function') throw invalid();
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  let operation;
  try {
    operation = beginCloudDataOperation();
    const common = { invoke: input.invoke, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
    const keyOptions = { ...common, ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}) };
    const pin = /** @type {any} */ (await createNativeDatasetBindingStore({ provider, ...common }).read());
    const key = /** @type {any} */ (await createNativeKeyStateStore(keyOptions).read());
    const account = await readNativeCredentialBinding({ provider, ...common });
    if (
      pin.status !== 'ready' ||
      key.status !== 'ready' ||
      account.status !== 'ready' ||
      pin.binding.keySlotId !== key.state.slotId ||
      pin.binding.accountSlotId !== account.binding.slotId ||
      pin.binding.datasetId !== key.state.datasetId ||
      !sameKeyPin(pin.binding.keyPin, key.state.pin)
    )
      return result('binding_missing_or_blocked');
    const store = createNativeOutboxStore({ provider, ...common });
    const head = await store.read();
    if (head.status !== 'ready' || head.datasetId !== key.state.datasetId) return result('queue_blocked');
    const outbox = createDurableCloudOutbox({
      provider,
      datasetId: key.state.datasetId,
      deviceId: head.deviceId,
      slotId: head.slotId,
      clientId: account.binding.clientId,
      accountKey: account.binding.accountKey,
      dataKey: key.state.dataKey,
      store,
      session: NO_NETWORK,
      ...(provider === 'google' ? { folderId: pin.binding.folderId } : {}),
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
    });
    if ((await outbox.status()).status !== 'ready') return result('queue_blocked');
    return result('ready', {
      pairingCode: createPairingCode({
        datasetId: pin.binding.datasetId,
        keyPin: pin.binding.keyPin,
        rootPin: pin.binding.rootPin
      })
    });
  } catch {
    return result('unavailable');
  } finally {
    operation?.finish(false);
  }
}
