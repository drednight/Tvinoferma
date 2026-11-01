// @ts-check
import { recordCloudDiagnostic } from '../cloudDiagnostics.js';
// Экспериментальная связка уже подтверждённой локальной записи, доступа к диску
// и проверки аккаунта. Она НЕ подключена к UI/настоящим токенам. Ожидаемая
// привязка должна поступать из ранее проверенной защищённой конфигурации; сама
// запись ОС, текущий ответ провайдера и этот код не доказывают согласие/свежесть.
// Секреты, записи, параметры IPC, аккаунты и исходные ошибки не журналируются.
import { cloudAccessDiagnostic, withCloudAccessDiagnostic, googleRefreshDiagnostic } from './cloudAccessDiagnostics.js';
import { recalledGoogleAccess, rememberGoogleAccess } from './googleAccessMemory.js';
import { createNativeVersionRetirement } from './nativeVersionRetirement.js';
import { object } from '../exportSchema.js';
import { isSyncId } from '../envelope.js';
import { historyEnvelopePin } from '../history.js';
import { parsePairingCode } from '../pairingCode.js';
import { validGoogleId } from './common.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';
import { validCredentialId, parseGoogleCredentialRecord } from './oauthCredentialRecord.js';
import { parseYandexCredentialRecord } from './oauthYandexCredentialRecord.js';
import { createNativeGoogleCredentialStore, readNativeCredentialBinding } from './nativeCredentialStore.js';
import { createNativeGoogleRefreshFetch } from './nativeGoogleRefreshFetch.js';
import { createGoogleCredentialRotation } from './oauthCredentialRotation.js';
import {
  createGoogleAccountPreviewReader,
  createYandexAccountPreviewReader,
  createGoogleAccountIdentityReader
} from './oauthAccountIdentity.js';
import { createNativeDiskFetch } from './nativeDiskFetch.js';
import { createAuthenticatedCloudSession } from './authenticatedSession.js';
import { createGoogleFolderManager } from './googleFolderManager.js';

const ERROR = 'Не удалось безопасно подготовить облачную сессию';
const EXPIRY_MARGIN_MS = 5000;
function googleRotationFailure(value) {
  const codes = {
    blocked_pending: 'credential_refresh_pending',
    refresh_expired: 'login_required',
    store_unavailable: 'credential_unavailable',
    exchange_uncertain: 'google_refresh_unconfirmed',
    begin_uncertain: 'google_refresh_store_unconfirmed',
    finish_uncertain: 'google_refresh_store_unconfirmed',
    scope_unverified: 'google_scope_unverified',
    identity_unverified: 'account_unavailable',
    account_changed: 'account_changed',
    refreshed_access_expired: 'login_required',
    busy: 'busy',
    changed: 'credential_changed'
  };
  return Object.hasOwn(codes, value) ? codes[value] : 'credential_binding_blocked';
}
function failed() {
  return new Error(ERROR);
}
function status(value) {
  return Object.freeze({ status: value });
}
async function within(invoke, command, args, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(command, args)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failed()), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function credentialMatches(record, binding) {
  return (
    record.slotId === binding.slotId && record.clientId === binding.clientId && record.accountKey === binding.accountKey
  );
}
function clock(now) {
  let last = null;
  return () => {
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0 || (last !== null && current < last)) throw failed();
    last = current;
    return current;
  };
}

/**
 * Обновляет Google-доступ через CAS ready→pending→ready или читает ограниченный
 * по сроку access Яндекса; refresh Яндекса намеренно не выполняется. Перед каждой
 * операцией повторно проверяет локальную запись и срок, а сетевой слой отдельно
 * сверяет тот же аккаунт. Это не атомарно с последующим сетевым вызовом; другая
 * программа, откат/удаление обеих частей, системное время и память не защищены.
 * Для Google ошибка после POST может оставить pending и потребовать новый вход.
 *
 * @param {{provider:'google'|'yandex',slotId:string,clientId:string,accountKey:string,
 * datasetId:string,folderId?:string,invoke:(command:string,args:any)=>Promise<any>,
 * cryptoSource?:Crypto,now?:()=>number,timeoutMs?:number}} options
 */
