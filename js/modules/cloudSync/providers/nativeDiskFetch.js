// @ts-check
// Экспериментальный мост существующих изолированных протоколов к native IPC.
// В UI не используется. Сеть и ограничения повторно проверяются в Rust; тесты с
// fake invoke не доказывают работу Tauri, настоящего диска, сохранность очереди,
// шифрование перед передачей или безопасность ключей. Не журналировать параметры,
// токен, подписанные ссылки, конверт или исходные ошибки.
import { object } from '../exportSchema.js';
import { isSyncId } from '../envelope.js';
import { copyCloudEnvelope, validGoogleId, versionFileName } from './common.js';
import {
  googleCreateAppFolderRequest,
  googleDownloadRequest,
  googleGenerateFileIdRequest,
  googleListAppFoldersRequest,
  googleListRequest
} from './googleDrive.js';
import {
  yandexDownloadContentRequest,
  yandexDownloadLinkRequest,
  yandexListRequest,
  yandexMetadataRequest,
  yandexUploadContentRequest,
  yandexUploadLinkRequest
} from './yandexDisk.js';

const ERROR = 'Не удалось безопасно выполнить запрос облачного диска';
const GOOGLE_IDENTITY = 'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%29';
const YANDEX_IDENTITY = 'https://login.yandex.ru/info?format=json';
const GOOGLE_UPLOAD =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id%2Cname%2CappProperties';
const GOOGLE_QUERY =
  /^'([A-Za-z0-9_-]{1,256})' in parents and trashed = false and appProperties has \{ key='tfFormat' and value='1' \} and appProperties has \{ key='tfDataset' and value='([0-9a-f-]{36})' \}(?: and appProperties has \{ key='tfVersion' and value='([0-9a-f-]{36})' \})?$/;
const YANDEX_PATH = /^app:\/(tf-v1-([0-9a-f-]{36})-([0-9a-f-]{36})\.tfsc)$/;
const MAX_URL = 24576;
const MAX_VERSION = 45 * 1024 * 1024;
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_SMALL = 64 * 1024;
const MAX_IDENTITY = 8192;
const MAX_MULTIPART = 5_000_000;

function failed() {
  return new Error(ERROR);
}
function decimal(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw failed();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw failed();
  return number;
}
function canonicalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL) throw failed();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.toString() !== value)
    throw failed();
  return url;
}
function token(headers, provider, json) {
  const fields = object(headers, json ? ['Accept', 'Authorization'] : ['Authorization']);
  const prefix = provider === 'google' ? 'Bearer ' : 'OAuth ';
  if (
    (json && fields.Accept !== 'application/json') ||
    typeof fields.Authorization !== 'string' ||
    !fields.Authorization.startsWith(prefix)
  )
    throw failed();
  const value = fields.Authorization.slice(prefix.length);
  if (!value || value.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(value)) throw failed();
  return value;
}
function idsForPath(value) {
  const match = typeof value === 'string' ? YANDEX_PATH.exec(value) : null;
  if (!match || !isSyncId(match[2]) || !isSyncId(match[3]) || versionFileName(match[2], match[3]) !== match[1])
    throw failed();
  return { datasetId: match[2], versionId: match[3] };
}
function envelope(raw, datasetId, versionId) {
  if (typeof raw !== 'string' || raw.length > MAX_VERSION) throw failed();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failed();
  }
  const checked = copyCloudEnvelope(parsed, datasetId);
  if (checked.versionId !== versionId || JSON.stringify(checked) !== raw) throw failed();
  return checked;
}
function googleMultipart(body, contentType) {
  const marker = /^multipart\/related; boundary=(tf_[0-9a-f-]{36})$/.exec(contentType || '');
  if (!marker || !isSyncId(marker[1].slice(3)) || typeof body !== 'string' || body.length > MAX_MULTIPART)
    throw failed();
  const boundary = marker[1];
  const start = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`;
  const middle = `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const end = `\r\n--${boundary}--\r\n`;
  if (!body.startsWith(start) || !body.endsWith(end)) throw failed();
  const split = body.indexOf(middle, start.length);
  if (split < 0) throw failed();
  const metadataText = body.slice(start.length, split);
  const raw = body.slice(split + middle.length, -end.length);
  let metadata;
  try {
    metadata = object(JSON.parse(metadataText), ['id', 'name', 'mimeType', 'parents', 'appProperties']);
  } catch {
    throw failed();
  }
  const properties = object(metadata.appProperties, ['tfFormat', 'tfDataset', 'tfVersion']);
  if (
    !validGoogleId(metadata.id) ||
    !Array.isArray(metadata.parents) ||
    metadata.parents.length !== 1 ||
    !validGoogleId(metadata.parents[0]) ||
    !isSyncId(properties.tfDataset) ||
    !isSyncId(properties.tfVersion) ||
    properties.tfFormat !== '1' ||
    metadata.name !== versionFileName(properties.tfDataset, properties.tfVersion) ||
    metadata.mimeType !== 'application/octet-stream'
  )
    throw failed();
  const expectedMetadata = JSON.stringify({
    id: metadata.id,
    name: metadata.name,
    mimeType: 'application/octet-stream',
    parents: [metadata.parents[0]],
    appProperties: { tfFormat: '1', tfDataset: properties.tfDataset, tfVersion: properties.tfVersion }
  });
  if (expectedMetadata !== metadataText) throw failed();
  envelope(raw, properties.tfDataset, properties.tfVersion);
  return {
    folderId: metadata.parents[0],
    fileId: metadata.id,
    datasetId: properties.tfDataset,
    versionId: properties.tfVersion,
    body: raw
  };
}

