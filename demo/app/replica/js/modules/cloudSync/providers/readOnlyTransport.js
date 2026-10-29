// @ts-check
// Ограниченный HTTP-транспорт только для чтения. Не подключён к приложению или OAuth.
// Запись/удаление здесь НЕ разрешены. Токен захватывается замыканием и передаётся в заголовке
// разрешённого запроса; безопасное хранение и стирание из памяти не гарантируются. Не логировать
// запросы, заголовки, временные ссылки или ошибки fetch. Разрешения, CORS, Tauri и поставщики
// требуют проверки до использования с пользовательским аккаунтом.
import { object, oneOf } from '../exportSchema.js';
import { isSyncId } from '../envelope.js';
import { versionFileName } from './common.js';
import { googleDownloadRequest, googleListRequest } from './googleDrive.js';
import {
  yandexDownloadContentRequest,
  yandexDownloadLinkRequest,
  yandexListRequest,
  yandexMetadataRequest
} from './yandexDisk.js';

const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_VERSION_BYTES = 45 * 1024 * 1024;
const MAX_URL_LENGTH = 24576;
const MAX_IN_FLIGHT = 4;
const MAX_TOKEN_LENGTH = 8192;
const GOOGLE_QUERY =
  /^'([A-Za-z0-9_-]{1,256})' in parents and trashed = false and appProperties has \{ key='tfFormat' and value='1' \} and appProperties has \{ key='tfDataset' and value='([0-9a-f-]{36})' \}(?: and appProperties has \{ key='tfVersion' and value='([0-9a-f-]{36})' \})?$/;
const YANDEX_PATH = /^app:\/(tf-v1-([0-9a-f-]{36})-([0-9a-f-]{36})\.tfsc)$/;

function invalid() {
  return new Error('Неподдерживаемый запрос облачной синхронизации');
}
function networkError() {
  return new Error('Не удалось безопасно прочитать облачный диск');
}
function canonicalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) throw invalid();
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw invalid();
    if (url.toString() !== value) throw invalid();
    return url;
  } catch {
    throw invalid();
  }
}
function requireHeaders(value, expected) {
  if (!expected && value === undefined) return {};
  if (!expected || value === undefined) throw invalid();
  const headers = object(value, ['Accept']);
  if (headers.Accept !== 'application/json') throw invalid();
  return { Accept: 'application/json' };
}
function yandexVersion(value) {
  const match = typeof value === 'string' ? YANDEX_PATH.exec(value) : null;
  if (!match || !isSyncId(match[2]) || !isSyncId(match[3]) || versionFileName(match[2], match[3]) !== match[1])
    throw invalid();
  return { datasetId: match[2], versionId: match[3] };
}
function decimal(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw invalid();
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw invalid();
  return n;
}
function checkedRequest(request, provider) {
  const input = object(request, ['method', 'url', 'credential', 'redirect'], ['headers']);
  if (input.method !== 'GET' || input.redirect !== 'error') throw invalid();
  const url = canonicalUrl(input.url);
  let expected;
  let mode = 'json';
  if (provider === 'google' && input.credential === 'google' && url.origin === 'https://www.googleapis.com') {
    if (url.pathname === '/drive/v3/files') {
      const match = GOOGLE_QUERY.exec(url.searchParams.get('q') || '');
      if (!match || !isSyncId(match[2]) || (match[3] && !isSyncId(match[3]))) throw invalid();
      const options = { folderId: match[1], datasetId: match[2] };
      if (match[3]) options.versionId = match[3];
      if (url.searchParams.has('pageToken')) options.pageToken = url.searchParams.get('pageToken');
      expected = googleListRequest(options);
    } else {
      const match = /^\/drive\/v3\/files\/([A-Za-z0-9_-]{1,256})$/.exec(url.pathname);
      if (!match) throw invalid();
      expected = googleDownloadRequest(match[1]);
      mode = 'version';
    }
  } else if (provider === 'yandex' && input.credential === 'yandex' && url.origin === 'https://cloud-api.yandex.net') {
    if (url.pathname === '/v1/disk/resources' && url.searchParams.get('path') === 'app:/') {
      expected = yandexListRequest({
        offset: decimal(url.searchParams.get('offset')),
        limit: decimal(url.searchParams.get('limit'))
      });
    } else {
      const ids = yandexVersion(url.searchParams.get('path'));
      if (url.pathname === '/v1/disk/resources') expected = yandexMetadataRequest(ids);
      else if (url.pathname === '/v1/disk/resources/download') expected = yandexDownloadLinkRequest(ids);
      else throw invalid();
    }
  } else if (provider === 'yandex' && input.credential === 'yandex-download') {
    expected = yandexDownloadContentRequest({ href: input.url, method: 'GET', templated: false });
    mode = 'version';
  } else throw invalid();
  if (expected.url !== input.url || expected.credential !== input.credential) throw invalid();
  const headers = requireHeaders(input.headers, !!expected.headers);
  return { url: input.url, headers, mode };
}

