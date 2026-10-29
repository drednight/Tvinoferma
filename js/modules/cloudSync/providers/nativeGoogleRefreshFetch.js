// @ts-check
// Узкий экспериментальный мост refresh Google. НЕ подключён к UI и реальным
// токенам. Вызывающий обязан до POST надёжно зафиксировать pending и после
// неопределённости не повторять попытку. Этот мост и сам IPC этого не доказывают.
// Токены, формы, ответы и исходные ошибки нельзя журналировать.
import { object } from '../exportSchema.js';
import { OAUTH_PROVIDERS, validOAuthClientId } from './oauthCommon.js';

const ERROR = 'Не удалось безопасно выполнить обновление доступа к диску';
const MAX_FORM = 32 * 1024;
const MAX_REPLY = 64 * 1024;
function failed() {
  return new Error(ERROR);
}
function requestFor(url, init) {
  const request = object(init, [
    'method',
    'headers',
    'redirect',
    'credentials',
    'cache',
    'referrerPolicy',
    'signal',
    'body'
  ]);
  const headers = object(request.headers, ['Content-Type', 'Accept']);
  if (
    url !== OAUTH_PROVIDERS.google.token ||
    request.method !== 'POST' ||
    headers['Content-Type'] !== 'application/x-www-form-urlencoded' ||
    headers.Accept !== 'application/json' ||
    request.redirect !== 'error' ||
    request.credentials !== 'omit' ||
    request.cache !== 'no-store' ||
    request.referrerPolicy !== 'no-referrer' ||
    !request.signal ||
    typeof request.signal.aborted !== 'boolean' ||
    typeof request.signal.addEventListener !== 'function' ||
    typeof request.signal.removeEventListener !== 'function' ||
    request.signal.aborted ||
    typeof request.body !== 'string' ||
    request.body.length > MAX_FORM ||
    !/^[\x21-\x7e]+$/.test(request.body)
  )
    throw failed();
  const params = new URLSearchParams(request.body);
  const keys = [...params.keys()];
  const secret = params.get('refresh_token');
  if (
    params.toString() !== request.body ||
    keys.length !== 3 ||
    new Set(keys).size !== 3 ||
    keys.some(key => !['grant_type', 'client_id', 'refresh_token'].includes(key)) ||
    params.get('grant_type') !== 'refresh_token' ||
    !validOAuthClientId('google', params.get('client_id')) ||
    typeof secret !== 'string' ||
    !secret ||
    secret.length > 8192 ||
    !/^[\x21-\x7e]+$/.test(secret)
  )
    throw failed();
  return { form: request.body, signal: /** @type {AbortSignal} */ (request.signal) };
}
function checkedReply(value, url) {
  const reply = object(value, ['body', 'contentType']);
  if (
    typeof reply.body !== 'string' ||
    typeof reply.contentType !== 'string' ||
    !reply.contentType ||
    reply.contentType.length > 256
  )
    throw failed();
  const bytes = new TextEncoder().encode(reply.body);
  if (bytes.byteLength > MAX_REPLY) {
    bytes.fill(0);
    throw failed();
  }
  const headers = new Headers({ 'content-type': reply.contentType, 'content-length': String(bytes.byteLength) });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
    cancel() {
      bytes.fill(0);
    }
  });
  return /** @type {Response} */ (
    /** @type {unknown} */ ({ status: 200, redirected: false, type: 'basic', url, headers, body })
  );
}

/**
 * Подобие fetch только для фиксированного refresh Google. Пока IPC не завершился,
 * слот остаётся занят даже после отмены ожидания; уже переданный POST отменить нельзя.
 * Хранилище, его устойчивость и согласие пользователя этот объект не проверяет.
 * @param {{invoke:(command:string,args:any)=>Promise<unknown>}} options
 * @returns {typeof fetch}
 */
export function createNativeGoogleRefreshFetch(options) {
  let invoke;
  try {
    const input = object(options, ['invoke']);
    if (typeof input.invoke !== 'function') throw failed();
    invoke = input.invoke;
  } catch {
    throw failed();
  }
  let active = false;
  return /** @type {typeof fetch} */ (
    async (url, init) => {
      let request;
      try {
        request = requestFor(url, init);
        if (active) throw failed();
      } catch {
        throw failed();
      }
      active = true;
      return new Promise((resolve, reject) => {
        let finished = false;
        const end = () => request.signal.removeEventListener('abort', abort);
        const rejectOnce = () => {
          if (finished) return;
          finished = true;
          end();
          reject(failed());
        };
        const abort = () => rejectOnce();
        request.signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
          .then(() => {
            if (finished || request.signal.aborted) throw failed();
            return invoke('cloud_oauth_network', {
              provider: 'google',
              operation: 'refresh',
              form: request.form,
              accessToken: null
            });
          })
          .then(value => {
            active = false;
            if (finished || request.signal.aborted) return rejectOnce();
            const response = checkedReply(value, OAUTH_PROVIDERS.google.token);
            finished = true;
            end();
            resolve(response);
          })
          .catch(() => {
            active = false;
            rejectOnce();
          });
        if (request.signal.aborted) abort();
      });
    }
  );
}
