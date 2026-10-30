// @ts-check
// Заготовка запросов Google Drive API; без OAuth, сети или подключения к приложению.
// Перед выпуском нужны защищённый транспорт, обработка всех страниц, проверка после записи,
// восстановление после неизвестного ответа и тестирование на реальных аккаунтах.
// https://developers.google.com/workspace/drive/api/guides/manage-uploads
// https://developers.google.com/workspace/drive/api/guides/search-files
import { generateSyncId, isSyncId } from '../envelope.js';
import { envelopeBody, validGoogleId, versionFileName } from './common.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const MAX_MULTIPART_BYTES = 5_000_000;
const FOLDER_NAME = 'Твиноферма';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_QUERY =
  "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='tfFolder' and value='1' }";

/**
 * Поиск кандидатов по метке приложения, а не по имени: пользователь мог переименовать папку.
 * Один найденный ID сам по себе не подтверждает идентичность или полноту результатов.
 * @param {{pageToken?:string}} [options]
 */
export function googleListAppFoldersRequest({ pageToken } = {}) {
  if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 4096))
    throw new Error('Некорректная страница Google Диска');
  const url = new URL(API);
  url.searchParams.set('q', FOLDER_QUERY);
  url.searchParams.set('fields', 'nextPageToken,incompleteSearch,files(id,name,mimeType,appProperties)');
  url.searchParams.set('pageSize', '100');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return { method: 'GET', url: url.toString(), credential: credentials(), redirect: 'error' };
}

/**
 * Метаданные новой видимой папки. ID должен быть устойчиво сохранён вызывающей стороной
 * до единственного POST; этот строитель не создаёт папку и не подтверждает сохранность ID.
 * @param {{fileId?:string}} [options]
 */
export function googleCreateAppFolderRequest({ fileId } = {}) {
  if (!validGoogleId(fileId)) throw new Error('Некорректный ID папки Google Диска');
  const url = new URL(API);
  url.searchParams.set('fields', 'id,name,mimeType,appProperties');
  return {
    method: 'POST',
    url: url.toString(),
    credential: credentials(),
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: fileId, name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { tfFolder: '1' } })
  };
}

/** Получение идентификатора заранее помогает избежать дубликатов при повторе одного запроса. */
export function googleGenerateFileIdRequest() {
  const url = new URL(`${API}/generateIds`);
  url.searchParams.set('count', '1');
  url.searchParams.set('space', 'drive');
  url.searchParams.set('type', 'files');
  return { method: 'GET', url: url.toString(), credential: credentials(), redirect: 'error' };
}

function credentials() {
  // Маркер для будущего доверенного транспорта; OAuth-токен сюда не передаётся.
  return 'google';
}

/**
 * Пагинированный поиск версий в выбранной папке приложения.
 * @param {{ folderId?: string, datasetId?: string, versionId?: string, pageToken?: string }} [options]
 */
export function googleListRequest({ folderId, datasetId, versionId, pageToken } = {}) {
  if (!validGoogleId(folderId) || !isSyncId(datasetId) || (versionId !== undefined && !isSyncId(versionId))) {
    throw new Error('Некорректные параметры Google Диска');
  }
  if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 4096)) {
    throw new Error('Некорректная страница Google Диска');
  }
  const terms = [
    `'${folderId}' in parents`,
    'trashed = false',
    "appProperties has { key='tfFormat' and value='1' }",
    `appProperties has { key='tfDataset' and value='${datasetId}' }`
  ];
  if (versionId) terms.push(`appProperties has { key='tfVersion' and value='${versionId}' }`);
  const url = new URL(API);
  url.searchParams.set('q', terms.join(' and '));
  // modifiedTime — только справочная метка файла, не основание для выбора версии.
  url.searchParams.set('fields', 'nextPageToken,incompleteSearch,files(id,name,mimeType,appProperties,modifiedTime)');
  url.searchParams.set('pageSize', '100');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return { method: 'GET', url: url.toString(), credential: credentials(), redirect: 'error' };
}

/** Чтение файла по Google file ID; имя/метаданные не считаются подтверждением содержимого. */
export function googleDownloadRequest(fileId) {
  if (!validGoogleId(fileId)) throw new Error('Некорректный файл Google Диска');
  const url = new URL(`${API}/${fileId}`);
  url.searchParams.set('alt', 'media');
  return { method: 'GET', url: url.toString(), credential: credentials(), redirect: 'error' };
}

/**
 * Только создание новой версии, никогда PATCH или PUT поверх существующего файла.
 * @param {{ folderId?: string, datasetId?: string, envelope?: any, fileId?: string, cryptoSource?: Crypto }} [options]
 */
export function googleCreateRequest({ folderId, datasetId, envelope, fileId, cryptoSource } = {}) {
  if (!validGoogleId(folderId) || !isSyncId(datasetId) || (fileId !== undefined && !validGoogleId(fileId)))
    throw new Error('Некорректные параметры Google Диска');
  const body = envelopeBody(envelope, datasetId);
  const metadata = JSON.stringify({
    ...(fileId === undefined ? {} : { id: fileId }),
    name: versionFileName(datasetId, envelope.versionId),
    mimeType: 'application/octet-stream',
    parents: [folderId],
    appProperties: { tfFormat: '1', tfDataset: datasetId, tfVersion: envelope.versionId }
  });
  let boundary = '';
  for (let attempts = 0; attempts < 10; attempts++) {
    boundary = `tf_${generateSyncId(cryptoSource)}`;
    if (!metadata.includes(boundary) && !body.includes(boundary)) break;
    boundary = '';
  }
  if (!boundary) throw new Error('Не удалось подготовить облачную версию');
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${body}\r\n--${boundary}--\r\n`;
  if (multipart.length > MAX_MULTIPART_BYTES || new TextEncoder().encode(multipart).length > MAX_MULTIPART_BYTES) {
    throw new Error('Версия слишком большая для простой загрузки; нужна возобновляемая загрузка');
  }
  const url = new URL(UPLOAD);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', 'id,name,appProperties');
  return {
    method: 'POST',
    url: url.toString(),
    credential: credentials(),
    redirect: 'error',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart
  };
}
