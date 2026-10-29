// @ts-check
// Одноразовая диагностика регистрации OAuth, не подключение диска и не синхронизация.
// Токены после проверки отбрасываются; сервис может сохранить выданное разрешение.
// Исходные ошибки, тело ответа, clientId, идентификатор и токены не журналируются.
import { object } from '../exportSchema.js';
import { validOAuthClientId } from './oauthCommon.js';
import { startCloudOAuth } from './oauthPkce.js';
import { createCloudOAuthTokenTransport } from './oauthTokenTransport.js';
import { createGoogleAccountPreviewReader, createYandexAccountPreviewReader } from './oauthAccountIdentity.js';
import { createNativeOAuthCheckFetch } from './nativeOAuthCheckFetch.js';

const ERROR = 'Не удалось выполнить проверку регистрации диска';
function failed() {
  return new Error(ERROR);
}

function pause(signal, milliseconds) {
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
 * Не принимает токены/секрет приложения, не устанавливает запись в vault, не
 * отправляет и не читает пользовательские файлы. Только один обмен кода; при
 * неоднозначной ошибке сам не повторяет. Отмена в момент обмена не отзывает уже
 * выданное сервисом разрешение и не гарантирует прекращения нативного POST.
 *
 * @param {{provider:'google'|'yandex',clientId:string,invoke:(command:string,args:any)=>Promise<any>,
 * openBrowser:(url:string)=>Promise<any>,signal:AbortSignal,
 * onProgress?:(stage:'browser'|'token'|'identity')=>void, pollIntervalMs?:number, cryptoSource?:Crypto}} options
 * @returns {Promise<{status:'checked',scope:'reported'|'request_bound'|'unverified',label:{kind:string,value:string}|null}|
 * {status:'cancelled'|'denied'|'expired'|'failed'}>}
 */
export async function checkCloudOAuthRegistration(options) {
  let input;
  try {
    input = object(
      options,
      ['provider', 'clientId', 'invoke', 'openBrowser', 'signal'],
      ['onProgress', 'pollIntervalMs', 'cryptoSource']
    );
    if (
      !['google', 'yandex'].includes(input.provider) ||
      !validOAuthClientId(input.provider, input.clientId) ||
      typeof input.invoke !== 'function' ||
      typeof input.openBrowser !== 'function' ||
      !input.signal ||
      typeof input.signal.aborted !== 'boolean' ||
      typeof input.signal.addEventListener !== 'function' ||
      typeof input.signal.removeEventListener !== 'function' ||
      (input.onProgress !== undefined && typeof input.onProgress !== 'function') ||
      (input.pollIntervalMs !== undefined &&
        (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 20 || input.pollIntervalMs > 5000))
    )
      throw failed();
  } catch {
    throw failed();
  }
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const signal = /** @type {AbortSignal} */ (input.signal);
  const interval = /** @type {number} */ (input.pollIntervalMs ?? 500);
  if (signal.aborted) return { status: 'cancelled' };
  let flow = null;
  let lease = null;
  // Отдельный контейнер позволяет сбросить ссылку на токены в finally.
  // Это только best effort: другие копии строк могут оставаться в памяти.
  const sensitive = { secrets: null };
  const cancel = () => {
    // При обмене flow.cancel() запрещён. Его ошибка не означает, что провайдер
    // отменил выдачу токена. createNativeOAuthCheckFetch отбрасывает поздний ответ.
    if (flow) void flow.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const fetchImpl = createNativeOAuthCheckFetch({ provider, invoke: input.invoke, signal });
    input.onProgress?.('browser');
    flow = await startCloudOAuth({
      provider,
      clientId: input.clientId,
      invoke: input.invoke,
      openBrowser: input.openBrowser,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
      requestOffline: false
    });
    if (signal.aborted) {
      cancel();
      return { status: 'cancelled' };
    }
    for (;;) {
      const reply = await flow.poll();
      if (signal.aborted) return { status: 'cancelled' };
      if (reply.status === 'code_ready') break;
      if (reply.status === 'denied') return { status: 'denied' };
      if (reply.status === 'expired') return { status: 'expired' };
      if (reply.status !== 'pending') return { status: 'failed' };
      await pause(signal, interval);
    }
    input.onProgress?.('token');
    if (signal.aborted) return { status: 'cancelled' };
    const tokenTransport = createCloudOAuthTokenTransport({
      provider,
      clientId: input.clientId,
      operation: 'code',
      fetchImpl
    });
    lease = await flow.exchange(request => tokenTransport.send(request));
    if (signal.aborted) return { status: 'cancelled' };
    const summary = lease.summary;
    if (!['reported', 'request_bound', 'unverified'].includes(summary.scope)) return { status: 'failed' };
    sensitive.secrets = lease.takeSecrets();
    input.onProgress?.('identity');
    if (signal.aborted || Date.now() >= summary.expiresAt) return { status: signal.aborted ? 'cancelled' : 'failed' };
    const readIdentity =
      provider === 'google'
        ? createGoogleAccountPreviewReader({ fetchImpl })
        : createYandexAccountPreviewReader({ fetchImpl });
    const identity = await readIdentity({
      accessToken: sensitive.secrets.accessToken,
      clientId: input.clientId,
      signal
    });
    if (signal.aborted || Date.now() >= summary.expiresAt) return { status: signal.aborted ? 'cancelled' : 'failed' };
    // accountKey не возвращаем и не сохраняем. Метка нужна только человеку,
    // показывается текстом и не является закреплением аккаунта.
    return { status: 'checked', scope: summary.scope, label: identity.label };
  } catch {
    return { status: signal.aborted ? 'cancelled' : 'failed' };
  } finally {
    signal.removeEventListener('abort', cancel);
    lease?.discard();
    sensitive.secrets = null;
    // В том числе при ошибке/прерывании callback должен закрыться; после обмена
    // это вызов без действия. Ошибки отмены намеренно не включаются в ответ.
    cancel();
  }
}
