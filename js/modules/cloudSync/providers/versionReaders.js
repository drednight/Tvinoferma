// @ts-check
// Изолированные протоколы ЧТЕНИЯ Google и Яндекс Диска. Они получают зашифрованные
// конверты, не расшифровывают их и не применяют к приложению; записи/удаления нет.
// Два последовательных полных обхода обнаруживают некоторые гонки, но облако может скрыть
// неизвестную ветку или вернуть одинаковые устаревшие списки. Пины, проверка истории,
// безопасное локальное применение и реальные аккаунты нужны отдельно.
import { object, array } from '../exportSchema.js';
import { isSyncId, validateEnvelope } from '../envelope.js';
import { copyCloudEnvelope, validGoogleId, versionFileName } from './common.js';
import { googleDownloadRequest, googleListRequest } from './googleDrive.js';
import { yandexDownloadContentRequest, yandexDownloadLinkRequest, yandexListRequest } from './yandexDisk.js';
import { parseCloudModifiedTime } from './modifiedTime.js';

import { STANDALONE_DATASET_ID, MAX_STANDALONE_COPIES } from '../standaloneFileConstants.js';

const MAX_PAGES = 128;
// One temporary checkpoint file; logical limits remain enforced by verifyHistory.
const MAX_VERSIONS = 129;
const MAX_YANDEX_ITEMS = 5000;
const PAGE_SIZE = 100;
const MAX_METADATA_TEXT = 2 * 1024 * 1024;
const MAX_VERSION_TEXT = 45 * 1024 * 1024;
const VERSION_NAME = /^tf-v1-([0-9a-f-]{36})-([0-9a-f-]{36})\.tfsc$/;