async function readBounded(response, maxBytes) {
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined) {
    if (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)
      throw networkError();
  }
  if (!response.body) return '';
  if (typeof response.body.getReader !== 'function') throw networkError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '';
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!ArrayBuffer.isView(part.value) || Object.prototype.toString.call(part.value) !== '[object Uint8Array]')
        throw networkError();
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw networkError();
      result += decoder.decode(part.value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch {
    try {
      await reader.cancel();
    } catch {
      /* отказ потока уже обработан */
    }
    throw networkError();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Транспорт одного провайдера и одного токена: это особенно важно для двух шагов
 * скачивания Яндекса. Сервер ошибок и тела ответов при неуспехе не возвращаются наружу.
 * Только точные GET-запросы известных строителей; любые изменения адреса блокируются ДО fetch.
 * @param {{ provider: 'google'|'yandex', accessToken: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createReadOnlyCloudTransport(options) {
  const input = object(options, ['provider', 'accessToken'], ['fetchImpl', 'timeoutMs']);
  const provider = oneOf(input.provider, ['google', 'yandex']);
  const accessToken = input.accessToken;
  if (
    typeof accessToken !== 'string' ||
    !accessToken ||
    accessToken.length > MAX_TOKEN_LENGTH ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(accessToken)
  ) {
    throw new Error('Некорректный токен доступа к облаку');
  }
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Сетевой транспорт недоступен');
  const timeoutMs = input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 120000) throw invalid();
  let active = 0;

  return Object.freeze({
    /** @param {any} request */
    async send(request) {
      // Фиксируем проверенные URL/заголовки до первого await; тело запроса не допускается.
      const checked = checkedRequest(request, provider);
      if (active >= MAX_IN_FLIGHT) throw new Error('Слишком много одновременных запросов к диску');
      active++;
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(networkError());
          }, timeoutMs);
        });
        const read = async () => {
          const response = await fetchImpl(checked.url, {
            method: 'GET',
            headers: {
              ...checked.headers,
              Authorization: `${provider === 'google' ? 'Bearer' : 'OAuth'} ${accessToken}`
            },
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            signal: controller.signal
          });
          if (
            !response ||
            !Number.isInteger(response.status) ||
            response.status < 100 ||
            response.status > 599 ||
            response.redirected ||
            response.type === 'opaqueredirect'
          )
            throw networkError();
          if (response.url && response.url !== checked.url) throw networkError();
          if (response.status >= 300 && response.status < 400) throw networkError();
          if (response.status !== 200) {
            try {
              await response.body?.cancel();
            } catch {
              /* ответ ошибки не читаем и не раскрываем */
            }
            return { status: response.status, body: '' };
          }
          return {
            status: 200,
            body: await readBounded(response, checked.mode === 'version' ? MAX_VERSION_BYTES : MAX_LIST_BYTES)
          };
        };
        // Слот остаётся занят до фактического завершения fetch/потока, даже если таймаут
        // уже показан. Некорректный fetch, игнорирующий abort, не создаст бесконечно много
        // одновременно работающих запросов; в этом случае транспорт нужно создать заново.
        const reading = read().finally(() => {
          active--;
        });
        return await Promise.race([reading, timeout]);
      } catch {
        // Оборвать также слишком большое или ошибочное тело, если заголовки уже получены.
        controller.abort();
        // fetch может включить токен или подписанный URL в текст своей ошибки.
        throw networkError();
      } finally {
        clearTimeout(timer);
      }
    }
  });
}