function checkedRequest(provider, address, init) {
  const request = object(
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
    request.signal.aborted
  )
    throw failed();
  const url = canonicalUrl(address);
  const hasBody = Object.hasOwn(request, 'body');
  const base = { provider, operation: '', accessToken: undefined };
  let result;
  let maxBody = MAX_SMALL;
  if (request.method === 'GET' && !hasBody && address === (provider === 'google' ? GOOGLE_IDENTITY : YANDEX_IDENTITY)) {
    result = { ...base, operation: 'identity', accessToken: token(request.headers, provider, true) };
    maxBody = MAX_IDENTITY;
  } else if (provider === 'google' && request.method === 'GET' && !hasBody) {
    const accessToken = token(request.headers, provider, false);
    if (address === googleGenerateFileIdRequest().url) result = { ...base, operation: 'generate_id', accessToken };
    else if (url.origin === 'https://www.googleapis.com' && url.pathname === '/drive/v3/files') {
      const page = url.searchParams.has('pageToken') ? { pageToken: url.searchParams.get('pageToken') } : {};
      const folderRequest = googleListAppFoldersRequest(page);
      if (folderRequest.url === address) result = { ...base, operation: 'folder_list', accessToken, ...page };
      else {
        const match = GOOGLE_QUERY.exec(url.searchParams.get('q') || '');
        if (!match || !isSyncId(match[2]) || (match[3] && !isSyncId(match[3]))) throw failed();
        const options = {
          folderId: match[1],
          datasetId: match[2],
          ...(match[3] ? { versionId: match[3] } : {}),
          ...page
        };
        if (googleListRequest(options).url !== address) throw failed();
        result = { ...base, operation: 'list', accessToken, ...options };
      }
      maxBody = MAX_METADATA;
    } else {
      const match = /^\/drive\/v3\/files\/([A-Za-z0-9_-]{1,256})$/.exec(url.pathname);
      if (!match || googleDownloadRequest(match[1]).url !== address) throw failed();
      result = { ...base, operation: 'download', accessToken, fileId: match[1] };
      maxBody = MAX_VERSION;
    }
  } else if (
    provider === 'google' &&
    request.method === 'POST' &&
    hasBody &&
    url.origin === 'https://www.googleapis.com' &&
    url.pathname === '/drive/v3/files'
  ) {
    const headers = object(request.headers, ['Content-Type', 'Accept', 'Authorization']);
    if (
      headers['Content-Type'] !== 'application/json' ||
      headers.Accept !== 'application/json' ||
      typeof request.body !== 'string' ||
      request.body.length > 2048
    )
      throw failed();
    const accessToken = token({ Authorization: headers.Authorization }, provider, false);
    let metadata;
    try {
      metadata = object(JSON.parse(request.body), ['id', 'name', 'mimeType', 'appProperties']);
    } catch {
      throw failed();
    }
    const expected = googleCreateAppFolderRequest({ fileId: metadata.id });
    if (expected.url !== address || expected.body !== request.body) throw failed();
    result = { ...base, operation: 'folder_create', accessToken, fileId: metadata.id };
  } else if (provider === 'google' && request.method === 'POST' && address === GOOGLE_UPLOAD && hasBody) {
    const headers = object(request.headers, ['Content-Type', 'Authorization']);
    const accessToken = token({ Authorization: headers.Authorization }, provider, false);
    result = { ...base, operation: 'create', accessToken, ...googleMultipart(request.body, headers['Content-Type']) };
  } else if (provider === 'yandex' && request.method === 'GET' && !hasBody) {
    if (url.origin === 'https://cloud-api.yandex.net') {
      const accessToken = token(request.headers, provider, true);
      if (url.pathname === '/v1/disk/resources' && url.searchParams.get('path') === 'app:/') {
        const options = {
          offset: decimal(url.searchParams.get('offset')),
          limit: decimal(url.searchParams.get('limit'))
        };
        if (yandexListRequest(options).url !== address) throw failed();
        result = { ...base, operation: 'list', accessToken, ...options };
        maxBody = MAX_METADATA;
      } else {
        const ids = idsForPath(url.searchParams.get('path'));
        const operations = {
          '/v1/disk/resources': ['metadata', yandexMetadataRequest],
          '/v1/disk/resources/download': ['download_link', yandexDownloadLinkRequest],
          '/v1/disk/resources/upload': ['upload_link', yandexUploadLinkRequest]
        };
        const entry = operations[url.pathname];
        if (!entry || entry[1](ids).url !== address) throw failed();
        result = { ...base, operation: entry[0], accessToken, ...ids };
      }
    } else {
      const accessToken = token(request.headers, provider, false);
      if (yandexDownloadContentRequest({ href: address, method: 'GET', templated: false }).url !== address)
        throw failed();
      result = { ...base, operation: 'download_content', accessToken, link: address };
      maxBody = MAX_VERSION;
    }
  } else if (provider === 'yandex' && request.method === 'PUT' && hasBody) {
    const headers = object(request.headers, ['Content-Type']);
    if (headers['Content-Type'] !== 'application/octet-stream' || typeof request.body !== 'string') throw failed();
    let parsed;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      throw failed();
    }
    const checked = envelope(request.body, parsed?.datasetId, parsed?.versionId);
    const expected = yandexUploadContentRequest({
      link: { href: address, method: 'PUT', templated: false },
      datasetId: checked.datasetId,
      versionId: checked.versionId,
      envelope: checked
    });
    if (expected.url !== address || expected.body !== request.body) throw failed();
    result = {
      provider,
      operation: 'upload_content',
      datasetId: checked.datasetId,
      versionId: checked.versionId,
      link: address,
      body: request.body
    };
  } else throw failed();
  return { args: result, signal: request.signal, maxBody };
}

