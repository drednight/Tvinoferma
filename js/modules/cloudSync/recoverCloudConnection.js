// @ts-check
// Экспериментальное восстановление привязки с другого ПК по независимому коду.
// Только чтение облака и локальное закрепление; state не применяется и облачные
// файлы не меняются. Никакие исходные ошибки, ключи или снимки не журналировать.
import { object } from './exportSchema.js';
import { generateSyncId } from './envelope.js';
import { parsePairingCode } from './pairingCode.js';
import { historyEnvelopePin } from './history.js';
import { openPortableEnvelope, verifyPortableEnvelopeBinding } from './portableKeyCapsule.js';
import { createKeyStateRecord } from './keyStateRecord.js';
import { captureInitialCloudBaseline } from './initialCloudBaseline.js';
import { prepareCloudReview } from './cloudReview.js';
import { createDurableCloudOutbox } from './durableOutbox.js';
import { createDatasetBindingRecord } from './datasetBindingRecord.js';
import { createNativeDatasetBindingStore } from './providers/nativeDatasetBindingStore.js';
import { createNativeKeyStateStore } from './providers/nativeKeyStateStore.js';
import { createNativeOutboxStore } from './providers/nativeOutboxStore.js';
import { readNativeCredentialBinding } from './providers/nativeCredentialStore.js';
import { openStoredNativeCloudSession } from './providers/nativeCloudSession.js';
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
function invalid() {
  return new Error('Не удалось безопасно восстановить синхронизацию');
}
function result(status, extra = {}) {
  return Object.freeze({ status, ...extra });
}
function samePin(left, right, id) {
  return left?.[id] === right?.[id] && left?.sha256 === right?.sha256;
}
function sameAccount(left, right) {
  return left?.slotId === right?.slotId && left?.clientId === right?.clientId && left?.accountKey === right?.accountKey;
}
function manifest(review) {
  return JSON.stringify(review.versions.map(value => [value.pin.versionId, value.pin.sha256]).sort());
}

/**
 * Предварительный просмотр проверяет точный независимый root и все наблюдаемые
 * версии до локальной установки ключа. Совпадение двух списков не доказывает
 * полноту облака. Подключение после просмотра ничего не применяет; отдельная
 * панель сравнения требует явного выбора и создаёт ещё один backup перед записью.
 *
 * На данный момент поддерживается только корень Google «Мой диск» (root) либо
 * app:/ Яндекса. Для старых/перемещённых папок нужен отдельный поиск и сверка.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,
 * cryptoSource?:Crypto,now?:()=>number,timeoutMs?:number,settingsSelections?:string[],
 * openSession?:typeof openStoredNativeCloudSession}} options
 */
