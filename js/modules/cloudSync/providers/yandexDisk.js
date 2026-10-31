// @ts-check
// Заготовка запросов Яндекс Диска; без OAuth, сети или подключения к приложению.
// Ссылки upload/download имеют подпись и считаются секретами; не писать их в логи.
// https://yandex.com/dev/disk-api/doc/en/reference/upload
// https://yandex.com/dev/disk-api/doc/en/reference/meta
import { versionFileName, envelopeBody } from './common.js';
import { isSyncId } from '../envelope.js';

const API = 'https://cloud-api.yandex.net/v1/disk/resources';
const ROOT = 'app:/';

function path(datasetId, versionId) {
  return ROOT + versionFileName(datasetId, versionId);
}
function apiRequest(endpoint, parameters) {
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, String(value));
  return {
    method: 'GET',
    url: url.toString(),
    credential: 'yandex',
    redirect: 'error',
    headers: { Accept: 'application/json' }
  };
}

/** Страницу списка нужно проверять и дочитывать целиком до применения любых изменений. */
export function yandexListRequest({ offset = 0, limit = 100 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Некорректная страница Яндекс Диска');
  }
  return apiRequest(API, { path: ROOT, offset, limit, sort: 'name' });
}

/**
 * Доступ к метаданным конкретной версии без перезаписи.
 * @param {{ datasetId?: string, versionId?: string }} [options]
 */
export function yandexMetadataRequest({ datasetId, versionId } = {}) {
  return apiRequest(API, { path: path(datasetId, versionId) });
}

/**
 * Выдача временной ссылки; overwrite=false обязателен.
 * @param {{ datasetId?: string, versionId?: string }} [options]
 */
export function yandexUploadLinkRequest({ datasetId, versionId } = {}) {
  return apiRequest(`${API}/upload`, { path: path(datasetId, versionId), overwrite: 'false' });
}

/** @param {{ datasetId?: string, versionId?: string }} [options] */
export function yandexDownloadLinkRequest({ datasetId, versionId } = {}) {
  return apiRequest(`${API}/download`, { path: path(datasetId, versionId) });
}

function checkedLink(link, method) {
  const invalid = () => new Error('Яндекс Диск вернул недопустимую ссылку');
  if (!link || typeof link !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(link))) {
    throw invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(link);
  for (const field of ['href', 'method', 'templated']) {
    if (!descriptors[field] || !('value' in descriptors[field])) throw invalid();
  }
  if (
    descriptors.method.value !== method ||
    descriptors.templated.value !== false ||
    typeof descriptors.href.value !== 'string' ||
    descriptors.href.value.length > 8192
  ) {
    throw invalid();
  }
  let url;
  try {
    url = new URL(descriptors.href.value);
  } catch {
    throw invalid();
  }
  const host = url.hostname;
  // Only the two observed Yandex transfer host families, not *.yandex.*.
  // Schema/host evidence is pinned in docs/CLOUD-SYNC-ACCEPTANCE.md.
  const official =
    method === 'PUT'
      ? /^uploader[a-z0-9-]*\.(?:dst|disk)\.yandex\.net$/.test(host)
      : ['downloader.dst.yandex.ru', 'downloader.disk.yandex.ru'].includes(host);
  const expectedPath = method === 'PUT' ? '/upload-target/' : '/disk/';
  if (
    !official ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !url.pathname.startsWith(expectedPath) ||
    /%2f|%5c|%2e/i.test(url.pathname)
  ) {
    throw invalid();
  }
  return url.toString();
}

/**
 * Загрузка по подписанной ссылке: без OAuth-токена и без переходов на другие хосты.
 * @param {{ link?: any, datasetId?: string, versionId?: string, envelope?: any }} [options]
 */
export function yandexUploadContentRequest({ link, datasetId, versionId, envelope } = {}) {
  if (!isSyncId(datasetId) || !isSyncId(versionId)) throw new Error('Некорректный идентификатор синхронизации');
  const body = envelopeBody(envelope, datasetId);
  if (envelope.versionId !== versionId) throw new Error('Облачная версия не совпадает с запрошенной');
  return {
    method: 'PUT',
    url: checkedLink(link, 'PUT'),
    credential: 'none',
    redirect: 'error',
    headers: { 'Content-Type': 'application/octet-stream' },
    body
  };
}

/** Документация требует тот же OAuth-токен при скачивании. Транспорт обязан заново проверить хост перед отправкой. */
export function yandexDownloadContentRequest(link) {
  return { method: 'GET', url: checkedLink(link, 'GET'), credential: 'yandex-download', redirect: 'error' };
}
