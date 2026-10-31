// @ts-check
// Узкий адаптер обмена кода и предпросмотра аккаунта: диагностика и отключённый
// эксперимент подключения. Сам он не сохраняет токены и не вызывает операции
// с файлами. Настоящий HTTPS и проверки выполняет Rust; входы, ответы и ошибки
// не журналируются.
import { object } from '../exportSchema.js';
import { OAUTH_PROVIDERS } from './oauthCommon.js';
import { nativeOAuthDiagnostic } from './oauthDiagnostics.js';

const GOOGLE_IDENTITY = 'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%2CemailAddress%29';
const YANDEX_IDENTITY = 'https://login.yandex.ru/info?format=json';
const MAX_RESPONSE_BYTES = 64 * 1024;
const ERROR = 'Не удалось безопасно выполнить запрос авторизации';

function failed() {
  return new Error(ERROR);
}

/**
 * Создаёт подобие fetch только для существующих валидаторов одноразового обмена
 * и предпросмотра аккаунта. Он не выполняет refresh или файловые операции.
 * Отмена прекращает ожидание в JS, но не обещает
 * отменить уже отправленный нативный запрос: провайдер мог выдать разрешение.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:object)=>Promise<unknown>,signal:AbortSignal,onDiagnostic?:(code:string)=>void}} options
 * @returns {typeof fetch}
 */
export function createNativeOAuthCheckFetch(options) {
  let input;
  try {
    input = object(options, ['provider', 'invoke', 'signal'], ['onDiagnostic']);
    if (
      !['google', 'yandex'].includes(input.provider) ||
      typeof input.invoke !== 'function' ||
      (input.onDiagnostic !== undefined && typeof input.onDiagnostic !== 'function') ||
      !input.signal ||
      typeof input.signal.aborted !== 'boolean' ||
      typeof input.signal.addEventListener !== 'function' ||
      typeof input.signal.removeEventListener !== 'function'
    )
      throw failed();
  } catch {
    throw failed();
  }
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const outerSignal = /** @type {AbortSignal} */ (input.signal);
  const invoke = /** @type {(command:string,args:object)=>Promise<unknown>} */ (input.invoke);

  return /** @type {typeof fetch} */ (
    async (url, init) => {
      let request;
      let headers;
      let operation;
      let form = null;
      let accessToken = null;
      try {
        if (typeof url !== 'string') throw failed();
        request = object(
          init,
          ['method', 'headers', 'redirect', 'credentials', 'cache', 'referrerPolicy', 'signal'],
          ['body']
        );
        if (
          request.redirect !== 'error' ||
          request.credentials !== 'omit' ||
          request.cache !== 'no-store' ||
          request.referrerPolicy !== 'no-referrer' ||
          !request.signal ||
          typeof request.signal.aborted !== 'boolean' ||
          typeof request.signal.addEventListener !== 'function' ||
          typeof request.signal.removeEventListener !== 'function' ||
          outerSignal.aborted ||
          request.signal.aborted
        )
          throw failed();
        if (url === OAUTH_PROVIDERS[provider].token && request.method === 'POST') {
          headers = object(request.headers, ['Content-Type', 'Accept']);
          if (
            headers['Content-Type'] !== 'application/x-www-form-urlencoded' ||
            headers.Accept !== 'application/json' ||
            typeof request.body !== 'string' ||
            request.body.length > 32 * 1024 ||
            !/^[\x21-\x7e]+$/.test(request.body)
          )
            throw failed();
          operation = 'exchange';
          form = request.body;
        } else if (
          url === (provider === 'google' ? GOOGLE_IDENTITY : YANDEX_IDENTITY) &&
          request.method === 'GET' &&
          !Object.hasOwn(request, 'body')
        ) {
          headers = object(request.headers, ['Accept', 'Authorization']);
          const prefix = provider === 'google' ? 'Bearer ' : 'OAuth ';
          if (
            headers.Accept !== 'application/json' ||
            typeof headers.Authorization !== 'string' ||
            !headers.Authorization.startsWith(prefix)
          )
            throw failed();
          accessToken = headers.Authorization.slice(prefix.length);
          if (accessToken.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(accessToken)) throw failed();
          operation = 'identity';
        } else throw failed();
      } catch {
        throw failed();
      }

      const localSignal = /** @type {AbortSignal} */ (request.signal);
      // Нативная команда ограничивает запрос по времени и не выполняет повторы.
      // Даже если оба signal отменены, завершение IPC может прийти позднее; в таком
      // случае тело ответа не возвращается вызывающему коду.
      return new Promise((resolve, reject) => {
        let finished = false;
        const cleanup = () => {
          outerSignal.removeEventListener('abort', onAbort);
          localSignal.removeEventListener('abort', onAbort);
        };
        const rejectOnce = (error = undefined) => {
          if (finished) return;
          finished = true;
          cleanup();
          try {
            input.onDiagnostic?.(nativeOAuthDiagnostic(error));
          } catch {
            /* diagnostic only */
          }
          reject(failed());
        };
        const onAbort = () => rejectOnce();
        try {
          outerSignal.addEventListener('abort', onAbort, { once: true });
          localSignal.addEventListener('abort', onAbort, { once: true });
          if (outerSignal.aborted || localSignal.aborted) return rejectOnce();
          Promise.resolve()
            .then(() => {
              if (finished || outerSignal.aborted || localSignal.aborted) throw failed();
              return invoke('cloud_oauth_network', { provider, operation, form, accessToken, refreshClaim: null });
            })
            .then(reply => {
              if (finished || outerSignal.aborted || localSignal.aborted) return rejectOnce();
              const value = object(reply, ['body', 'contentType']);
              if (
                typeof value.body !== 'string' ||
                typeof value.contentType !== 'string' ||
                value.contentType.length > 256
              )
                throw failed();
              const bytes = new TextEncoder().encode(value.body);
              if (bytes.byteLength > MAX_RESPONSE_BYTES) {
                bytes.fill(0);
                throw failed();
              }
              const responseHeaders = new Headers({
                'content-type': value.contentType,
                'content-length': String(bytes.byteLength)
              });
              const body = new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
                cancel() {
                  bytes.fill(0);
                }
              });
              finished = true;
              cleanup();
              resolve(
                /** @type {Response} */ (
                  /** @type {unknown} */ ({
                    status: 200,
                    redirected: false,
                    type: 'basic',
                    url,
                    headers: responseHeaders,
                    body
                  })
                )
              );
            })
            .catch(rejectOnce);
        } catch {
          rejectOnce();
        }
      });
    }
  );
}
