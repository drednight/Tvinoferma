// @ts-check
// Отключённая связка локальных pin аккаунта, набора/корня и доказательства ключа.
// Она не подтверждает независимый источник pin, актуальность облака, сохранность
// backup, согласие пользователя или отсутствие согласованного отката vault.
// Секреты, записи, ID, параметры и исходные ошибки не журналируются.
import { object } from '../exportSchema.js';
import { createNativeDatasetBindingStore } from './nativeDatasetBindingStore.js';
import { createNativeKeyStateStore } from './nativeKeyStateStore.js';
import { readNativeCredentialBinding } from './nativeCredentialStore.js';
import { openNativeCloudSession } from './nativeCloudSession.js';

function failed() {
  return new Error('Не удалось безопасно открыть закреплённую сессию синхронизации');
}
function status(value) {
  return Object.freeze({ status: value });
}
function matchesKey(binding, key) {
  return (
    key.slotId === binding.keySlotId &&
    key.datasetId === binding.datasetId &&
    key.pin.bundleId === binding.keyPin.bundleId &&
    key.pin.sha256 === binding.keyPin.sha256
  );
}

/**
 * Перед открытием и каждым сетевым действием проверяет локальный pin и HMAC ключа.
 * Другая программа и откат между проверкой и сетью не исключены, проверки не CAS.
 * Не создаёт/меняет pin, не выбирает версию и не применяет пользовательские данные.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,
 * cryptoSource?:Crypto,now?:()=>number,timeoutMs?:number}} options
 */
export async function openPinnedNativeCloudSession(options) {
  let input;
  try {
    input = object(options, ['provider', 'invoke'], ['cryptoSource', 'now', 'timeoutMs']);
    if (
      !['google', 'yandex'].includes(input.provider) ||
      typeof input.invoke !== 'function' ||
      (input.now !== undefined && typeof input.now !== 'function') ||
      (input.timeoutMs !== undefined &&
        (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 20 || input.timeoutMs > 120_000))
    )
      throw failed();
  } catch {
    throw failed();
  }
  try {
    const common = { invoke: input.invoke, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) };
    const pins = createNativeDatasetBindingStore({ provider: input.provider, ...common });
    const keys = createNativeKeyStateStore({
      ...common,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
    });
    const pin = /** @type {any} */ (await pins.read());
    if (pin.status === 'empty') return status('binding_missing');
    if (pin.status !== 'ready') return status('binding_blocked');
    const key = /** @type {any} */ (await keys.read());
    if (key.status !== 'ready' || !matchesKey(pin.binding, key.state)) return status('binding_blocked');
    const account = await readNativeCredentialBinding({ provider: input.provider, ...common });
    if (account.status !== 'ready' || account.binding.slotId !== pin.binding.accountSlotId)
      return status('binding_blocked');
    const opened = /** @type {any} */ (
      await openNativeCloudSession({
        ...common,
        provider: input.provider,
        ...account.binding,
        datasetId: pin.binding.datasetId,
        ...(input.provider === 'google' ? { folderId: pin.binding.folderId } : {}),
        ...(input.now ? { now: input.now } : {}),
        ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
      })
    );
    if (opened.status !== 'opened') return opened;
    const base = opened.session;
    let disposed = false;
    let active = false;
    async function stillBound() {
      const currentPin = /** @type {any} */ (await pins.read());
      if (disposed || currentPin.status !== 'ready' || currentPin.raw !== pin.raw) return false;
      const currentKey = /** @type {any} */ (await keys.read());
      return (
        !disposed &&
        currentKey.status === 'ready' &&
        currentKey.raw === key.raw &&
        matchesKey(currentPin.binding, currentKey.state)
      );
    }
    try {
      if (!(await stillBound())) {
        base.dispose();
        return status('binding_blocked');
      }
    } catch {
      base.dispose();
      return status('binding_unavailable');
    }
    async function guard(work, write = false) {
      if (disposed || active) return status('account_unavailable');
      active = true;
      try {
        try {
          if (!(await stillBound())) return status('account_unavailable');
        } catch {
          return status('account_unavailable');
        }
        try {
          return await work();
        } catch {
          return status(write ? 'unknown' : 'unavailable');
        }
      } finally {
        active = false;
      }
    }
    const session = Object.freeze({
      checkAccount() {
        return guard(() => base.checkAccount());
      },
      generateFileId() {
        return guard(() => base.generateFileId());
      },
      upload(args) {
        return guard(() => base.upload(args), true);
      },
      verify(args) {
        return guard(() => base.verify(args));
      },
      listWithDates() {
        return guard(() => base.listWithDates());
      },
      read(versionId) {
        return guard(() => base.read(versionId));
      },
      trashVersion(args) {
        return guard(() => base.trashVersion(args), true);
      },
      dispose() {
        disposed = true;
        base.dispose();
      }
    });
    return Object.freeze({
      status: 'opened',
      datasetId: pin.binding.datasetId,
      rootPin: pin.binding.rootPin,
      keyPin: pin.binding.keyPin,
      session
    });
  } catch {
    return status('binding_unavailable');
  }
}
