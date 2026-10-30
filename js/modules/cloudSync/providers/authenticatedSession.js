// @ts-check
// Отключённая связка проверки аккаунта, записи и чтения с ОДНИМ access token.
// Она не устанавливает доверие при первом подключении, не хранит токены/ключи,
// не является очередью или межпроцессной блокировкой и не вызывается приложением.
// Связка не доказывает стабильность ID провайдера, права на все файлы или то,
// что доверенный fetch соблюдает TLS, CORS, запрет cookies и перенаправлений.
import { object } from '../exportSchema.js';
import { isSyncId } from '../envelope.js';
import { copyCloudEnvelope, validGoogleId } from './common.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';
import { createGoogleAccountIdentityReader, createYandexAccountIdentityReader } from './oauthAccountIdentity.js';
import { createReadOnlyCloudTransport } from './readOnlyTransport.js';
import { createCloudUploadTransport } from './uploadTransport.js';
import { createCloudVersionVerifier } from './versionVerifier.js';
import { createGoogleVersionReader, createYandexVersionReader } from './versionReaders.js';

function invalid() {
  return new Error('Не удалось подготовить облачное подключение');
}

/**
 * Каждый вызов перед действием сверяет идентификатор аккаунта тем же токеном,
 * который затем передаётся обоим транспортам. Совпадение само по себе НЕ
 * является согласием пользователя или достаточным доказательством доверия.
 * Ошибка/смена аккаунта блокирует последующее действие; исходные ошибки не выдаются.
 * Между проверкой и запросом возможны изменения на сервере. Повторы не выполняются.
 * Параллельные вызовы одного экземпляра отклоняются, другие экземпляры не блокируются.
 *
 * @param {{provider:'google'|'yandex',clientId:string,accountKey:string,datasetId:string,
 * accessToken:string,folderId?:string,fetchImpl?:typeof fetch,timeoutMs?:number,cryptoSource?:Crypto}} options
 */
export function createAuthenticatedCloudSession(options) {
  let input;
  try {
    input = object(
      options,
      ['provider', 'clientId', 'accountKey', 'datasetId', 'accessToken'],
      ['folderId', 'fetchImpl', 'timeoutMs', 'cryptoSource']
    );
    if (
      !['google', 'yandex'].includes(input.provider) ||
      !validOAuthClientId(input.provider, input.clientId) ||
      !validOAuthAccountKey(input.accountKey) ||
      !isSyncId(input.datasetId) ||
      (input.provider === 'google' ? !validGoogleId(input.folderId) : input.folderId !== undefined)
    )
      throw invalid();
  } catch {
    throw invalid();
  }
  const { provider, clientId, accountKey, datasetId, accessToken, folderId, cryptoSource } = input;
  const fetchImpl = input.fetchImpl === undefined ? globalThis.fetch : input.fetchImpl;
  const timeout = input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs };
  let identity, upload, get, reader, verifier;
  try {
    const identityFactory =
      provider === 'google' ? createGoogleAccountIdentityReader : createYandexAccountIdentityReader;
    identity = identityFactory({ fetchImpl, ...timeout });
    upload = createCloudUploadTransport({
      provider,
      datasetId,
      accessToken,
      fetchImpl,
      cryptoSource,
      ...timeout,
      ...(provider === 'google' ? { folderId } : {})
    });
    get = createReadOnlyCloudTransport({ provider, accessToken, fetchImpl, ...timeout });
    const send = request => get.send(request);
    reader =
      provider === 'google'
        ? createGoogleVersionReader({ datasetId, folderId, send })
        : createYandexVersionReader({ datasetId, send });
    verifier = createCloudVersionVerifier({
      provider,
      datasetId,
      send,
      ...(provider === 'google' ? { folderId } : {})
    });
  } catch {
    throw invalid();
  }
  let active = false;
  async function guarded(work, write = false) {
    // Нельзя начинать проверку или новую отправку, пока предыдущий write-fetch,
    // проигнорировавший abort, продолжает работать после показанного таймаута.
    if (active || upload.isBusy()) throw invalid();
    active = true;
    try {
      let found;
      try {
        const controller = new AbortController();
        found = await identity({ accessToken, clientId, signal: controller.signal });
      } catch {
        return { status: 'account_unavailable' };
      }
      if (found.accountKey !== accountKey) return { status: 'account_mismatch' };
      try {
        return await work();
      } catch {
        // Не делаем предположений об исходе записи при неожиданном исключении.
        return { status: write ? 'unknown' : 'unavailable' };
      }
    } finally {
      active = false;
    }
  }
  function versionArgs(value) {
    try {
      const fields = object(value, ['envelope'], provider === 'google' ? ['fileId'] : []);
      const envelope = copyCloudEnvelope(fields.envelope, datasetId);
      if (provider === 'google' && !validGoogleId(fields.fileId)) throw invalid();
      return Object.freeze({ envelope, ...(provider === 'google' ? { fileId: fields.fileId } : {}) });
    } catch {
      throw invalid();
    }
  }
  return Object.freeze({
    async generateFileId() {
      if (provider !== 'google') throw invalid();
      return guarded(() => upload.generateFileId());
    },
    /** @param {{envelope:any,fileId?:string}} args */
    async upload(args) {
      const checked = versionArgs(args);
      return guarded(() => upload.upload(checked), true);
    },
    /** @param {{envelope:any,fileId?:string}} args */
    async verify(args) {
      const checked = versionArgs(args);
      return guarded(() => verifier.verify(checked));
    },
    async listWithDates() {
      return guarded(async () => ({ status: 'listed', versions: await reader.listWithDates() }));
    },
    /** @param {string} versionId */
    async read(versionId) {
      if (!isSyncId(versionId)) throw invalid();
      return guarded(() => reader.read(versionId));
    }
  });
}