export async function openNativeCloudSession(options) {
  return openSession(options, false);
}

// Общее получение доступа и проверка записи. Режим поиска намеренно не принимает
// datasetId/folderId и не возвращает никаких методов записи или генерации ID.
async function openSession(options, folderDiscoveryOnly, standaloneFolderWrite = false) {
  let input;
  try {
    input = object(
      options,
      folderDiscoveryOnly
        ? ['provider', 'slotId', 'clientId', 'accountKey', 'invoke']
        : ['provider', 'slotId', 'clientId', 'accountKey', 'datasetId', 'invoke'],
      folderDiscoveryOnly ? ['cryptoSource', 'now', 'timeoutMs'] : ['folderId', 'cryptoSource', 'now', 'timeoutMs']
    );
    if (
      !['google', 'yandex'].includes(input.provider) ||
      (folderDiscoveryOnly && input.provider !== 'google') ||
      !validCredentialId(input.slotId) ||
      !validOAuthClientId(input.provider, input.clientId) ||
      !validOAuthAccountKey(input.accountKey) ||
      (!folderDiscoveryOnly &&
        (!isSyncId(input.datasetId) ||
          (input.provider === 'google' ? !validGoogleId(input.folderId) : input.folderId !== undefined))) ||
      typeof input.invoke !== 'function' ||
      (input.now !== undefined && typeof input.now !== 'function') ||
      (input.timeoutMs !== undefined &&
        (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 20 || input.timeoutMs > 120_000))
    )
      throw failed();
  } catch {
    throw failed();
  }
  const provider = /** @type {'google'|'yandex'} */ (input.provider);
  const { slotId, clientId, accountKey, datasetId, invoke } = input;
  const timeoutMs = /** @type {number} */ (input.timeoutMs ?? 25_000);
  const now = clock(input.now || (() => Date.now()));
  const binding = { slotId, clientId, accountKey };
  try {
    const diskFetch = createNativeDiskFetch({ provider, invoke });
    let read;
    let raw;
    let token;
    let expiresAt;
    if (provider === 'google') {
      const store = createNativeGoogleCredentialStore({ ...binding, invoke, timeoutMs });
      read = store.read;
      raw = await read();
      const cached = recalledGoogleAccess({ invoke, record: raw, now: now() });
      if (cached) {
        recordCloudDiagnostic({ stage: 'google_access', provider, outcome: 'reused' });
        token = cached.accessToken;
        expiresAt = cached.expiresAt;
      } else {
        let refreshDiagnostic;
        const rotation = createGoogleCredentialRotation({
          ...binding,
          store,
          makeGuardedFetch: claim =>
            createNativeGoogleRefreshFetch({
              invoke,
              claim,
              onDiagnostic: code => {
                refreshDiagnostic = googleRefreshDiagnostic(code);
              }
            }),
          verifyAccount: createGoogleAccountIdentityReader({ fetchImpl: diskFetch, timeoutMs }),
          now,
          timeoutMs,
          identityTimeoutMs: timeoutMs,
          ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
        });
        const current = /** @type {{status:string,revision?:string}} */ (await rotation.inspect());
        if (current.status === 'refresh_expired') return status('login_required');
        if (current.status !== 'ready' || typeof current.revision !== 'string')
          return status(googleRotationFailure(current.status));
        recordCloudDiagnostic({ stage: 'google_access', provider, outcome: 'start' });
        const result = /** @type {{status:string,access?:{summary:{expiresAt:number},takeAccessToken:()=>string}}} */ (
          await rotation.refresh({ expectedRevision: current.revision })
        );
        recordCloudDiagnostic({
          stage: 'google_access',
          provider,
          outcome: result.status === 'refreshed' ? 'refreshed' : 'blocked',
          code: result.status === 'refreshed' ? null : refreshDiagnostic || googleRotationFailure(result.status)
        });
        if (result.status === 'refresh_expired') return status('login_required');
        if (result.status !== 'refreshed' || !result.access)
          return withCloudAccessDiagnostic(status(googleRotationFailure(result.status)), refreshDiagnostic);
        expiresAt = result.access.summary.expiresAt;
        token = result.access.takeAccessToken();
        raw = await read();
        if (typeof raw !== 'string') return status('credential_binding_blocked');
        const parsed = parseGoogleCredentialRecord(raw);
        if (!credentialMatches(parsed, binding) || parsed.phase !== 'ready')
          return status('credential_binding_blocked');
        rememberGoogleAccess({ invoke, record: raw, accessToken: token, expiresAt, now: now() });
      }
    } else {
      read = async () => {
        const reply = object(
          await within(invoke, 'cloud_credential_read', { provider }, timeoutMs),
          ['status'],
          ['slotId', 'record']
        );
        if (reply.status === 'empty' && Object.keys(reply).length === 1) return null;
        if (reply.status !== 'ready' || Object.keys(reply).length !== 3 || reply.slotId !== slotId) throw failed();
        const parsed = parseYandexCredentialRecord(reply.record);
        if (!credentialMatches(parsed, binding)) throw failed();
        return reply.record;
      };
      raw = await read();
      if (raw === null) return status('credential_blocked');
      const parsed = parseYandexCredentialRecord(raw);
      token = parsed.accessToken;
      expiresAt = parsed.expiresAt;
    }
    if (now() + EXPIRY_MARGIN_MS >= expiresAt) return status('login_required');
    let active = false;
    let disposed = false;
    async function guard(work, write = false) {
      if (disposed || active) return status('account_unavailable');
      active = true;
      try {
        try {
          if (
            now() + EXPIRY_MARGIN_MS >= expiresAt ||
            (await read()) !== raw ||
            disposed ||
            now() + EXPIRY_MARGIN_MS >= expiresAt
          )
            return status('account_unavailable');
        } catch {
          // Здесь вызов сети ещё не начался.
          return status('account_unavailable');
        }
        try {
          return await work();
        } catch (error) {
          // После начала work исключение не доказывает отсутствие отправки.
          return withCloudAccessDiagnostic(status(write ? 'unknown' : 'unavailable'), cloudAccessDiagnostic(error));
        }
      } finally {
        active = false;
      }
    }
    // Optional UI-only read. It is never run merely by opening a session, and
    // never becomes an authorization/account binding decision. Recheck the exact
    // protected record AFTER the network response before releasing its label.
    function previewAccountLabel() {
      return guard(async () => {
        const reader =
          provider === 'google'
            ? createGoogleAccountPreviewReader({ fetchImpl: diskFetch, timeoutMs: input.timeoutMs ?? 70_000 })
            : createYandexAccountPreviewReader({ fetchImpl: diskFetch, timeoutMs: input.timeoutMs ?? 70_000 });
        const identity = await reader({ clientId, accessToken: token, signal: new AbortController().signal });
        if (
          identity.accountKey !== accountKey ||
          (await read()) !== raw ||
          disposed ||
          now() + EXPIRY_MARGIN_MS >= expiresAt
        )
          return status('account_unavailable');
        recordCloudDiagnostic({ stage: 'account_label', provider, outcome: 'ok' });
        return Object.freeze({ status: 'label_verified', label: identity.label });
      });
    }
    if (folderDiscoveryOnly) {
      const manager = createGoogleFolderManager({
        clientId,
        accountKey,
        accessToken: token,
        fetchImpl: diskFetch,
        timeoutMs
      });
      let candidates = new Set();
      const session = Object.freeze({
        previewAccountLabel,
        ...(standaloneFolderWrite
          ? {
              generateFileId() {
                return guard(() => manager.generateFileId());
              },
              createOnce(args) {
                return guard(() => manager.createOnce(args), true);
              }
            }
          : {}),
        async discover() {
          candidates = new Set();
          const found = await guard(() => manager.discover());
          if (!disposed && ['candidate', 'ambiguous'].includes(found.status) && Array.isArray(found.folders))
            candidates = new Set(found.folders.map(folder => folder.folderId));
          return found;
        },
        /**
         * Сверяет точный root-отпечаток только в наблюдавшейся папке. Код должен
         * поступить независимо; булево подтверждение — не доказательство канала.
         * Совпадение не проверяет GCM, полноту/актуальность облака и не закрепляет
         * выбор. Несколько папок могут содержать одну и ту же корневую версию.
         * @param {{folderId:string,pairingCode:string,independentPinConfirmed:boolean}} args
         */
        async probeRoot(args) {
          let checked, pairing;
          try {
            checked = object(args, ['folderId', 'pairingCode', 'independentPinConfirmed']);
            if (!validGoogleId(checked.folderId) || checked.independentPinConfirmed !== true) throw failed();
            pairing = parsePairingCode(checked.pairingCode);
          } catch {
            throw failed();
          }
          if (!candidates.has(checked.folderId)) return status('candidate_unavailable');
          return guard(async () => {
            const reader = createAuthenticatedCloudSession({
              provider: 'google',
              clientId,
              accountKey,
              datasetId: pairing.datasetId,
              folderId: checked.folderId,
              accessToken: token,
              fetchImpl: diskFetch,
              timeoutMs,
              ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
            });
            const found = await reader.read(pairing.rootPin.versionId);
            if (found.status === 'account_mismatch' || found.status === 'account_unavailable')
              return status(found.status);
            if (found.status === 'not_found') return status('root_not_found');
            if (found.status !== 'found') return status('unavailable');
            const pin = await historyEnvelopePin({
              envelope: found.envelope,
              expectedDatasetId: pairing.datasetId,
              ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
            });
            if (disposed || (await read()) !== raw || now() + EXPIRY_MARGIN_MS >= expiresAt)
              return status('account_unavailable');
            if (pin.versionId !== pairing.rootPin.versionId || pin.sha256 !== pairing.rootPin.sha256)
              return status('root_mismatch');
            return Object.freeze({ status: 'matched_root', folderId: checked.folderId });
          });
        },
        dispose() {
          disposed = true;
          candidates.clear();
        }
      });
      return Object.freeze({ status: 'opened', session });
    }
    const base = createAuthenticatedCloudSession({
      provider,
      clientId,
      accountKey,
      datasetId,
      accessToken: token,
      retireNative: createNativeVersionRetirement({
        provider,
        invoke: input.invoke,
        accessToken: token,
        datasetId,
        folderId: input.folderId
      }),
      fetchImpl: diskFetch,
      // Native HTTP is bounded to 60s. Let its safe failure code arrive first.
      timeoutMs: input.timeoutMs ?? 70_000,
      ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {}),
      ...(provider === 'google' ? { folderId: input.folderId } : {})
    });
    const session = Object.freeze({
      previewAccountLabel,
      checkAccount() {
        return guard(() => base.checkAccount());
      },
      generateFileId() {
        return guard(() => base.generateFileId());
      },
      upload(args) {
        return guard(() => base.upload(args), true);
      },
      verify(args) {
        return guard(() => base.verify(args));
      },
      listWithDates() {
        return guard(() => base.listWithDates());
      },
      read(versionId) {
        return guard(() => base.read(versionId));
      },
      trashVersion(args) {
        return guard(() => base.trashVersion(args), true);
      },
      dispose() {
        disposed = true;
      }
    });
    return Object.freeze({ status: 'opened', session });
  } catch {
    return status('credential_unavailable');
  }
}

