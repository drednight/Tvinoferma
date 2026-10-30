// @ts-check
// Отключённая модель обнаружения и первичного создания папки Google. Сеть, IPC,
// устойчивое сохранение fileId и привязку аккаунта предоставляет вызывающая сторона.
// UI этот модуль не вызывает. Полный список и совпадение двух обходов не доказывают,
// что провайдер не скрыл папку или не вернул устаревшие данные. Имена/ID могут быть
// личными; не логировать их, токен, тела ответов или исходные ошибки.
import { array, object } from '../exportSchema.js';
import { validGoogleId } from './common.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';
import { createGoogleAccountIdentityReader } from './oauthAccountIdentity.js';
import {
  googleCreateAppFolderRequest,
  googleGenerateFileIdRequest,
  googleListAppFoldersRequest
} from './googleDrive.js';
import { parseStrictCloudJson } from './strictCloudJson.js';

const ERROR = 'Не удалось безопасно проверить папку Google Диска';
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_SMALL = 64 * 1024;
const MAX_PAGES = 128;
const MAX_FOLDERS = 128;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'Твиноферма';

function failed() {
  return new Error(ERROR);
}
function cancel(body) {
  try {
    const result = body?.cancel?.();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // Отмена тела не доказывает, что запрос остановился.
  }
}
async function boundedText(response, maxBytes) {
  const length = response.headers?.get?.('content-length');
  if (
    length !== null &&
    length !== undefined &&
    (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)
  )
    throw failed();
  if (!response.body || typeof response.body.getReader !== 'function') throw failed();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!ArrayBuffer.isView(part.value) || Object.prototype.toString.call(part.value) !== '[object Uint8Array]')
        throw failed();
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw failed();
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    try {
      const cancellation = reader.cancel();
      if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
    } catch {
      // Поток уже может быть закрыт.
    }
    throw failed();
  } finally {
    reader.releaseLock();
  }
}
function folder(value) {
  const item = object(value, ['id', 'name', 'mimeType', 'appProperties']);
  const properties = object(item.appProperties, ['tfFolder']);
  if (
    !validGoogleId(item.id) ||
    typeof item.name !== 'string' ||
    !item.name ||
    item.name.length > 512 ||
    [...item.name].some(character => {
      const code = character.codePointAt(0);
      return (
        code < 32 ||
        (code >= 127 && code <= 159) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) ||
        (code >= 0xd800 && code <= 0xdfff)
      );
    }) ||
    item.mimeType !== FOLDER_MIME ||
    properties.tfFolder !== '1'
  )
    throw failed();
  return Object.freeze({ folderId: item.id, name: item.name });
}

/**
 * Экземпляр связан с одним ранее подтверждённым аккаунтом и одним токеном. Перед каждой
 * операцией снова сверяется accountKey. Возвращённая папка — только кандидат, её нельзя
 * считать доверенной по одному имени. Создание — отдельный одноразовый вызов; fileId нужно
 * устойчиво сохранить ДО вызова. Неизвестный исход не повторяется этим экземпляром. Другой
 * экземпляр/процесс, потеря данных и откат хранилища здесь не защищены.
 * @param {{clientId:string,accountKey:string,accessToken:string,fetchImpl:typeof fetch,timeoutMs?:number}} options
 */