function malformed() {
  return new Error('Некорректный или неполный ответ облачного диска');
}
function changed() {
  return new Error('Список облачных версий изменился во время чтения; повторите проверку');
}
function failed() {
  return new Error('Не удалось прочитать облачный диск');
}
async function sendSafe(send, request, maxText = MAX_METADATA_TEXT) {
  let raw;
  try {
    raw = await send(request);
  } catch {
    // Ошибка транспорта может содержать подписанную ссылку или заголовки.
    throw failed();
  }
  const data = object(raw, ['status', 'body']);
  if (
    !Number.isInteger(data.status) ||
    data.status < 100 ||
    data.status > 599 ||
    typeof data.body !== 'string' ||
    data.body.length > maxText
  )
    throw malformed();
  return { status: data.status, body: data.body };
}
function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw malformed();
  }
}
function positiveResponse(response) {
  if (response.status !== 200) throw failed();
  return json(response.body);
}
function envelope(text, datasetId, versionId) {
  const parsed = json(text);
  try {
    validateEnvelope(parsed);
    const copy = copyCloudEnvelope(parsed, datasetId);
    // Писатель создаёт канонический JSON: иная запись может скрывать дубли полей.
    if (copy.versionId !== versionId || JSON.stringify(copy) !== text) throw malformed();
    // Это ещё не проверка AES-GCM, доверенного pin или истории.
    return copy;
  } catch {
    throw malformed();
  }
}
function sameManifest(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
function timestampForDisplay(value) {
  const modifiedAt = parseCloudModifiedTime(value);
  // Исходное допустимое представление сохраняем лишь на время двух обходов,
  // чтобы заметить изменение даже с точностью больше миллисекунды.
  return { modifiedAt, observedStamp: modifiedAt === null ? null : value };
}
function checkedOptions(options, google) {
  const input = object(options, google ? ['datasetId', 'folderId', 'send'] : ['datasetId', 'send']);
  if (!isSyncId(input.datasetId) || (google && !validGoogleId(input.folderId)) || typeof input.send !== 'function')
    throw malformed();
  return { datasetId: input.datasetId, folderId: input.folderId, send: input.send };
}

/** @param {{datasetId: string, folderId: string, send: (request: any) => Promise<any>}} options */
export function createGoogleVersionReader(options) {
  const { datasetId, folderId, send } = checkedOptions(options, true);
  async function scan(versionId) {
    let token;
    let pages = 0;
    const tokens = new Set();
    const fileIds = new Set();
    const versionIds = new Set();
    const files = [];
    do {
      if (++pages > MAX_PAGES) throw malformed();
      const request = googleListRequest({
        folderId,
        datasetId,
        ...(versionId ? { versionId } : {}),
        ...(token ? { pageToken: token } : {})
      });
      const page = object(
        positiveResponse(await sendSafe(send, request)),
        ['files'],
        ['incompleteSearch', 'nextPageToken']
      );
      if (Object.hasOwn(page, 'incompleteSearch') && page.incompleteSearch !== false) throw malformed();
      const pageFiles = array(page.files, value => value);
      if (pageFiles.length > PAGE_SIZE) throw malformed();
      for (const value of pageFiles) {
        const file = object(value, ['id', 'name', 'mimeType', 'appProperties'], ['modifiedTime']);
        const props = object(file.appProperties, ['tfFormat', 'tfDataset', 'tfVersion']);
        if (
          !validGoogleId(file.id) ||
          !isSyncId(props.tfVersion) ||
          props.tfFormat !== '1' ||
          props.tfDataset !== datasetId ||
          (versionId && props.tfVersion !== versionId) ||
          file.name !== versionFileName(datasetId, props.tfVersion) ||
          file.mimeType !== 'application/octet-stream' ||
          fileIds.has(file.id) ||
          versionIds.has(props.tfVersion)
        )
          throw malformed();
        fileIds.add(file.id);
        versionIds.add(props.tfVersion);
        files.push({ id: file.id, versionId: props.tfVersion, ...timestampForDisplay(file.modifiedTime) });
        if (files.length > (datasetId === STANDALONE_DATASET_ID ? MAX_STANDALONE_COPIES : MAX_VERSIONS))
          throw malformed();
      }
      if (Object.hasOwn(page, 'nextPageToken')) {
        if (
          typeof page.nextPageToken !== 'string' ||
          !page.nextPageToken ||
          page.nextPageToken.length > 4096 ||
          tokens.has(page.nextPageToken)
        )
          throw malformed();
        token = page.nextPageToken;
        tokens.add(token);
      } else token = undefined;
    } while (token);
    return files.sort((a, b) => a.versionId.localeCompare(b.versionId));
  }
  async function consistent(versionId) {
    const first = await scan(versionId);
    const second = await scan(versionId);
    const manifest = list => list.map(item => JSON.stringify([item.versionId, item.id, item.observedStamp]));
    if (!sameManifest(manifest(first), manifest(second))) throw changed();
    return second;
  }
  async function readVersion(versionId, expectedFileId, includeSerialized) {
    if (!isSyncId(versionId) || (expectedFileId !== undefined && !validGoogleId(expectedFileId))) throw malformed();
    const files = await consistent(versionId);
    if (!files.length) return { status: 'not_found' };
    // Для подтверждения записи важен именно заранее сохранённый Google ID, а не
    // другой файл с таким же versionId или именем.
    if (expectedFileId !== undefined && files[0].id !== expectedFileId) return { status: 'identity_mismatch' };
    const response = await sendSafe(send, googleDownloadRequest(files[0].id), MAX_VERSION_TEXT);
    if (response.status !== 200) throw failed();
    let parsed;
    try {
      parsed = envelope(response.body, datasetId, versionId);
    } catch {
      // Для readExact ответ сервиса получен: некорректные байты точно не совпадают
      // с отправленным каноническим файлом, а не являются сетевой недоступностью.
      if (includeSerialized) return { status: 'content_mismatch' };
      throw malformed();
    }
    return {
      status: 'found',
      envelope: parsed,
      ...(includeSerialized ? { serialized: response.body, fileId: files[0].id } : {})
    };
  }
  return Object.freeze({
    async list() {
      const files = await consistent();
      return files.map(file => ({ versionId: file.versionId }));
    },
    /**
     * Справочная дата изменения файла по ответу диска, без идентификаторов Google.
     * Не подтверждает актуальность или соответствие затем скачанному содержимому.
     */
    async listWithDates() {
      const files = await consistent();
      return files.map(file => ({ versionId: file.versionId, modifiedAt: file.modifiedAt }));
    },
    /** Отсутствие здесь не подтверждает удаление ранее известной версии. */
    async read(versionId) {
      return readVersion(versionId, undefined, false);
    },
    async readForRetirement(versionId) {
      return readVersion(versionId, undefined, true);
    },
    /** Для сверки после отправки: полные списки, ожидаемый ID и оригинальные байты JSON. */
    async readExact(versionId, fileId) {
      if (!validGoogleId(fileId)) throw malformed();
      return readVersion(versionId, fileId, true);
    }
  });
}

// JSON от сервиса может содержать дополнительные метаданные. Используем лишь явные собственные
// поля и не включаем посторонние данные, пути и имена в результаты или сообщения.
function own(value, key) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.hasOwn(value, key)
  )
    throw malformed();
  return value[key];
}
function nameVersion(name) {
  const match = VERSION_NAME.exec(name);
  if (!match || !isSyncId(match[1]) || !isSyncId(match[2]) || versionFileName(match[1], match[2]) !== name)
    throw malformed();
  return { datasetId: match[1], versionId: match[2] };
}