/**
 * Открывает сессию из ранее сохранённого и сверенного native pin без ручного
 * ввода accountKey/slotId. Набор и Google folder ID должны быть отдельно доверены;
 * этот метод не создаёт ключи, не ищет папку и не подключён к настройкам.
 * Отсутствие привязки не означает, что можно автоматически создать новую.
 * @param {{provider:'google'|'yandex',datasetId:string,folderId?:string,
 * invoke:(command:string,args:any)=>Promise<any>,cryptoSource?:Crypto,now?:()=>number,timeoutMs?:number}} options
 */
export async function openStoredNativeCloudSession(options) {
  let input;
  try {
    input = object(options, ['provider', 'datasetId', 'invoke'], ['folderId', 'cryptoSource', 'now', 'timeoutMs']);
    if (
      !['google', 'yandex'].includes(input.provider) ||
      !isSyncId(input.datasetId) ||
      (input.provider === 'google' ? !validGoogleId(input.folderId) : input.folderId !== undefined) ||
      typeof input.invoke !== 'function' ||
      (input.now !== undefined && typeof input.now !== 'function') ||
      (input.timeoutMs !== undefined &&
        (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 20 || input.timeoutMs > 120_000))
    )
      throw failed();
  } catch {
    throw failed();
  }
  try {
    const local = await readNativeCredentialBinding({
      provider: input.provider,
      invoke: input.invoke,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    });
    if (local.status === 'empty') return status('credential_missing');
    if (local.status !== 'ready' || !local.binding) return status('credential_blocked');
    return await openNativeCloudSession({
      ...input,
      ...local.binding
    });
  } catch {
    return status('credential_unavailable');
  }
}

