// @ts-check
// Транспорт только создания зашифрованных версий. Не подключён к приложению, OAuth
// или настоящим провайдерам. Доверенный fetch обязан соблюдать TLS, redirect и signal;
// проверка ответа не отменяет утечку, уже вызванную недоверенным fetch. Не логировать
// токен, тело, ID файла, подписанную ссылку или исходные ошибки. Структура envelope
// не доказывает, что вызывающий действительно зашифровал полезную нагрузку.
import {
  cloudAccessDiagnostic,
  cloudAccessHttpDiagnostic,
  withCloudAccessDiagnostic
} from './cloudAccessDiagnostics.js';
import { object } from '../exportSchema.js';
import { isSyncId } from '../envelope.js';
import { copyCloudEnvelope, validGoogleId, versionFileName } from './common.js';
import { googleCreateRequest, googleGenerateFileIdRequest } from './googleDrive.js';
import { yandexUploadContentRequest, yandexUploadLinkRequest } from './yandexDisk.js';

const MAX_REPLY_BYTES = 64 * 1024;
const TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

function invalid() {
  return new Error('Не удалось безопасно подготовить отправку облачной версии');
}
function failed() {
  return new Error('Не удалось проверить ответ облачного диска');
}
function cancelBody(body) {
  try {
    const pending = body?.cancel?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    // Отмена — только попытка, а не доказательство отсутствия запроса.
  }
}