/** @param {{datasetId: string, send: (request: any) => Promise<any>}} options */
export function createYandexVersionReader(options) {
  const { datasetId, send } = checkedOptions(options, false);
  async function scan() {
    let offset = 0;
    let pages = 0;
    let total;
    const all = [];
    const seen = new Set();
    const versions = [];
    do {
      if (++pages > MAX_PAGES) throw malformed();
      const root = positiveResponse(await sendSafe(send, yandexListRequest({ offset, limit: PAGE_SIZE })));
      if (own(root, 'type') !== 'dir') throw malformed();
      const embedded = own(root, '_embedded');
      const foundOffset = own(embedded, 'offset');
      const limit = own(embedded, 'limit');
      const count = own(embedded, 'total');
      const rows = array(own(embedded, 'items'), value => value);
      if (
        foundOffset !== offset ||
        limit !== PAGE_SIZE ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > MAX_YANDEX_ITEMS ||
        (total !== undefined && total !== count) ||
        rows.length > PAGE_SIZE ||
        offset + rows.length > count ||
        (rows.length === 0 && offset < count)
      )
        throw malformed();
      total = count;
      for (const value of rows) {
        const name = own(value, 'name');
        const type = own(value, 'type');
        if (
          typeof name !== 'string' ||
          !name ||
          name.length > 512 ||
          /[\\/]/.test(name) ||
          !['file', 'dir'].includes(type) ||
          seen.has(name)
        )
          throw malformed();
        seen.add(name);
        all.push(`${type}:${name}`);
        if (!name.startsWith('tf-v')) continue;
        const candidate = nameVersion(name);
        if (type !== 'file') throw malformed();
        if (candidate.datasetId === datasetId) {
          const modified = Object.hasOwn(value, 'modified') ? own(value, 'modified') : undefined;
          versions.push({ versionId: candidate.versionId, ...timestampForDisplay(modified) });
          if (versions.length > (datasetId === STANDALONE_DATASET_ID ? MAX_STANDALONE_COPIES : MAX_VERSIONS))
            throw malformed();
        }
      }
      offset += rows.length;
    } while (offset < total);
    return { all: all.sort(), versions: versions.sort((a, b) => a.versionId.localeCompare(b.versionId)) };
  }
  async function consistent() {
    const first = await scan();
    const second = await scan();
    const dates = list => list.map(item => JSON.stringify([item.versionId, item.observedStamp]));
    if (!sameManifest(first.all, second.all) || !sameManifest(dates(first.versions), dates(second.versions)))
      throw changed();
    return second.versions;
  }
  async function readVersion(versionId, includeSerialized) {
    if (!isSyncId(versionId)) throw malformed();
    const linkResponse = await sendSafe(send, yandexDownloadLinkRequest({ datasetId, versionId }));
    if (linkResponse.status === 404) return { status: 'not_found' };
    const link = positiveResponse(linkResponse);
    // Не используем путь или хост из ответа без повторной проверки строителем запроса.
    const content = await sendSafe(send, yandexDownloadContentRequest(link), MAX_VERSION_TEXT);
    if (content.status !== 200) throw failed();
    let parsed;
    try {
      parsed = envelope(content.body, datasetId, versionId);
    } catch {
      if (includeSerialized) return { status: 'content_mismatch' };
      throw malformed();
    }
    return { status: 'found', envelope: parsed, ...(includeSerialized ? { serialized: content.body } : {}) };
  }
  return Object.freeze({
    async readForRetirement(versionId) {
      return readVersion(versionId, true);
    },
    async list() {
      const versions = await consistent();
      return versions.map(({ versionId }) => ({ versionId }));
    },
    /** Дата — неподписанные метаданные файла и не доказывает его актуальность. */
    async listWithDates() {
      const versions = await consistent();
      return versions.map(({ versionId, modifiedAt }) => ({ versionId, modifiedAt }));
    },
    /** 404 — только отсутствие в ответе сервиса, а не подтверждённое удаление. */
    async read(versionId) {
      return readVersion(versionId, false);
    },
    /** Оригинальные байты JSON для сверки именно отправленного конверта. */
    async readExact(versionId) {
      return readVersion(versionId, true);
    }
  });
}
