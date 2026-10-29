// @ts-check
// Одноразовый POST-транспорт OAuth. Обмен кода используется диагностикой
// регистрации через узкий native-мост; хранилища токенов или синхронизации нет.
// fetch передаётся явно и считается доверенным. Реальные серверы, TLS и Tauri ещё
// необходимо проверить. Тела, ответы, исходные ошибки и токены не логировать.
import { object } from '../exportSchema.js';
import { OAUTH_PROVIDERS, validOAuthClientId, validOAuthRedirect } from './oauthCommon.js';
import { consumeYandexCodeScopeBinding } from './oauthPkce.js';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const LEASE_MS = 60 * 1000;
const INVALID = 'Некорректный запрос авторизации диска';
const UNKNOWN = 'Не удалось подтвердить результат запроса токена; повтор автоматически не выполняется';
const SPENT = 'Эта попытка запроса токена уже использована';
const EXPIRED = 'Данные авторизации больше не доступны; начните вход заново';

function invalid() {
  return new Error(INVALID);
}
function unknown() {
  return new Error(UNKNOWN);
}
function visibleAscii(value, maximum = MAX_TOKEN_LENGTH) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[\x21-\x7e]+$/.test(value);
}
function accessToken(value) {
  // Токен затем передаётся только заголовком: CR/LF и пробелы не допустимы.
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    /^[A-Za-z0-9._~+/-]+=*$/.test(value)
  );
}
function safeNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw unknown();
  return value;
}

/** Только документированный вариант обновления Google без client_secret.
 * Яндекс здесь намеренно не поддерживается до проверки условий его регистрации.
 * @param {{clientId:string, refreshToken:string}} options */
export function createGoogleRefreshRequest(options) {
  let input;
  try {
    input = object(options, ['clientId', 'refreshToken']);
  } catch {
    throw invalid();
  }
  if (!validOAuthClientId('google', input.clientId) || !visibleAscii(input.refreshToken)) throw invalid();
  const fields = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken
  });
  return Object.freeze({
    method: 'POST',
    url: OAUTH_PROVIDERS.google.token,
    headers: Object.freeze({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }),
    redirect: 'error',
    body: fields.toString()
  });
}

function checkedRequest(request, provider, clientId, operation) {
  let input;
  let headers;
  try {
    input = object(request, ['method', 'url', 'headers', 'redirect', 'body']);
    headers = object(input.headers, ['Content-Type', 'Accept']);
  } catch {
    throw invalid();
  }
  if (
    input.method !== 'POST' ||
    input.redirect !== 'error' ||
    input.url !== OAUTH_PROVIDERS[provider].token ||
    headers['Content-Type'] !== 'application/x-www-form-urlencoded' ||
    headers.Accept !== 'application/json' ||
    typeof input.body !== 'string' ||
    input.body.length > MAX_BODY_BYTES ||
    !/^[\x21-\x7e]+$/.test(input.body)
  ) {
    throw invalid();
  }
  const params = new URLSearchParams(input.body);
  if (params.toString() !== input.body) throw invalid();
  const keys = [...params.keys()];
  const required =
    operation === 'code'
      ? ['grant_type', 'client_id', 'code', 'code_verifier', ...(provider === 'google' ? ['redirect_uri'] : [])]
      : ['grant_type', 'client_id', 'refresh_token'];
  if (
    keys.length !== required.length ||
    new Set(keys).size !== keys.length ||
    keys.some(key => !required.includes(key))
  )
    throw invalid();
  if (params.get('client_id') !== clientId) throw invalid();
  if (operation === 'code') {
    if (
      params.get('grant_type') !== 'authorization_code' ||
      !visibleAscii(params.get('code'), 2048) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(params.get('code_verifier') || '') ||
      (provider === 'google' && !validOAuthRedirect(params.get('redirect_uri')))
    )
      throw invalid();
  } else if (
    provider !== 'google' ||
    params.get('grant_type') !== 'refresh_token' ||
    !visibleAscii(params.get('refresh_token'))
  ) {
    throw invalid();
  }
  // Строки фиксируются до первого await; изменённый объект запроса далее не читается.
  return { url: input.url, body: input.body };
}

