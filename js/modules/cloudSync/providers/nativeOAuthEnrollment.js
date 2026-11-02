// @ts-check
// Сквозной ЭКСПЕРИМЕНТ первого подключения через нативный журнал и PKCE.
// Вызывается из настроек по отдельному согласию, но настоящие токены, собранные
// Windows/Tauri, восстановление после сбоев и оба провайдера ещё не испытаны.
// Здесь нет передачи файлов, пароля шифрования, очереди или применения данных.
// Токены, ответы, подписи, accountKey и исходные ошибки никогда не журналируются.
import { rememberGoogleAccess } from './googleAccessMemory.js';
import { createNativeGoogleReconnectInstaller } from './nativeGoogleReconnection.js';
import { parseGoogleCredentialRecord } from './oauthCredentialRecord.js';
import { object } from '../exportSchema.js';
import { createOAuthDiagnostics } from './oauthDiagnostics.js';
import { validOAuthClientId } from './oauthCommon.js';
import { startCloudOAuth } from './oauthPkce.js';
import { createCloudOAuthTokenTransport } from './oauthTokenTransport.js';
import { createGoogleAccountPreviewReader, createYandexAccountPreviewReader } from './oauthAccountIdentity.js';
import { createNativeOAuthCheckFetch } from './nativeOAuthCheckFetch.js';
import { createGoogleEnrollmentAttempt, createYandexEnrollmentAttempt } from './oauthCredentialEnrollment.js';
import {
  createNativeCredentialInstaller,
  inspectNativeCredential,
  readNativeCredentialBinding
} from './nativeCredentialStore.js';