export function createGoogleFolderManager(options) {
  let input;
  try {
    input = object(options, ['clientId', 'accountKey', 'accessToken', 'fetchImpl'], ['timeoutMs']);
    if (
      !validOAuthClientId('google', input.clientId) ||
      !validOAuthAccountKey(input.accountKey) ||
      typeof input.accessToken !== 'string' ||
      !input.accessToken ||
      input.accessToken.length > 8192 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(input.accessToken) ||
      typeof input.fetchImpl !== 'function'
    )
      throw failed();
  } catch {
    throw failed();
  }
  const timeoutMs = input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 120000) throw failed();
  const { clientId, accountKey, accessToken, fetchImpl } = input;
  const identity = createGoogleAccountIdentityReader({ fetchImpl, timeoutMs });
  let active = false;
  let createSpent = false;

  async function run(kind, action) {
    if (active) return { status: 'busy' };
    let started;
    try {
      started = globalThis.performance.now();
      if (!Number.isFinite(started) || started < 0) throw failed();
    } catch {
      return { status: kind === 'create' ? 'not_sent' : 'unavailable' };
    }
    active = true;
    const controller = new AbortController();
    let submitted = false;
    let previous = started;
    let timer;
    const live = () => {
      const now = globalThis.performance.now();
      if (controller.signal.aborted || !Number.isFinite(now) || now < previous || now - started >= timeoutMs)
        throw failed();
      previous = now;
    };
    const send = async (request, isWrite = false) => {
      live();
      if (isWrite) submitted = true;
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: {
          ...request.headers,
          ...(isWrite ? { Accept: 'application/json' } : {}),
          Authorization: `Bearer ${accessToken}`
        },
        ...(Object.hasOwn(request, 'body') ? { body: request.body } : {}),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      try {
        live();
      } catch {
        cancel(response?.body);
        throw failed();
      }
      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status > 599 ||
        response.redirected ||
        response.type === 'opaque' ||
        response.type === 'opaqueredirect' ||
        response.url !== request.url ||
        (response.status >= 300 && response.status < 400)
      ) {
        cancel(response?.body);
        throw failed();
      }
      return response;
    };
    const scan = async () => {
      let pageToken;
      let pages = 0;
      const tokens = new Set();
      const ids = new Set();
      const folders = [];
      do {
        if (++pages > MAX_PAGES) throw failed();
        const request = googleListAppFoldersRequest(pageToken ? { pageToken } : {});
        const response = await send(request);
        if (response.status !== 200) {
          cancel(response.body);
          throw failed();
        }
        const page = object(
          parseStrictCloudJson(await boundedText(response, MAX_METADATA)),
          ['files'],
          ['incompleteSearch', 'nextPageToken']
        );
        live();
        if (Object.hasOwn(page, 'incompleteSearch') && page.incompleteSearch !== false) throw failed();
        const rows = array(page.files, folder);
        if (rows.length > 100) throw failed();
        for (const item of rows) {
          if (ids.has(item.folderId)) throw failed();
          ids.add(item.folderId);
          folders.push(item);
          if (folders.length > MAX_FOLDERS) throw failed();
        }
        if (Object.hasOwn(page, 'nextPageToken')) {
          if (
            typeof page.nextPageToken !== 'string' ||
            !page.nextPageToken ||
            page.nextPageToken.length > 4096 ||
            /[\uD800-\uDFFF]/u.test(page.nextPageToken) ||
            tokens.has(page.nextPageToken)
          )
            throw failed();
          pageToken = page.nextPageToken;
          tokens.add(pageToken);
        } else pageToken = undefined;
      } while (pageToken);
      return folders.sort((a, b) => a.folderId.localeCompare(b.folderId));
    };
    const consistent = async () => {
      const first = await scan();
      const second = await scan();
      if (JSON.stringify(first) !== JSON.stringify(second)) return null;
      return second;
    };
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: kind === 'create' ? (submitted ? 'unknown' : 'not_sent') : 'unavailable' });
      }, timeoutMs);
    });
    const work = (async () => {
      try {
        live();
        let found;
        try {
          found = await identity({ accessToken, clientId, signal: controller.signal });
        } catch {
          return { status: 'account_unavailable' };
        }
        live();
        if (found.accountKey !== accountKey) return { status: 'account_mismatch' };
        return await action({ send, consistent, live });
      } catch {
        controller.abort();
        return { status: kind === 'create' ? (submitted ? 'unknown' : 'not_sent') : 'unavailable' };
      } finally {
        active = false;
      }
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    isBusy() {
      return active;
    },
    /** Выданный ID необходимо сохранить вместе с намерением до создания папки. */
    async generateFileId() {
      return run('read', async ({ send, live }) => {
        const response = await send(googleGenerateFileIdRequest());
        if (response.status !== 200) {
          cancel(response.body);
          throw failed();
        }
        const result = object(parseStrictCloudJson(await boundedText(response, MAX_SMALL)), ['ids'], ['kind', 'space']);
        live();
        if (
          !Array.isArray(result.ids) ||
          result.ids.length !== 1 ||
          !validGoogleId(result.ids[0]) ||
          (result.kind !== undefined && result.kind !== 'drive#generatedIds') ||
          (result.space !== undefined && result.space !== 'drive')
        )
          throw failed();
        return { status: 'generated', fileId: result.ids[0] };
      });
    },
    /** Каждый найденный ID — только кандидат, отсутствие не доказывает, что папки нет. */
    async discover() {
      return run('read', async ({ consistent }) => {
        const folders = await consistent();
        if (!folders) return { status: 'changed' };
        return { status: folders.length === 0 ? 'empty' : folders.length === 1 ? 'candidate' : 'ambiguous', folders };
      });
    },
    /**
     * Отдельное явное решение вызывающего после backup и сохранения ID; не выполняет
     * автоматический повтор. Если перед POST уже видна папка, создание блокируется.
     * @param {{fileId:string}} args
     */
    async createOnce(args) {
      let fileId;
      try {
        const checked = object(args, ['fileId']);
        if (!validGoogleId(checked.fileId)) throw failed();
        fileId = checked.fileId;
      } catch {
        throw failed();
      }
      if (createSpent) return { status: 'blocked_in_session' };
      if (active) return { status: 'busy' };
      createSpent = true;
      return run('create', async ({ send, consistent, live }) => {
        const folders = await consistent();
        if (!folders) return { status: 'changed' };
        if (folders.length) return { status: 'existing' };
        const response = await send(googleCreateAppFolderRequest({ fileId }), true);
        if (response.status === 409) {
          cancel(response.body);
          return { status: 'conflict' };
        }
        if (![200, 201].includes(response.status)) {
          cancel(response.body);
          return { status: 'unknown' };
        }
        const created = folder(parseStrictCloudJson(await boundedText(response, MAX_SMALL)));
        live();
        if (created.folderId !== fileId || created.name !== FOLDER_NAME) throw failed();
        return { status: 'accepted' };
      });
    }
  });
}
