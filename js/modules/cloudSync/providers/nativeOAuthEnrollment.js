// @ts-check
// Сквозной ЭКСПЕРИМЕНТ первого подключения через нативный журнал и PKCE.
// Не подключён к UI и не использовался с реальными токенами: нужны проверенная
// Windows/Tauri-сборка, восстановление после сбоев и испытания обоих провайдеров.
// Здесь нет передачи файлов, пароля шифрования, очереди или применения данных.
// Токены, ответы, подписи, accountKey и исходные ошибки никогда не журналируются.
import { object } from '../exportSchema.js';
import { validOAuthClientId } from './oauthCommon.js';
import { startCloudOAuth } from './oauthPkce.js';
import { createCloudOAuthTokenTransport } from './oauthTokenTransport.js';
import { createGoogleAccountPreviewReader, createYandexAccountPreviewReader } from './oauthAccountIdentity.js';
import { createNativeOAuthCheckFetch } from './nativeOAuthCheckFetch.js';
import { createGoogleEnrollmentAttempt, createYandexEnrollmentAttempt } from './oauthCredentialEnrollment.js';
import { createNativeCredentialInstaller, inspectNativeCredential } from './nativeCredentialStore.js';

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
 * cryptoSource?:Crypto,pollIntervalMs?:number,storeTimeoutMs?:number}} options
 */
export async function enrollNativeCloudAccount(options) {
  let input;
  try {
    input = object(
      options,
      ['provider', 'clientId', 'invoke', 'openBrowser', 'signal', 'firstConnectionConfirmed', 'confirmAccount'],
      ['onProgress', 'cryptoSource', 'pollIntervalMs', 'storeTimeoutMs']
    );
    if (
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
  let installationStarted = false;
  const cancel = () => {
    // В install-стадии попытка возвращает installation_in_progress и не делает
    // ложное утверждение, будто native-запись или ответ провайдера отменены.
    attempt?.cancel();
    if (flow) void flow.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    input.onProgress?.('checking_local');
    const storageOptions = {
      provider,
      invoke: input.invoke,
      ...(input.storeTimeoutMs === undefined ? {} : { timeoutMs: input.storeTimeoutMs })
    };
    const local = await inspectNativeCredential(storageOptions);
    if (signal.aborted) return result('cancelled');
    if (local.status === 'configured') return result('already_configured');
    if (local.status !== 'empty') return result('local_blocked');
    const fetchImpl = createNativeOAuthCheckFetch({ provider, invoke: input.invoke, signal });
    input.onProgress?.('browser');
    flow = await startCloudOAuth({
      provider,
      clientId: input.clientId,
      invoke: input.invoke,
      openBrowser: input.openBrowser,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
      requestOffline: true,
      ...(provider === 'google' ? { forceConsent: true } : {})
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
    input.onProgress?.('token');
    if (signal.aborted) return result('cancelled');
    const tokenTransport = createCloudOAuthTokenTransport({
      provider,
      clientId: input.clientId,
      operation: 'code',
      fetchImpl
    });
    lease = await flow.exchange(request => tokenTransport.send(request));
    if (signal.aborted) return result('cancelled');
    const previewAccount =
      provider === 'google'
        ? createGoogleAccountPreviewReader({ fetchImpl })
        : createYandexAccountPreviewReader({ fetchImpl });
    const nativeInstaller = createNativeCredentialInstaller(storageOptions);
    const installer = Object.freeze({
      installIfAbsent(args) {
        installationStarted = true;
        input.onProgress?.('installing');
        return nativeInstaller.installIfAbsent(args);
      },
      verifyInstallation(args) {
        return nativeInstaller.verifyInstallation(args);
      }
    });
    const create = provider === 'google' ? createGoogleEnrollmentAttempt : createYandexEnrollmentAttempt;
    attempt = create({
      clientId: input.clientId,
      tokenResponse: lease,
      previewAccount(args) {
        input.onProgress?.('identity');
        return previewAccount(args);
      },
      confirmAccount(args) {
        input.onProgress?.('confirming');
        return input.confirmAccount(args);
      },
      installer,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
    });
    if (signal.aborted) {
      cancel();
      return result('cancelled');
    }
    // Не подменяем фактический ответ на `cancelled` после начала установки.
    return await attempt.complete();
  } catch {
    return result(installationStarted ? 'installation_uncertain' : signal.aborted ? 'cancelled' : 'failed');
  } finally {
    signal.removeEventListener('abort', cancel);
    lease?.discard();
    if (flow) void flow.cancel().catch(() => {});
  }
}