/**
 * Только чтение кандидатов папки для ранее закреплённого Google-аккаунта.
 * Перед открытием обновляет доступ с guarded claim, перед каждым поиском повторно
 * сверяет credential и аккаунт, дважды обходит список. Ни один кандидат не
 * становится доверенным: его ещё нужно проверить по независимому dataset/root pin.
 * Отсутствие папки, совпадение обходов и имя не доказывают первое подключение.
 * probeRoot может сверить корень с кодом, полученным независимо, но ничего не
 * закрепляет. Создавать/выбирать папку этот API не умеет. В UI не подключено.
 * @param {{invoke:(command:string,args:any)=>Promise<any>,cryptoSource?:Crypto,now?:()=>number,timeoutMs?:number}} options
 */
export async function openStoredNativeGoogleFolderDiscovery(options) {
  let input;
  try {
    input = object(options, ['invoke'], ['cryptoSource', 'now', 'timeoutMs']);
    if (
      typeof input.invoke !== 'function' ||
      (input.now !== undefined && typeof input.now !== 'function') ||
      (input.timeoutMs !== undefined &&
        (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 20 || input.timeoutMs > 120_000))
    )
      throw failed();
  } catch {
    throw failed();
  }
  try {
    const local = await readNativeCredentialBinding({
      provider: 'google',
      invoke: input.invoke,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    });
    if (local.status === 'empty') return status('credential_missing');
    if (local.status !== 'ready' || !local.binding) return status('credential_blocked');
    return await openSession({ ...input, provider: 'google', ...local.binding }, true);
  } catch {
    return status('credential_unavailable');
  }
}

/** Dedicated capability for the standalone-file directory. Legacy discovery stays read-only.
 * No root, history, pairing code or dataset binding is created.
 * @param {{invoke:(command:string,args:any)=>Promise<any>,cryptoSource?:Crypto,timeoutMs?:number,now?:()=>number}} options
 * @returns {Promise<{status:string,session?:any}>}
 */
export async function openStoredStandaloneGoogleFolder(options) {
  const input = object(options, ['invoke'], ['cryptoSource', 'timeoutMs', 'now']);
  const local = await readNativeCredentialBinding({ provider: 'google', invoke: input.invoke });
  if (local.status !== 'ready' || !local.binding) return status('credential_missing');
  return openSession({ ...input, provider: 'google', ...local.binding }, true, true);
}