// Строгий плоский JSON: JSON.parse один отбрасывает повторные имена и может скрыть
// scope/token_type или access_token. Экранированные повторы тоже отклоняются.
function parseReply(raw, provider) {
  const stringFields = new Set(['access_token', 'refresh_token', 'token_type', 'scope']);
  const numberFields = new Set(['expires_in', ...(provider === 'google' ? ['refresh_token_expires_in'] : [])]);
  const values = Object.create(null);
  let index = 0;
  const whitespace = () => {
    while (index < raw.length && ' \t\r\n'.includes(raw[index])) index++;
  };
  const string = () => {
    if (raw[index] !== '"') throw unknown();
    const start = index++;
    while (index < raw.length) {
      const char = raw[index++];
      if (char === '\\') {
        if (index >= raw.length) throw unknown();
        index++;
      } else if (char === '"') {
        const result = JSON.parse(raw.slice(start, index));
        if (typeof result !== 'string') throw unknown();
        return result;
      }
    }
    throw unknown();
  };
  whitespace();
  if (raw[index++] !== '{') throw unknown();
  whitespace();
  if (raw[index] !== '}') {
    while (true) {
      const key = string();
      if ((!stringFields.has(key) && !numberFields.has(key)) || Object.hasOwn(values, key)) throw unknown();
      whitespace();
      if (raw[index++] !== ':') throw unknown();
      whitespace();
      if (stringFields.has(key)) values[key] = string();
      else {
        const match = /^(?:0|[1-9][0-9]*)/.exec(raw.slice(index));
        if (!match) throw unknown();
        index += match[0].length;
        const number = Number(match[0]);
        if (!Number.isSafeInteger(number) || number <= 0) throw unknown();
        values[key] = number;
      }
      whitespace();
      if (raw[index] !== ',') break;
      index++;
      whitespace();
    }
  }
  if (raw[index++] !== '}') throw unknown();
  whitespace();
  if (index !== raw.length) throw unknown();
  if (
    !accessToken(values.access_token) ||
    typeof values.token_type !== 'string' ||
    values.token_type.toLowerCase() !== 'bearer'
  )
    throw unknown();
  if (!Number.isSafeInteger(values.expires_in)) throw unknown();
  if (Object.hasOwn(values, 'refresh_token') && !visibleAscii(values.refresh_token)) throw unknown();
  // Только запрошенное право. Дополнительные и частично выданные разрешения не
  // считаются подходящими. Для отсутствующего scope см. отдельную привязку к
  // одноразовой PKCE-попытке Яндекса в tokenLease().
  if (Object.hasOwn(values, 'scope') && values.scope !== OAUTH_PROVIDERS[provider].scope) throw unknown();
  return values;
}

function cancelBody(body) {
  try {
    const cancellation = body?.cancel?.();
    if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
  } catch {
    // Отказ отмены не делает ответ пригодным для использования.
  }
}

function cancelReader(reader) {
  try {
    const cancellation = reader?.cancel?.();
    if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
  } catch {
    // Отмена может не поддерживаться конкретным потоком.
  }
}

async function readBounded(response, abandoned, registerReader) {
  const contentType = response.headers?.get?.('content-type');
  if (
    typeof contentType !== 'string' ||
    !/^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(contentType)
  )
    throw unknown();
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined) {
    if (
      !/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      !Number.isSafeInteger(Number(declared)) ||
      Number(declared) > MAX_REPLY_BYTES
    )
      throw unknown();
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw unknown();
  const reader = response.body.getReader();
  registerReader(reader);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (abandoned()) throw unknown();
      if (part.done) break;
      if (!ArrayBuffer.isView(part.value) || Object.prototype.toString.call(part.value) !== '[object Uint8Array]')
        throw unknown();
      bytes += part.value.byteLength;
      if (bytes > MAX_REPLY_BYTES) throw unknown();
      text += decoder.decode(part.value, { stream: true });
      // Стараемся сократить жизнь буфера; копии внутри движка/потока могут остаться.
      part.value.fill(0);
    }
    text += decoder.decode();
    return text;
  } catch {
    cancelReader(reader);
    throw unknown();
  } finally {
    registerReader(null);
    try {
      reader.releaseLock();
    } catch {
      // Поток с зависшим read может остаться захвачен до завершения транспорта.
    }
  }
}

function tokenLease(values, provider, operation, startedAt, receivedAt, now, yandexScopeBound) {
  const expiresAt = startedAt + values.expires_in * 1000;
  if (!Number.isSafeInteger(expiresAt) || receivedAt < startedAt || receivedAt >= expiresAt) throw unknown();
  let refreshExpiresAt = null;
  if (Object.hasOwn(values, 'refresh_token_expires_in')) {
    if (!Object.hasOwn(values, 'refresh_token')) throw unknown();
    refreshExpiresAt = startedAt + values.refresh_token_expires_in * 1000;
    if (!Number.isSafeInteger(refreshExpiresAt) || receivedAt >= refreshExpiresAt) throw unknown();
  }
  const summary = Object.freeze({
    provider,
    operation,
    expiresAt,
    refreshExpiresAt,
    refreshAvailable: Object.hasOwn(values, 'refresh_token'),
    // Яндекс документирует отсутствие scope в ответе code-flow, когда выданы все
    // запрошенные права. Это можно учитывать только для связанной попытки, где
    // запрошено одно обязательное право без optional_scope. Метка не доказывает
    // работоспособность конкретной регистрации или фактический доступ к Диску.
    scope: Object.hasOwn(values, 'scope') ? 'reported' : yandexScopeBound ? 'request_bound' : 'unverified'
  });
  let secrets = { accessToken: values.access_token, refreshToken: values.refresh_token || null };
  values.access_token = null;
  values.refresh_token = null;
  // У объекта нет перечисляемых свойств с токенами; сериализация показывает только сводку.
  // Это не защищённое хранилище и не гарантирует стирание строк/копий из памяти.
  const clear = () => {
    secrets = null;
    clearTimeout(timer);
  };
  const timer = setTimeout(clear, LEASE_MS);
  return Object.freeze({
    summary,
    takeSecrets() {
      let current;
      try {
        current = safeNow(now);
      } catch {
        clear();
        throw new Error(EXPIRED);
      }
      if (
        !secrets ||
        current < receivedAt ||
        current - receivedAt >= LEASE_MS ||
        current >= expiresAt ||
        (refreshExpiresAt !== null && current >= refreshExpiresAt)
      ) {
        clear();
        throw new Error(EXPIRED);
      }
      const result = Object.freeze(secrets);
      clear();
      return result;
    },
    discard() {
      clear();
    }
  });
}

