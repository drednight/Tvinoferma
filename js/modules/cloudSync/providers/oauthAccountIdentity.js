// @ts-check
// Проверки идентификаторов и предпросмотр аккаунта. Предпросмотр используется
// разовой диагностикой без сохранения привязки; реальное подключение отключено.
// Реальные сервисы, Tauri и стабильность идентификаторов ещё не проверены; fetchImpl доверенный.
// Заголовок Authorization, ответ, метку аккаунта и исходные ошибки не логировать.
import {
  cloudAccessDiagnostic,
  cloudAccessHttpDiagnostic,
  withCloudAccessDiagnostic
} from './cloudAccessDiagnostics.js';
import { object } from '../exportSchema.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';
import { copyOAuthAccountLabel } from './oauthAccountLabel.js';

const GOOGLE_URL = 'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%29';
const GOOGLE_PREVIEW_URL = 'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%2CemailAddress%29';
const YANDEX_URL = 'https://login.yandex.ru/info?format=json';
const MAX_REPLY_BYTES = 8192;
const MAX_TOKEN_LENGTH = 8192;
const ERROR = 'Не удалось проверить учётную запись облачного диска';

function failed(code = 'identity_invalid_response') {
  return withCloudAccessDiagnostic(new Error(ERROR), code);
}
function validAccessToken(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    /^[A-Za-z0-9._~+/-]+=*$/.test(value)
  );
}
function cancelBody(body) {
  try {
    const cancellation = body?.cancel?.();
    if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
  } catch {
    // Отказ отмены не делает поздний ответ пригодным.
  }
}
function cancelReader(reader) {
  try {
    const cancellation = reader?.cancel?.();
    if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
  } catch {
    // Отмена потока выполняется по возможности.
  }
}

// Небольшой строгий разбор только строк/объектов: JSON.parse по отдельности не
// обнаруживает повторные ключи, включая экранированные эквиваленты.
function cursorFor(raw) {
  let index = 0;
  const whitespace = () => {
    while (index < raw.length && ' \t\r\n'.includes(raw[index])) index++;
  };
  const literal = value => {
    whitespace();
    if (raw[index++] !== value) throw failed();
  };
  const string = () => {
    whitespace();
    if (raw[index] !== '"') throw failed();
    const start = index++;
    while (index < raw.length) {
      const char = raw[index++];
      if (char === '\\') {
        if (index >= raw.length) throw failed();
        index++;
      } else if (char === '"') {
        const value = JSON.parse(raw.slice(start, index));
        if (typeof value !== 'string') throw failed();
        return value;
      }
    }
    throw failed();
  };
  return {
    literal,
    string,
    peek() {
      whitespace();
      return raw[index];
    },
    end() {
      whitespace();
      if (index !== raw.length) throw failed();
    }
  };
}

// Google запрашивает только одно поле; лишние данные/повторы блокируют ответ.
function parseGoogleIdentity(raw) {
  const json = cursorFor(raw);
  json.literal('{');
  if (json.string() !== 'user') throw failed();
  json.literal(':');
  json.literal('{');
  if (json.string() !== 'permissionId') throw failed();
  json.literal(':');
  const accountKey = json.string();
  json.literal('}');
  json.literal('}');
  json.end();
  if (!validOAuthAccountKey(accountKey)) throw failed();
  return accountKey;
}

// Для первого подключения Google просим ID и email в одном ответе. Поля могут
// идти в любом порядке; дубликаты, лишние поля и нестроковые значения запрещены.
function parseGooglePreview(raw) {
  const json = cursorFor(raw);
  const values = Object.create(null);
  const allowed = new Set(['permissionId', 'emailAddress']);
  json.literal('{');
  if (json.string() !== 'user') throw failed();
  json.literal(':');
  json.literal('{');
  if (json.peek() !== '}') {
    while (true) {
      const key = json.string();
      if (!allowed.has(key) || Object.hasOwn(values, key)) throw failed();
      json.literal(':');
      values[key] = json.string();
      if (json.peek() !== ',') break;
      json.literal(',');
    }
  }
  json.literal('}');
  json.literal('}');
  json.end();
  if (!validOAuthAccountKey(values.permissionId)) throw failed();
  const label =
    values.emailAddress === undefined
      ? null
      : copyOAuthAccountLabel('google', { kind: 'email', value: values.emailAddress });
  return Object.freeze({ accountKey: values.permissionId, label });
}