/**
 * Fetch-подобный адаптер для createAuthenticatedCloudSession. Один вызов остаётся
 * занят до ФАКТИЧЕСКОГО завершения invoke, даже если signal уже отменён; вызывающий
 * может показать таймаут раньше, но новая запись не должна начаться параллельно.
 * Это не межпроцессная защита, не устойчивый журнал и не гарантия остановки IPC.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:object)=>Promise<unknown>}} options
 * @returns {typeof fetch}
 */
export function createNativeDiskFetch(options) {
  let input;
  try {
    input = object(options, ['provider', 'invoke']);
    if (!['google', 'yandex'].includes(input.provider) || typeof input.invoke !== 'function') throw failed();
  } catch {
    throw failed();
  }
  const provider = input.provider;
  const invoke = input.invoke;
  let active = false;
  return /** @type {typeof fetch} */ (
    async (address, init) => {
      let request;
      try {
        request = checkedRequest(provider, address, init);
        if (active) throw failed();
      } catch {
        throw failed();
      }
      active = true;
      try {
        const result = object(await invoke('cloud_disk_network', { args: request.args }), [
          'status',
          'body',
          'contentType'
        ]);
        if (
          request.signal.aborted ||
          !Number.isInteger(result.status) ||
          result.status < 200 ||
          result.status > 599 ||
          (result.status >= 300 && result.status < 400) ||
          typeof result.body !== 'string' ||
          result.body.length > request.maxBody ||
          new TextEncoder().encode(result.body).byteLength > request.maxBody ||
          (result.status >= 400 && (result.body !== '' || result.contentType !== null)) ||
          (result.contentType !== null &&
            (typeof result.contentType !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(result.contentType)))
        )
          throw failed();
        const headers = result.contentType === null ? {} : { 'Content-Type': result.contentType };
        const response = new Response([204, 205].includes(result.status) ? null : result.body, {
          status: result.status,
          headers
        });
        // Response, собранный из IPC, сам по себе имеет пустой url. Указываем
        // только адрес проверенного запроса; переходы запрещены на native-уровне.
        Object.defineProperty(response, 'url', { value: address });
        return response;
      } catch {
        throw failed();
      } finally {
        active = false;
      }
    }
  );
}