export function createCloudRecovery(options) {
  const input = object(
    options,
    ['provider', 'invoke'],
    ['cryptoSource', 'now', 'timeoutMs', 'settingsSelections', 'openSession']
  );
  if (
    !['google', 'yandex'].includes(input.provider) ||
    typeof input.invoke !== 'function' ||
    (input.openSession !== undefined && typeof input.openSession !== 'function') ||
    (input.settingsSelections !== undefined && !Array.isArray(input.settingsSelections))
  )
    throw invalid();
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const common = { invoke: input.invoke, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
  const keyOptions = { ...common, ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}) };
  const cryptoSource = input.cryptoSource;
  const selection = input.settingsSelections ? [...input.settingsSelections] : [];
  const other = provider === 'google' ? 'yandex' : 'google';
  let active = false;

  async function inspectLocal() {
    const account = await readNativeCredentialBinding({ provider, ...common });
    if (account.status !== 'ready') return result('credential_missing_or_blocked');
    const keys = createNativeKeyStateStore(keyOptions);
    const key = await keys.read();
    if (!['empty', 'ready'].includes(key.status)) return result('key_blocked');
    const pins = createNativeDatasetBindingStore({ provider, ...common });
    const pin = await pins.read();
    const otherPin = await createNativeDatasetBindingStore({ provider: other, ...common }).read();
    if (pin.status !== 'empty' || otherPin.status !== 'empty') return result('dataset_binding_present');
    const head = await createNativeOutboxStore({ provider, ...common }).read();
    const otherHead = await createNativeOutboxStore({ provider: other, ...common }).read();
    if (otherHead.status !== 'empty') return result('other_queue_present_or_blocked');
    if (!['empty', 'ready'].includes(head.status)) return result('queue_blocked');
    return { status: 'ready', account: account.binding, keys, key, pins, head };
  }

  return Object.freeze({
    /**
     * Код получают по независимому каналу от уже настроенного ПК. `existing`
     * использует уже сохранённый внутренний ключ, не требуя утерянный пароль;
     * main/backup расшифровывают обёртку из облака. Сами секреты не сохраняются.
     * @param {{pairingCode:string,independentPinConfirmed:boolean,role:'main'|'backup'|'existing',secret:string}} value
     */
    async begin(value) {
      const params = object(value, ['pairingCode', 'independentPinConfirmed', 'role', 'secret']);
      if (
        params.independentPinConfirmed !== true ||
        !['main', 'backup', 'existing'].includes(params.role) ||
        typeof params.secret !== 'string'
      )
        throw invalid();
      const pairing = /** @type {any} */ (parsePairingCode(params.pairingCode));
      if (active) return result('busy');
      active = true;
      let operation;
      let baseline = null;
      let session = null;
      let dataKey = null;
      let bundle = null;
      let handedOff = false;
      let uncertain = false;
      let uncertainRefresh = false;
      try {
        operation = beginCloudDataOperation();
        const local = /** @type {any} */ (await inspectLocal());
        if (local.status !== 'ready') return result(local.status);
        if (local.key.status === 'ready' && params.role !== 'existing')
          return result('existing_key_requires_confirmation');
        if (local.key.status === 'empty' && params.role === 'existing') return result('key_missing');
        if (local.head.status === 'ready' && local.head.datasetId !== pairing.datasetId) return result('queue_blocked');
        baseline = await captureInitialCloudBaseline({ settingsSelections: selection });
        if (baseline.status !== 'ready') return baseline;
        const sessionOptions = {
          provider,
          datasetId: pairing.datasetId,
          ...keyOptions,
          ...(provider === 'google' ? { folderId: 'root' } : {}),
          ...(input.now ? { now: input.now } : {})
        };
        uncertainRefresh = provider === 'google';
        const opened = /** @type {any} */ (await (input.openSession || openStoredNativeCloudSession)(sessionOptions));
        if (opened.status !== 'opened') return result(opened.status || 'unavailable');
        uncertainRefresh = false;
        session = opened.session;
        const received = await session.read(pairing.rootPin.versionId);
        if (received.status !== 'found') return result('root_unavailable');
        const observed = await historyEnvelopePin({
          envelope: received.envelope,
          expectedDatasetId: pairing.datasetId,
          ...(cryptoSource ? { cryptoSource } : {})
        });
        if (!samePin(observed, pairing.rootPin, 'versionId')) return result('root_mismatch');
        if (local.key.status === 'ready') {
          if (
            local.key.state.datasetId !== pairing.datasetId ||
            !samePin(local.key.state.pin, pairing.keyPin, 'bundleId')
          )
            return result('key_mismatch');
          await verifyPortableEnvelopeBinding({
            envelope: received.envelope,
            dataKey: local.key.state.dataKey,
            expectedPin: pairing.keyPin,
            ...(cryptoSource ? { cryptoSource } : {})
          });
          dataKey = local.key.state.dataKey;
          bundle = local.key.state.bundle;
        } else {
          try {
            const unlocked = await openPortableEnvelope({
              envelope: received.envelope,
              expectedDatasetId: pairing.datasetId,
              expectedPin: pairing.keyPin,
              role: params.role,
              secret: params.secret,
              ...(cryptoSource ? { cryptoSource } : {})
            });
            dataKey = unlocked.dataKey;
            bundle = unlocked.bundle;
          } catch {
            return result('invalid_secret_or_file');
          }
        }
        if (!(await baseline.stillCurrentAndSaved())) return result('state_changed');
        const review = await prepareCloudReview({
          provider,
          session,
          datasetId: pairing.datasetId,
          dataKey,
          rootPin: pairing.rootPin,
          knownPins: [pairing.rootPin],
          localSnapshot: baseline.getPublicSnapshot(),
          localSavedAt: baseline.localSavedAt,
          ...(cryptoSource ? { cryptoSource } : {}),
          ...(input.now ? { now: input.now } : {})
        });
        if (review.status !== 'ready_for_review') return result(review.status);
        if (!(await baseline.stillCurrentAndSaved())) return result('state_changed');
        session.dispose();
        session = null;
        let phase = 'prepared';
        const expectedAccount = local.account;
        const expectedKeyRaw = local.key.status === 'ready' ? local.key.raw : null;
        const expectedManifest = manifest(review);
        const close = () => {
          baseline?.close?.();
          baseline = null;
          session?.dispose?.();
          session = null;
          dataKey = null;
          bundle = null;
          phase = 'closed';
          operation.finish(uncertain || uncertainRefresh);
          active = false;
        };
        const attempt = Object.freeze({
          status: 'ready_for_confirmation',
          review,
          backup: baseline.backup,
          cancel() {
            if (phase === 'running') return result('in_progress');
            if (phase !== 'prepared') return result('closed');
            close();
            return result('cancelled');
          },
          /** @param {{confirmed:boolean}} confirmation */
          async connect(confirmation) {
            const answer = object(confirmation, ['confirmed']);
            if (answer.confirmed !== true) return result('confirmation_required');
            if (phase !== 'prepared') return result(phase === 'running' ? 'in_progress' : 'closed');
            phase = 'running';
            try {
              if (!(await baseline.stillCurrentAndSaved())) {
                close();
                return result('state_changed');
              }
              const current = /** @type {any} */ (await inspectLocal());
              if (current.status !== 'ready' || !sameAccount(current.account, expectedAccount)) {
                close();
                return result('local_binding_changed');
              }
              if (
                (expectedKeyRaw === null && current.key.status !== 'empty') ||
                (expectedKeyRaw !== null && (current.key.status !== 'ready' || current.key.raw !== expectedKeyRaw)) ||
                (current.head.status === 'ready' && current.head.datasetId !== pairing.datasetId)
              ) {
                close();
                return result('local_binding_changed');
              }
              uncertainRefresh = provider === 'google';
              const reopened = /** @type {any} */ (
                await (input.openSession || openStoredNativeCloudSession)(sessionOptions)
              );
              if (reopened.status !== 'opened') {
                close();
                return result(reopened.status || 'unavailable');
              }
              uncertainRefresh = false;
              session = reopened.session;
              const repeated = await prepareCloudReview({
                provider,
                session,
                datasetId: pairing.datasetId,
                dataKey,
                rootPin: pairing.rootPin,
                knownPins: [pairing.rootPin],
                localSnapshot: baseline.getPublicSnapshot(),
                localSavedAt: baseline.localSavedAt,
                ...(cryptoSource ? { cryptoSource } : {}),
                ...(input.now ? { now: input.now } : {})
              });
              if (repeated.status !== 'ready_for_review' || manifest(repeated) !== expectedManifest) {
                close();
                return result('cloud_changed');
              }
              session.dispose();
              session = null;
              if (!(await baseline.stillCurrentAndSaved())) {
                close();
                return result('state_changed');
              }
              let keyState;
              if (expectedKeyRaw === null) {
                const prepared = await createKeyStateRecord(
                  {
                    slotId: generateSyncId(cryptoSource),
                    revision: generateSyncId(cryptoSource),
                    datasetId: pairing.datasetId,
                    bundle,
                    pin: pairing.keyPin,
                    dataKey
                  },
                  cryptoSource
                );
                uncertain = true;
                const installed = await current.keys.install(prepared.state);
                if (installed.status === 'occupied' || installed.status === 'blocked') {
                  uncertain = false;
                  close();
                  return result('key_not_installed');
                }
                if (installed.status !== 'installed') throw invalid();
                const checked = await current.keys.read();
                if (checked.status !== 'ready' || checked.raw !== prepared.raw) throw invalid();
                keyState = checked.state;
                uncertain = false;
              } else {
                keyState = current.key.state;
              }
              const guard = {
                accountSlotId: current.account.slotId,
                keySlotId: keyState.slotId,
                bundleId: keyState.pin.bundleId,
                fingerprint: keyState.pin.sha256
              };
              const store = createNativeOutboxStore({ provider, ...common, initialGuard: guard });
              const deviceId = current.head.status === 'ready' ? current.head.deviceId : generateSyncId(cryptoSource);
              const slotId = current.head.status === 'ready' ? current.head.slotId : generateSyncId(cryptoSource);
              const outbox = createDurableCloudOutbox({
                provider,
                datasetId: pairing.datasetId,
                deviceId,
                slotId,
                clientId: current.account.clientId,
                accountKey: current.account.accountKey,
                dataKey,
                store,
                session: NO_NETWORK,
                ...(provider === 'google' ? { folderId: 'root' } : {}),
                ...(cryptoSource ? { cryptoSource } : {})
              });
              if (current.head.status === 'empty') {
                const initialized = await outbox.initializeRecovered(true);
                if (initialized.status === 'journal_uncertain') {
                  uncertain = true;
                  close();
                  return result('setup_uncertain');
                }
                if (initialized.status !== 'initialized') {
                  close();
                  return result('queue_not_initialized');
                }
              } else if ((await outbox.recoveryInitializationEmpty()).status !== 'empty') {
                close();
                return result('queue_blocked');
              }
              const binding = createDatasetBindingRecord({
                provider,
                accountSlotId: current.account.slotId,
                keySlotId: keyState.slotId,
                datasetId: pairing.datasetId,
                keyPin: pairing.keyPin,
                rootPin: pairing.rootPin,
                ...(provider === 'google' ? { folderId: 'root' } : {})
              });
              uncertain = true;
              const installed = await current.pins.install(binding.binding, true);
              if (installed.status === 'occupied' || installed.status === 'blocked') {
                uncertain = false;
                close();
                return result('binding_not_installed');
              }
              if (installed.status !== 'installed') throw invalid();
              const saved = await current.pins.read();
              if (saved.status !== 'ready' || saved.raw !== binding.raw) throw invalid();
              uncertain = false;
              const backup = baseline.backup;
              close();
              return result('connected', { backup, review: repeated });
            } catch {
              close();
              return result(uncertain || uncertainRefresh ? 'setup_uncertain' : 'unavailable');
            }
          }
        });
        handedOff = true;
        return attempt;
      } catch {
        return result('unavailable');
      } finally {
        if (!handedOff) {
          baseline?.close?.();
          session?.dispose?.();
          dataKey = null;
          bundle = null;
          operation?.finish(uncertain || uncertainRefresh);
          active = false;
        }
      }
    }
  });
}