// Яндекс ID может вернуть login/id наряду с psuid даже без прав login:*.
// Обычная проверка ID их не возвращает; login доступен только в предпросмотре.
function parseYandexIdentity(raw, clientId, includeLabel) {
  const json = cursorFor(raw);
  const values = Object.create(null);
  const allowed = new Set(['login', 'id', 'client_id', 'psuid']);
  json.literal('{');
  if (json.peek() !== '}') {
    while (true) {
      const key = json.string();
      if (!allowed.has(key) || Object.hasOwn(values, key)) throw failed();
      json.literal(':');
      const value = json.string();
      if (
        !value ||
        value.length > 1024 ||
        [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
        throw failed();
      values[key] = value;
      if (json.peek() !== ',') break;
      json.literal(',');
    }
  }
  json.literal('}');
  json.end();
  if (values.client_id !== clientId || !validOAuthAccountKey(values.psuid)) throw failed();
  if (!includeLabel) return Object.freeze({ accountKey: values.psuid });
  const label =
    values.login === undefined ? null : copyOAuthAccountLabel('yandex', { kind: 'login', value: values.login });
  return Object.freeze({ accountKey: values.psuid, label });
}

async function readBounded(response, abandoned, registerReader) {
  const type = response.headers?.get?.('content-type');
  if (typeof type !== 'string' || !/^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(type))
    throw failed();
  const length = response.headers?.get?.('content-length');
  if (
    length !== null &&
    length !== undefined &&
    (!/^(?:0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_REPLY_BYTES)
  )
    throw failed();
  if (!response.body || typeof response.body.getReader !== 'function') throw failed();
  const reader = response.body.getReader();
  registerReader(reader);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let raw = '';
  try {
    while (true) {
      const part = await reader.read();
      if (abandoned()) throw failed();
      if (part.done) break;
      if (!ArrayBuffer.isView(part.value) || Object.prototype.toString.call(part.value) !== '[object Uint8Array]')
        throw failed();
      bytes += part.value.byteLength;
      if (bytes > MAX_REPLY_BYTES) throw failed();
      raw += decoder.decode(part.value, { stream: true });
      part.value.fill(0);
    }
    raw += decoder.decode();
    return raw;
  } catch {
    cancelReader(reader);
    throw failed();
  } finally {
    registerReader(null);
    try {
      reader.releaseLock();
    } catch {
      // Зависшее чтение может оставить поток захваченным.
    }
  }
}

/**
 * Фиксированные GET: обычные проверки возвращают только {accountKey}; отдельный
 * preview дополнительно возвращает label или null. Google запрашивает оба поля
 * в одном ответе, Яндекс сверяет client_id. Это не проверка всех scope, первого
 * выбора аккаунта или сохранённой привязки; Google about.get не проверяет
 * client_id. ID и label — личные данные, не помещать в логи или облачный файл.
 * Только доверенный интерфейс должен получать label и показывать её как текст
 * целиком, без HTML и сокращения. Внешний signal и таймаут прерывают ожидание;
 * некооперативный fetch/поток может продолжаться.
 * Слот занят до фактического завершения поздней работы, чтобы не создавать
 * бесконечные параллельные запросы. fetchImpl обязан соблюдать запреты на
 * перенаправление/cookies и TLS; проверка URL ответа не предотвращает уже
 * произошедшую утечку недоверенным транспортом.
 * @param {'google'|'yandex'} provider
 * @param {{fetchImpl:typeof fetch, timeoutMs?:number}} options
 * @param {boolean} includeLabel
 */
function createIdentityReader(provider, options, includeLabel) {
  let input;
  try {
    input = object(options, ['fetchImpl'], ['timeoutMs']);
  } catch {
    throw failed();
  }
  const timeoutMs = input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  if (typeof input.fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 120000)
    throw failed();
  const fetchImpl = input.fetchImpl;
  const endpoint = provider === 'google' ? (includeLabel ? GOOGLE_PREVIEW_URL : GOOGLE_URL) : YANDEX_URL;
  const authorization = provider === 'google' ? 'Bearer' : 'OAuth';
  let active = false;
  return async function verifyCloudAccount(args) {
    let request;
    try {
      request = object(args, ['accessToken', 'clientId', 'signal']);
      if (
        !validAccessToken(request.accessToken) ||
        !validOAuthClientId(provider, request.clientId) ||
        !request.signal ||
        typeof request.signal.aborted !== 'boolean' ||
        typeof request.signal.addEventListener !== 'function' ||
        typeof request.signal.removeEventListener !== 'function' ||
        request.signal.aborted ||
        active
      )
        throw failed();
    } catch {
      throw failed();
    }
    let startedAt;
    try {
      startedAt = globalThis.performance.now();
      if (!Number.isFinite(startedAt) || startedAt < 0) throw failed();
    } catch {
      throw failed();
    }
    const pastDeadline = () => {
      try {
        const now = globalThis.performance.now();
        return !Number.isFinite(now) || now < startedAt || now - startedAt >= timeoutMs;
      } catch {
        return true;
      }
    };
    active = true;
    const controller = new AbortController();
    let abandoned = false;
    let activeReader = null;
    let timer;
    let rejectAbort;
    const cancelled = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    // Нестандартный signal может вызвать abort прямо при подписке и бросить.
    // У промиса уже есть обработчик даже до подключения Promise.race.
    void cancelled.catch(() => {});
    const abort = reason => {
      if (abandoned) return;
      abandoned = true;
      controller.abort();
      cancelReader(activeReader);
      rejectAbort(failed(reason === 'identity_timeout' ? 'identity_timeout' : 'identity_aborted'));
    };
    try {
      request.signal.addEventListener('abort', abort, { once: true });
    } catch {
      active = false;
      throw failed();
    }
    const work = async () => {
      if (abandoned || pastDeadline()) throw failed();
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `${authorization} ${request.accessToken}` },
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal
        });
      } catch {
        throw failed('identity_transport_unavailable');
      }
      if (
        abandoned ||
        pastDeadline() ||
        !response ||
        response.redirected ||
        response.type === 'opaque' ||
        response.type === 'opaqueredirect' ||
        response.url !== endpoint
      ) {
        cancelBody(response?.body);
        throw failed();
      }
      if (response.status !== 200) {
        cancelBody(response.body);
        throw failed(cloudAccessHttpDiagnostic('identity', response.status));
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
        throw failed();
      }
      if (abandoned || pastDeadline()) throw failed();
      const result =
        provider === 'google'
          ? includeLabel
            ? parseGooglePreview(raw)
            : Object.freeze({ accountKey: parseGoogleIdentity(raw) })
          : parseYandexIdentity(raw, request.clientId, includeLabel);
      if (abandoned || pastDeadline()) throw failed();
      return result;
    };
    let readingScheduled = false;
    try {
      timer = setTimeout(() => abort('identity_timeout'), timeoutMs);
      const reading = Promise.resolve()
        .then(work)
        .finally(() => {
          active = false;
        });
      readingScheduled = true;
      const racing = Promise.race([reading, cancelled]);
      // Геттер нестандартного signal может бросить ещё до await.
      void racing.catch(() => {});
      // В случае нестандартного signal изменение могло произойти при подписке.
      if (request.signal.aborted) abort();
      return await racing;
    } catch (error) {
      if (!readingScheduled) active = false;
      abandoned = true;
      controller.abort();
      cancelReader(activeReader);
      throw failed(cloudAccessDiagnostic(error));
    } finally {
      clearTimeout(timer);
      try {
        request.signal.removeEventListener('abort', abort);
      } catch {
        // Нестандартный signal не должен раскрывать детали в исключении.
      }
    }
  };
}

/** Google Drive about.get: только user.permissionId, без адреса почты. */
export function createGoogleAccountIdentityReader(options) {
  return createIdentityReader('google', options, false);
}

/** Яндекс ID: проверяет client_id и возвращает только psuid; login/id не выдаёт. */
export function createYandexAccountIdentityReader(options) {
  return createIdentityReader('yandex', options, false);
}

/** Только для будущего доверенного подтверждения: Google ID и email или null. */
export function createGoogleAccountPreviewReader(options) {
  return createIdentityReader('google', options, true);
}

/** Только для будущего доверенного подтверждения: Яндекс psuid и login или null. */
export function createYandexAccountPreviewReader(options) {
  return createIdentityReader('yandex', options, true);
}