const ERROR = 'Не удалось безопасно подготовить подключение облачного диска';
function failed() {
  return new Error(ERROR);
}
function result(status) {
  return Object.freeze({ status });
}
function wait(signal, milliseconds) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(failed());
    const end = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      end();
      reject(failed());
    };
    const timer = setTimeout(() => {
      end();
      resolve(undefined);
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/**
 * Только по явной инициативе пользователя после предупреждения о возможной
 * старой/утраченной записи и отдельного сравнения метки аккаунта в confirmAccount.
 * `firstConnectionConfirmed` не доказывает фактического отсутствия старых данных.
 * При `installation_uncertain` повторять попытку автоматически запрещено.
 * Отмена в процессе записи не объявляет операцию отменённой: она могла завершиться.
 * Отмена обмена также не отзывает разрешение у провайдера.
 *
 * @param {{provider:'google'|'yandex',clientId:string,invoke:(command:string,args:any)=>Promise<any>,
 * openBrowser:(url:string)=>Promise<any>,signal:AbortSignal,firstConnectionConfirmed:boolean,
 * confirmAccount:(args:any)=>Promise<boolean>,onProgress?:(stage:string)=>void,
 * cryptoSource?:Crypto,reconnect?:boolean,pollIntervalMs?:number,storeTimeoutMs?:number}} options
 */
export async function enrollNativeCloudAccount(options) {
  let input;
  try {
    input = object(
      options,
      ['provider', 'clientId', 'invoke', 'openBrowser', 'signal', 'firstConnectionConfirmed', 'confirmAccount'],
      ['onProgress', 'cryptoSource', 'pollIntervalMs', 'storeTimeoutMs', 'reconnect']
    );
    if (
      (input.reconnect !== undefined && typeof input.reconnect !== 'boolean') ||
      (input.reconnect === true && input.provider !== 'google') ||
      !['google', 'yandex'].includes(input.provider) ||
      !validOAuthClientId(input.provider, input.clientId) ||
      typeof input.invoke !== 'function' ||
      typeof input.openBrowser !== 'function' ||
      typeof input.confirmAccount !== 'function' ||
      input.firstConnectionConfirmed !== true ||
      !input.signal ||
      typeof input.signal.aborted !== 'boolean' ||
      typeof input.signal.addEventListener !== 'function' ||
      typeof input.signal.removeEventListener !== 'function' ||
      (input.onProgress !== undefined && typeof input.onProgress !== 'function') ||
      (input.pollIntervalMs !== undefined &&
        (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 20 || input.pollIntervalMs > 5000)) ||
      (input.storeTimeoutMs !== undefined &&
        (!Number.isSafeInteger(input.storeTimeoutMs) || input.storeTimeoutMs < 20 || input.storeTimeoutMs > 120_000))
    )
      throw failed();
  } catch {
    throw failed();
  }
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const signal = /** @type {AbortSignal} */ (input.signal);
  const interval = /** @type {number} */ (input.pollIntervalMs ?? 500);
  if (signal.aborted) return result('cancelled');
  let flow = null;
  let lease = null;
  let attempt = null;
  let freshAccess = null;
  let installationStarted = false;
  let clientId = input.clientId;
  const cancel = () => {
    // В install-стадии попытка возвращает installation_in_progress и не делает
    // ложное утверждение, будто native-запись или ответ провайдера отменены.
    attempt?.cancel();
    if (flow) void flow.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const diagnostics = createOAuthDiagnostics();
  const progress = stage => {
    diagnostics.progress(stage);
    input.onProgress?.(stage);
  };
  try {
    progress('checking_local');
    const storageOptions = {
      provider,
      invoke: input.invoke,
      ...(input.storeTimeoutMs === undefined ? {} : { timeoutMs: input.storeTimeoutMs })
    };
    const local = await inspectNativeCredential(storageOptions);
    if (signal.aborted) return result('cancelled');
    let signedOut = null;
    if (local.status === 'signed_out') {
      const observed = await readNativeCredentialBinding(storageOptions);
      if (observed.status !== 'signed_out' || !observed.binding?.logoutId) return result('local_blocked');
      // Yandex psuid belongs to an OAuth client. Reuse the trusted binding's client,
      // never rewrite the account/slot to match a different client's identity.
      if (provider === 'yandex') clientId = observed.binding.clientId;
      else if (observed.binding.clientId !== clientId) return result('account_changed');
      signedOut = observed.binding;
    }
    let reconnectRecord = null;
    let reconnectInstaller = null;
    if (input.reconnect === true && ['configured', 'pending'].includes(local.status)) {
      let timer;
      let existing;
      try {
        existing = object(
          await Promise.race([
            Promise.resolve().then(() => input.invoke('cloud_credential_read', { provider: 'google' })),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(failed()), input.storeTimeoutMs ?? 25000);
            })
          ]),
          ['status', 'slotId', 'record']
        );
      } finally {
        clearTimeout(timer);
      }
      if (signal.aborted) return result('cancelled');
      if (existing.status !== 'ready') return result('local_blocked');
      reconnectRecord = parseGoogleCredentialRecord(existing.record);
      if (reconnectRecord.slotId !== existing.slotId || reconnectRecord.clientId !== input.clientId)
        return result('account_changed');
      reconnectInstaller = createNativeGoogleReconnectInstaller({
        invoke: input.invoke,
        expected: existing.record,
        ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
        ...(input.storeTimeoutMs === undefined ? {} : { timeoutMs: input.storeTimeoutMs })
      });
    } else {
      if (input.reconnect === true) return result('local_blocked');
      if (local.status === 'configured') return result('already_configured');
      if (local.status !== 'empty' && !signedOut) return result('local_blocked');
    }
    const fetchImpl = createNativeOAuthCheckFetch({
      provider,
      invoke: input.invoke,
      signal,
      onDiagnostic: diagnostics.native
    });
    progress('browser');
    flow = await startCloudOAuth({
      provider,
      clientId,
      invoke: input.invoke,
      openBrowser: input.openBrowser,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
      requestOffline: true,
      forceConsent: true
    });
    if (signal.aborted) {
      cancel();
      return result('cancelled');
    }
    for (;;) {
      const reply = await flow.poll();
      if (signal.aborted) return result('cancelled');
      if (reply.status === 'code_ready') break;
      if (reply.status === 'denied') return result('denied');
      if (reply.status === 'expired') return result('expired');
      if (reply.status !== 'pending') return result('failed');
      await wait(signal, interval);
    }
    progress('token');
    if (signal.aborted) return result('cancelled');
    const tokenTransport = createCloudOAuthTokenTransport({
      provider,
      clientId,
      operation: 'code',
      fetchImpl
    });
    lease = await flow.exchange(request => tokenTransport.send(request));
    if (signal.aborted) return result('cancelled');
    const previewAccount =
      provider === 'google'
        ? createGoogleAccountPreviewReader({ fetchImpl })
        : createYandexAccountPreviewReader({ fetchImpl });
    const nativeInstaller =
      reconnectInstaller ||
      createNativeCredentialInstaller({ ...storageOptions, ...(signedOut ? { resume: signedOut } : {}) });
    let verifiedGoogleRecord = null;
    const installer = Object.freeze({
      installIfAbsent(args) {
        installationStarted = true;
        progress('installing');
        return nativeInstaller.installIfAbsent(args);
      },
      async verifyInstallation(args) {
        const verified = await nativeInstaller.verifyInstallation(args);
        if (verified && provider === 'google')
          verifiedGoogleRecord = reconnectInstaller ? reconnectInstaller.takeVerifiedRecord() : args.record;
        return verified;
      }
    });
    let accountChanged = false;
    const create = provider === 'google' ? createGoogleEnrollmentAttempt : createYandexEnrollmentAttempt;
    attempt = create({
      clientId,
      tokenResponse: {
        summary: lease.summary,
        takeSecrets() {
          const secrets = lease.takeSecrets();
          freshAccess = secrets.accessToken;
          return secrets;
        },
        discard() {
          lease.discard();
        }
      },
      async previewAccount(args) {
        progress('identity');
        const identity = await previewAccount(args);
        if (
          (reconnectRecord && identity.accountKey !== reconnectRecord.accountKey) ||
          (signedOut && identity.accountKey !== signedOut.accountKey)
        ) {
          accountChanged = true;
          throw failed();
        }
        return identity;
      },
      confirmAccount(args) {
        progress('confirming');
        return input.confirmAccount(args);
      },
      installer,
      ...(signedOut ? { slotId: signedOut.slotId } : {}),
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
    });
    if (signal.aborted) {
      cancel();
      return result('cancelled');
    }
    // Не подменяем фактический ответ на `cancelled` после начала установки.
    const completed = await attempt.complete();
    if (accountChanged) return result('account_changed');
    if (completed.status === 'installed' && provider === 'google' && verifiedGoogleRecord && !signal.aborted) {
      try {
        rememberGoogleAccess({
          invoke: input.invoke,
          record: verifiedGoogleRecord,
          accessToken: freshAccess,
          expiresAt: lease.summary.expiresAt
        });
      } catch {
        /* An optional memory optimization cannot undo a verified installation. */
      }
    }
    verifiedGoogleRecord = null;
    return completed.status === 'failed' ? diagnostics.failure() : completed;
  } catch {
    if (installationStarted) return result('installation_uncertain');
    return signal.aborted ? result('cancelled') : diagnostics.failure();
  } finally {
    // Explicitly release the secret captured by the token-response closure.
    // eslint-disable-next-line no-useless-assignment
    freshAccess = null;
    signal.removeEventListener('abort', cancel);
    lease?.discard();
    if (flow) void flow.cancel().catch(() => {});
  }
}