// Ограниченный JSON для трёх маленьких ответов. Дубликаты имён, включая \uXXXX,
// не скрываются JSON.parse; неизвестные поля отклоняются отдельно по схеме ответа.
function parseReply(raw) {
  let index = 0;
  let nodes = 0;
  const space = () => {
    while (index < raw.length && ' \t\r\n'.includes(raw[index])) index++;
  };
  const string = () => {
    space();
    if (raw[index] !== '"') throw failed();
    const start = index++;
    while (index < raw.length) {
      const char = raw[index++];
      if (char === '\\') {
        if (index >= raw.length) throw failed();
        index++;
      } else if (char === '"') {
        const value = JSON.parse(raw.slice(start, index));
        if (typeof value !== 'string' || value.length > 16384) throw failed();
        return value;
      }
    }
    throw failed();
  };
  const read = depth => {
    if (++nodes > 100 || depth > 4) throw failed();
    space();
    if (raw[index] === '"') return string();
    if (raw.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (raw.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (raw[index] === '[') {
      index++;
      const values = [];
      space();
      if (raw[index] !== ']') {
        while (true) {
          values.push(read(depth + 1));
          if (values.length > 16) throw failed();
          space();
          if (raw[index] !== ',') break;
          index++;
        }
      }
      if (raw[index++] !== ']') throw failed();
      return values;
    }
    if (raw[index] === '{') {
      index++;
      const result = Object.create(null);
      space();
      if (raw[index] !== '}') {
        while (true) {
          const key = string();
          if (Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw failed();
          space();
          if (raw[index++] !== ':') throw failed();
          result[key] = read(depth + 1);
          space();
          if (raw[index] !== ',') break;
          index++;
        }
      }
      if (raw[index++] !== '}') throw failed();
      return result;
    }
    throw failed();
  };
  const result = read(0);
  space();
  if (index !== raw.length) throw failed();
  return result;
}

async function boundedText(response) {
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined) {
    if (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_REPLY_BYTES)
      throw failed();
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw failed();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let result = '';
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!ArrayBuffer.isView(chunk.value) || Object.prototype.toString.call(chunk.value) !== '[object Uint8Array]')
        throw failed();
      size += chunk.value.byteLength;
      if (size > MAX_REPLY_BYTES) throw failed();
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } catch {
    try {
      const cancellation = reader.cancel();
      if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
    } catch {
      // Поток может уже быть закрыт.
    }
    throw failed();
  } finally {
    reader.releaseLock();
  }
}
function checkResponse(response, requestUrl) {
  if (
    !response ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    response.redirected ||
    response.type === 'opaque' ||
    response.type === 'opaqueredirect' ||
    (response.url && response.url !== requestUrl) ||
    (response.status >= 300 && response.status < 400)
  )
    throw failed();
}

/**
 * Отдельный экземпляр для одного провайдера, набора и access token.
 * generateFileId() только для Google; fileId необходимо НАДЁЖНО сохранить до POST.
 * upload() создаёт один файл и не делает автоматических повторов. 'accepted' и
 * 'pending' не означают проверенного содержимого или устойчивой записи. 'conflict'
 * у Google означает лишь занятый ID; требуется отдельное чтение и сверка.
 * 'unknown' означает, что запрос записи мог уже дойти до сервера. Даже после таймаута
 * некооперативный fetch может продолжаться; слот занят до фактического завершения.
 * Хранилище, журнал попыток, согласование других процессов и сверка отсутствуют.
 * @param {{provider:'google'|'yandex',datasetId:string,accessToken:string,folderId?:string,
 * fetchImpl?:typeof fetch,timeoutMs?:number,cryptoSource?:Crypto}} options
 */
export function createCloudUploadTransport(options) {
  let input;
  try {
    input = object(
      options,
      ['provider', 'datasetId', 'accessToken'],
      ['folderId', 'fetchImpl', 'timeoutMs', 'cryptoSource']
    );
    if (
      !['google', 'yandex'].includes(input.provider) ||
      !isSyncId(input.datasetId) ||
      typeof input.accessToken !== 'string' ||
      input.accessToken.length < 1 ||
      input.accessToken.length > 8192 ||
      !TOKEN.test(input.accessToken) ||
      (input.provider === 'google' ? !validGoogleId(input.folderId) : input.folderId !== undefined)
    )
      throw invalid();
  } catch {
    throw invalid();
  }
  const { provider, datasetId, accessToken, folderId, cryptoSource } = input;
  const fetchImpl = input.fetchImpl === undefined ? globalThis.fetch : input.fetchImpl;
  const timeoutMs = input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 120000)
    throw invalid();
  let active = false;

  // Таймер охватывает fetch и чтение потока. Проверяем также монотонный срок:
  // отложенный timer callback сам по себе не должен разрешить поздний PUT.
  async function run(work, kind) {
    if (active) throw invalid();
    let startedAt;
    try {
      startedAt = globalThis.performance.now();
      if (!Number.isFinite(startedAt) || startedAt < 0) throw failed();
    } catch {
      return { status: kind === 'generate' ? 'unavailable' : 'not_sent' };
    }
    active = true;
    const controller = new AbortController();
    const stage = kind === 'generate' ? 'file_id' : 'upload_link';
    let submitted = false;
    let timer;
    let lastTime = startedAt;
    const requireLive = () => {
      let now;
      try {
        now = globalThis.performance.now();
      } catch {
        throw failed();
      }
      if (controller.signal.aborted || now - startedAt >= timeoutMs)
        throw withCloudAccessDiagnostic(failed(), `${stage}_timeout`);
      if (!Number.isFinite(now) || now < lastTime) throw failed();
      lastTime = now;
    };
    const invoke = async (request, headers, body, isWrite) => {
      requireLive();
      if (isWrite) submitted = true;
      let response;
      try {
        response = await fetchImpl(request.url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal
        });
      } catch {
        throw withCloudAccessDiagnostic(failed(), `${stage}_transport_unavailable`);
      }
      try {
        requireLive();
      } catch (error) {
        cancelBody(response?.body);
        throw withCloudAccessDiagnostic(failed(), cloudAccessDiagnostic(error));
      }
      checkResponse(response, request.url);
      return response;
    };
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(
          withCloudAccessDiagnostic(
            { status: kind === 'generate' ? 'unavailable' : submitted ? 'unknown' : 'not_sent' },
            submitted ? undefined : `${stage}_timeout`
          )
        );
      }, timeoutMs);
    });
    const operation = (async () => {
      try {
        return await work(invoke, requireLive);
      } catch (error) {
        controller.abort();
        return withCloudAccessDiagnostic(
          { status: kind === 'generate' ? 'unavailable' : submitted ? 'unknown' : 'not_sent' },
          submitted ? undefined : cloudAccessDiagnostic(error) || `${stage}_invalid_response`
        );
      } finally {
        active = false;
      }
    })();
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    /** True до фактического завершения даже после показанного таймаута. */
    isBusy() {
      return active;
    },
    /** Выданный ID нужно сохранить вместе с намерением до отправки файла. */
    async generateFileId() {
      if (provider !== 'google') throw invalid();
      return run(async (invoke, requireLive) => {
        const request = googleGenerateFileIdRequest();
        const response = await invoke(request, { Authorization: `Bearer ${accessToken}` }, undefined, false);
        if (response.status !== 200) {
          cancelBody(response.body);
          return withCloudAccessDiagnostic(
            { status: 'unavailable' },
            cloudAccessHttpDiagnostic('file_id', response.status)
          );
        }
        const result = object(parseReply(await boundedText(response)), ['ids'], ['kind', 'space']);
        requireLive();
        if (
          !Array.isArray(result.ids) ||
          result.ids.length !== 1 ||
          !validGoogleId(result.ids[0]) ||
          (result.kind !== undefined && result.kind !== 'drive#generatedIds') ||
          (result.space !== undefined && result.space !== 'drive')
        )
          throw failed();
        return { status: 'generated', fileId: result.ids[0] };
      }, 'generate');
    },

    /** @param {{envelope:any,fileId?:string}} options */
    async upload(options) {
      let args;
      let envelope;
      try {
        args = object(options, ['envelope'], provider === 'google' ? ['fileId'] : []);
        envelope = copyCloudEnvelope(args.envelope, datasetId);
        if (provider === 'google' && !validGoogleId(args.fileId)) throw invalid();
      } catch {
        throw invalid();
      }
      // Создаём и проверяем тело до первого await, не позволяем подменить конверт.
      const google =
        provider === 'google'
          ? googleCreateRequest({ folderId, datasetId, envelope, fileId: args.fileId, cryptoSource })
          : null;
      const linkRequest =
        provider === 'yandex' ? yandexUploadLinkRequest({ datasetId, versionId: envelope.versionId }) : null;
      return run(async (invoke, requireLive) => {
        if (google) {
          const response = await invoke(
            google,
            { ...google.headers, Authorization: `Bearer ${accessToken}` },
            google.body,
            true
          );
          if (response.status === 409) {
            cancelBody(response.body);
            return { status: 'conflict' };
          }
          if (![200, 201].includes(response.status)) {
            cancelBody(response.body);
            return { status: 'unknown' };
          }
          const data = object(parseReply(await boundedText(response)), ['id', 'name', 'appProperties']);
          const properties = object(data.appProperties, ['tfFormat', 'tfDataset', 'tfVersion']);
          requireLive();
          if (
            data.id !== args.fileId ||
            data.name !== versionFileName(datasetId, envelope.versionId) ||
            properties.tfFormat !== '1' ||
            properties.tfDataset !== datasetId ||
            properties.tfVersion !== envelope.versionId
          )
            throw failed();
          return { status: 'accepted' };
        }
        const response = await invoke(
          linkRequest,
          { ...linkRequest.headers, Authorization: `OAuth ${accessToken}` },
          undefined,
          false
        );
        if (response.status !== 200) {
          cancelBody(response.body);
          // При 409 цель уже занята: PUT в этой попытке не выполнялся, но файл
          // нужно сверить, а не автоматически повторять запрос ссылки.
          return withCloudAccessDiagnostic(
            { status: response.status === 409 ? 'conflict' : 'not_sent' },
            response.status === 409 ? undefined : cloudAccessHttpDiagnostic('upload_link', response.status)
          );
        }
        const link = object(parseReply(await boundedText(response)), ['href', 'method', 'templated']);
        requireLive();
        // Строитель вновь проверяет HTTPS, хост, путь и метод временной ссылки.
        const upload = yandexUploadContentRequest({ link, datasetId, versionId: envelope.versionId, envelope });
        requireLive();
        const sent = await invoke(upload, upload.headers, upload.body, true);
        cancelBody(sent.body);
        if (sent.status === 201) return { status: 'accepted' };
        if (sent.status === 202) return { status: 'pending' };
        return { status: 'unknown' };
      }, 'upload');
    }
  });
}
