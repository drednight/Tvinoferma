// @ts-check
// Узкий одноразовый мост refresh Google. Нативный IPC обязан атомарно заменить
// ожидаемую ready-запись на pending ДО POST и сверить client/token с формой.
// После неизвестного исхода нельзя повторять; UI и реальные токены не испытаны.
// Токены, формы, ответы и исходные ошибки нельзя журналировать.
import { object } from '../exportSchema.js';
import { OAUTH_PROVIDERS, validOAuthClientId } from './oauthCommon.js';
import { parseGoogleCredentialRecord, validCredentialId } from './oauthCredentialRecord.js';

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
  return {
    form: request.body,
    clientId: params.get('client_id'),
    refreshToken: secret,
    signal: /** @type {AbortSignal} */ (request.signal)
  };
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

function checkedClaim(value) {
  const claim = object(value, ['slotId', 'expected', 'pending']);
  const before = parseGoogleCredentialRecord(claim.expected);
  const after = parseGoogleCredentialRecord(claim.pending);
  if (
    !validCredentialId(claim.slotId) ||
    before.slotId !== claim.slotId ||
    after.slotId !== claim.slotId ||
    before.clientId !== after.clientId ||
    before.accountKey !== after.accountKey ||
    before.phase !== 'ready' ||
    after.phase !== 'pending' ||
    before.revision === after.revision ||
    after.attemptId === before.revision
  )
    throw failed();
  return Object.freeze({
    slotId: claim.slotId,
    expected: claim.expected,
    pending: claim.pending,
    clientId: before.clientId,
    refreshToken: before.refreshToken
  });
}

/**
 * Одноразовая попытка для фиксированного refresh Google. Claim содержит секретную
 * ready-запись и pending; IPC проверяет их и атомарно расходует до отправки.
 * Отмена JS не останавливает начавшийся IPC; потерянный ответ не допускает повтор.
 * @param {{invoke:(command:string,args:any)=>Promise<unknown>,claim:{slotId:string,expected:string,pending:string}}} options
 * @returns {typeof fetch}
 */
export function createNativeGoogleRefreshFetch(options) {
  let invoke;
  let claim;
  try {
    const input = object(options, ['invoke', 'claim']);
    if (typeof input.invoke !== 'function') throw failed();
    invoke = input.invoke;
    claim = checkedClaim(input.claim);
  } catch {
    throw failed();
  }
  let active = false;
  let spent = false;
  return /** @type {typeof fetch} */ (
    async (url, init) => {
      let request;
      try {
        request = requestFor(url, init);
        if (active || spent || request.clientId !== claim.clientId || request.refreshToken !== claim.refreshToken)
          throw failed();
      } catch {
        throw failed();
      }
      active = true;
      return new Promise((resolve, reject) => {
        let finished = false;
        const end = () => {
          try {
            request.signal.removeEventListener('abort', abort);
          } catch {
            // Нестандартный signal не должен раскрывать исходное исключение.
          }
        };
        const rejectOnce = () => {
          if (finished) return;
          finished = true;
          end();
          reject(failed());
        };
        const abort = () => rejectOnce();
        try {
          request.signal.addEventListener('abort', abort, { once: true });
        } catch {
          // До запуска IPC; слот можно освободить, исходную ошибку не выдаём.
          active = false;
          rejectOnce();
          return;
        }
        Promise.resolve()
          .then(() => {
            if (finished || request.signal.aborted) throw failed();
            spent = true;
            return invoke('cloud_oauth_network', {
              provider: 'google',
              operation: 'refresh',
              form: request.form,
              accessToken: null,
              refreshClaim: { slotId: claim.slotId, expected: claim.expected, pending: claim.pending }
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
        try {
          if (request.signal.aborted) abort();
        } catch {
          rejectOnce();
        }
      });
    }
  );
}