/**
 * ОДИН запрос к фиксированному endpoint от доверенного вызывающего кода. fetchImpl
 * передаётся явно; экземпляр нельзя использовать повторно даже после таймаута.
 * При неполном/неизвестном ответе нельзя повторять код или refresh автоматически:
 * провайдер мог уже выдать или заменить токены. Один экземпляр не является
 * межпроцессной блокировкой; безопасная постоянная координация ещё нужна.
 * Возвращаемые токены доступны лишь через одноразовый takeSecrets(); незнакомые
 * права отклоняются. Отсутствующий scope остаётся unverified, кроме запроса
 * Яндекса, непосредственно связанного с нашей попыткой: для него ставится
 * request_bound согласно документированному поведению сервиса. Это не проверка
 * конкретной регистрации или доступа к файлам. Сводка НЕ блокирует takeSecrets():
 * вызывающий код обязан сам проверить политику прав. Сохранения токенов и
 * подтверждения аккаунта здесь нет.
 * @param {{provider:'google'|'yandex', clientId:string, operation:'code'|'refresh',
 * fetchImpl: typeof fetch, timeoutMs?:number, now?:() => number}} options
 */
export function createCloudOAuthTokenTransport(options) {
  let input;
  try {
    input = object(options, ['provider', 'clientId', 'operation', 'fetchImpl'], ['timeoutMs', 'now']);
  } catch {
    throw invalid();
  }
  if (
    typeof input.provider !== 'string' ||
    !Object.hasOwn(OAUTH_PROVIDERS, input.provider) ||
    !validOAuthClientId(input.provider, input.clientId) ||
    !['code', 'refresh'].includes(input.operation) ||
    (input.operation === 'refresh' && input.provider !== 'google') ||
    typeof input.fetchImpl !== 'function' ||
    (input.now !== undefined && typeof input.now !== 'function')
  )
    throw invalid();
  const timeoutMs = input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 120000) throw invalid();
  const now = input.now || (() => Date.now());
  let spent = false;
  return Object.freeze({
    async send(request) {
      if (spent) throw new Error(SPENT);
      const checked = checkedRequest(request, input.provider, input.clientId, input.operation);
      // Свидетельство одноразово и не переносится при копировании. Не принимаем
      // его для refresh или другого провайдера; сам checkedRequest тоже обязателен.
      const yandexScopeBound =
        input.provider === 'yandex' &&
        input.operation === 'code' &&
        consumeYandexCodeScopeBinding(request, input.clientId);
      let startedAt;
      try {
        startedAt = safeNow(now);
      } catch {
        throw invalid();
      }
      spent = true;
      const controller = new AbortController();
      let abandoned = false;
      let activeReader = null;
      let timer;
      const work = async () => {
        const response = await input.fetchImpl(checked.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: checked.body,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal
        });
        if (
          abandoned ||
          !response ||
          response.status !== 200 ||
          response.redirected ||
          response.type === 'opaque' ||
          response.type === 'opaqueredirect' ||
          response.url !== checked.url
        ) {
          cancelBody(response?.body);
          throw unknown();
        }
        let raw;
        try {
          raw = await readBounded(
            response,
            () => abandoned,
            reader => {
              activeReader = reader;
            }
          );
        } catch {
          cancelBody(response.body);
          throw unknown();
        }
        if (abandoned) throw unknown();
        const values = parseReply(raw, input.provider);
        return tokenLease(values, input.provider, input.operation, startedAt, safeNow(now), now, yandexScopeBound);
      };
      try {
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            abandoned = true;
            controller.abort();
            cancelReader(activeReader);
            reject(unknown());
          }, timeoutMs);
        });
        return await Promise.race([work(), deadline]);
      } catch {
        abandoned = true;
        controller.abort();
        cancelReader(activeReader);
        throw unknown();
      } finally {
        clearTimeout(timer);
      }
    }
  });
}
