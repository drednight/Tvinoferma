// @ts-check
// Экспериментальная модель ПЕРВОГО подключения Google и Яндекса вызывается из
// настроек, но проверена только на поддельных данных. Windows-installer ещё не
// подтвердил устойчивость, защиту от отката, работу Tauri и реальных провайдеров.
// Передаваемые записи, аргументы callback и исходные ошибки не должны логироваться.
import { generateSyncId } from '../envelope.js';
import { object } from '../exportSchema.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';
import { copyOAuthAccountLabel } from './oauthAccountLabel.js';
import { prepareGoogleCredentialRecord } from './oauthCredentialRecord.js';
import { prepareYandexCredentialRecord } from './oauthYandexCredentialRecord.js';

const MAX_SECRET_AGE_MS = 60_000;
const INVALID = 'Не удалось подготовить первое подключение облачного диска';
const result = status => Object.freeze({ status });
const BUSY = result('busy');
const SPENT = result('spent');
const CANCELLED = result('cancelled');
const IN_PROGRESS = result('installation_in_progress');
const SCOPE_UNVERIFIED = result('scope_unverified');
const REFRESH_MISSING = result('refresh_missing');
const TOKEN_UNAVAILABLE = result('token_unavailable');
const IDENTITY_UNVERIFIED = result('identity_unverified');
const LABEL_UNAVAILABLE = result('account_label_unavailable');
const ACCOUNT_CHANGED = result('account_changed');
const CONFIRMATION_UNVERIFIED = result('confirmation_unverified');
const DECLINED = result('declined');
const OCCUPIED = result('already_configured');
const INSTALL_UNCERTAIN = result('installation_uncertain');
const INSTALLED_EXPIRED = result('installed_refresh_expired');
const INSTALLED_ACCESS_EXPIRED = result('installed_access_expired');
const INSTALLED = result('installed');

function invalid() {
  return new Error(INVALID);
}

function checkedTimeout(value, fallback) {
  const timeout = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(timeout) || timeout < 20 || timeout > 120_000) throw invalid();
  return timeout;
}

function checkedClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

/**
 * Один явно начатый сценарий ПОСЛЕ обмена кода. tokenResponse — доверенный
 * одноразовый результат oauthTokenTransport для выбранного провайдера/code.
 * Google требует сообщённый scope и новый refresh; Яндекс допускает также
 * request_bound из нашей PKCE-попытки и сохраняет только access token. Проверка
 * работы настоящего провайдера и доказанный безопасный installer пока отсутствуют.
 *
 * previewAccount получает access token, обязан проверить endpoint/TLS и вернуть
 * {accountKey,label}, полученные из одного ответа провайдера; label — email Google,
 * login Яндекса или null. confirmAccount получает только label, НЕ ID или токены. Он обязан показать
 * её целиком безопасным текстом, попросить сравнить с аккаунтом системного браузера
 * и получить явное подтверждение. Нельзя молча принимать подтверждение при null
 * или небезопасной метке. После согласия ID и метка проверяются заново. Метка
 * — не доказательство личности и не защита от подмены отображения; доверенного UI
 * пока нет. Метку нельзя писать в лог, запись учётных данных или облачный файл.
 *
 * installer.installIfAbsent({slotId,clientId,accountKey,record}) должен в одной
 * устойчивой атомарной операции защитить и закрепить pin, ключ и запись, не
 * заменяя ни старую запись, ни данные. Возвращает 'installed' или 'occupied'.
 * installer.verifyInstallation получает тот же чувствительный аргумент и
 * подтверждает чтение; readback не доказывает устойчивости или отсутствия отката.
 * Экспериментальный installer ещё не подтвердил все эти свойства. Его ошибки и
 * потерянный ответ неоднозначны; при неизвестном исходе автоматический повтор
 * запрещён. Отсутствие записи само по себе не подтверждает, что это новое устройство.
 *
 * @param {'google'|'yandex'} provider
 * @param {{clientId:string, tokenResponse:any,
 * previewAccount:(args:{accessToken:string,clientId:string,signal:AbortSignal})=>Promise<{accountKey:string,label:{kind:string,value:string}|null}>,
 * confirmAccount:(args:{provider:'google'|'yandex',clientId:string,label:{kind:string,value:string},signal:AbortSignal})=>Promise<boolean>,
 * installer:{installIfAbsent:(args:any)=>Promise<'installed'|'occupied'>,verifyInstallation:(args:any)=>Promise<boolean>},
 * cryptoSource?:Crypto, now?:()=>number, identityTimeoutMs?:number, confirmationTimeoutMs?:number, installationTimeoutMs?:number}} options
 */
function createEnrollmentAttempt(provider, options) {
  let input;
  let response;
  let summary;
  let installer;
  try {
    input = object(
      options,
      ['clientId', 'tokenResponse', 'previewAccount', 'confirmAccount', 'installer'],
      ['cryptoSource', 'now', 'identityTimeoutMs', 'confirmationTimeoutMs', 'installationTimeoutMs']
    );
    response = object(input.tokenResponse, ['summary', 'takeSecrets', 'discard']);
    summary = object(response.summary, [
      'provider',
      'operation',
      'expiresAt',
      'refreshExpiresAt',
      'refreshAvailable',
      'scope'
    ]);
    installer = object(input.installer, ['installIfAbsent', 'verifyInstallation']);
  } catch {
    throw invalid();
  }
  const crypto = input.cryptoSource === undefined ? globalThis.crypto : input.cryptoSource;
  const clock = input.now === undefined ? () => Date.now() : input.now;
  let identityTimeoutMs;
  let confirmationTimeoutMs;
  let installationTimeoutMs;
  try {
    identityTimeoutMs = checkedTimeout(input.identityTimeoutMs, 30_000);
    confirmationTimeoutMs = checkedTimeout(input.confirmationTimeoutMs, 60_000);
    installationTimeoutMs = checkedTimeout(input.installationTimeoutMs, 30_000);
    if (
      !validOAuthClientId(provider, input.clientId) ||
      summary.provider !== provider ||
      summary.operation !== 'code' ||
      !Number.isSafeInteger(summary.expiresAt) ||
      summary.expiresAt <= 0 ||
      !(
        summary.refreshExpiresAt === null ||
        (Number.isSafeInteger(summary.refreshExpiresAt) && summary.refreshExpiresAt > 0)
      ) ||
      typeof summary.refreshAvailable !== 'boolean' ||
      (provider === 'yandex' && summary.refreshExpiresAt !== null) ||
      !['reported', 'unverified', ...(provider === 'yandex' ? ['request_bound'] : [])].includes(summary.scope) ||
      typeof response.takeSecrets !== 'function' ||
      typeof response.discard !== 'function' ||
      typeof input.previewAccount !== 'function' ||
      typeof input.confirmAccount !== 'function' ||
      typeof installer.installIfAbsent !== 'function' ||
      typeof installer.verifyInstallation !== 'function' ||
      typeof clock !== 'function' ||
      !crypto?.subtle ||
      typeof crypto.getRandomValues !== 'function'
    )
      throw invalid();
  } catch {
    throw invalid();
  }

  // Ссылки и неподвижные данные фиксируются до любого ожидания.
  const { clientId, previewAccount, confirmAccount } = input;
  const takeSecrets = response.takeSecrets;
  const discard = response.discard;
  const installIfAbsent = installer.installIfAbsent;
  const verifyInstallation = installer.verifyInstallation;
  let phase = 'ready';
  let cancelled = false;
  let activeAbort = null;
  let lastTime = null;
  const now = () => {
    const current = checkedClock(clock);
    if (lastTime !== null && current < lastTime) throw invalid();
    lastTime = current;
    return current;
  };
  const dropLease = () => {
    try {
      discard();
    } catch {
      /* неизвестная реализация не раскрывает детали */
    }
  };

  // Отмена/таймаут возвращают управление даже при недобросовестном callback.
  // Вызванный callback может продолжить работу, поэтому он полностью доверенный.
  async function cancellableStage(work, timeout) {
    const controller = new AbortController();
    let rejectCancel;
    let timer;
    const cancelledPromise = new Promise((_, reject) => {
      rejectCancel = reject;
    });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(invalid());
      }, timeout);
    });
    void cancelledPromise.catch(() => {});
    activeAbort = () => {
      controller.abort();
      rejectCancel(invalid());
    };
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (cancelled) throw invalid();
          return work(controller.signal);
        }),
        cancelledPromise,
        deadline
      ]);
    } finally {
      activeAbort = null;
      clearTimeout(timer);
    }
  }

  // Операцию установки нельзя объявлять отменённой после её начала: таймаут
  // означает неизвестный исход, а поздний доверенный backend может ещё завершиться.
  async function installationStage(work) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(invalid()), installationTimeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(work), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    cancel() {
      if (phase === 'ready') {
        phase = 'cancelled';
        cancelled = true;
        dropLease();
        return CANCELLED;
      }
      if (phase === 'checking' || phase === 'confirming') {
        cancelled = true;
        activeAbort?.();
        return CANCELLED;
      }
      if (phase === 'installing' || phase === 'verifying_installation') return IN_PROGRESS;
      return phase === 'cancelled' ? CANCELLED : SPENT;
    },

    async complete() {
      if (phase === 'cancelled') return CANCELLED;
      if (phase !== 'ready') return phase === 'finished' ? SPENT : BUSY;
      phase = 'checking';
      let secrets;
      try {
        if (summary.scope !== 'reported' && !(provider === 'yandex' && summary.scope === 'request_bound')) {
          dropLease();
          return SCOPE_UNVERIFIED;
        }
        if (provider === 'google' && !summary.refreshAvailable) {
          dropLease();
          return REFRESH_MISSING;
        }
        let capturedAt;
        try {
          secrets = object(takeSecrets(), ['accessToken', 'refreshToken']);
          capturedAt = now();
          if (
            typeof secrets.accessToken !== 'string' ||
            !/^[A-Za-z0-9._~+/-]+=*$/.test(secrets.accessToken) ||
            secrets.accessToken.length > 8192 ||
            (summary.refreshAvailable
              ? typeof secrets.refreshToken !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(secrets.refreshToken)
              : secrets.refreshToken !== null) ||
            capturedAt >= summary.expiresAt ||
            (summary.refreshExpiresAt !== null && capturedAt >= summary.refreshExpiresAt)
          )
            throw invalid();
        } catch {
          dropLease();
          return TOKEN_UNAVAILABLE;
        }
        const remaining = () => {
          const current = now();
          const limits = [MAX_SECRET_AGE_MS - (current - capturedAt), summary.expiresAt - current];
          if (summary.refreshExpiresAt !== null) limits.push(summary.refreshExpiresAt - current);
          const left = Math.min(...limits);
          if (current < capturedAt || left <= 0) throw invalid();
          return left;
        };
        const identify = async () => {
          const time = Math.min(identityTimeoutMs, remaining());
          const reply = await cancellableStage(
            signal => previewAccount(Object.freeze({ accessToken: secrets.accessToken, clientId, signal })),
            time
          );
          const identity = object(reply, ['accountKey', 'label']);
          if (!validOAuthAccountKey(identity.accountKey)) throw invalid();
          const label = copyOAuthAccountLabel(provider, identity.label);
          remaining();
          return Object.freeze({ accountKey: identity.accountKey, label });
        };
        let identity;
        try {
          identity = await identify();
        } catch {
          return cancelled ? CANCELLED : IDENTITY_UNVERIFIED;
        }
        if (cancelled) return CANCELLED;
        if (identity.label === null) return LABEL_UNAVAILABLE;
        const { accountKey, label } = identity;
        phase = 'confirming';
        let approval;
        try {
          approval = await cancellableStage(
            signal => confirmAccount(Object.freeze({ provider, clientId, label, signal })),
            Math.min(confirmationTimeoutMs, remaining())
          );
          remaining();
        } catch {
          return cancelled ? CANCELLED : CONFIRMATION_UNVERIFIED;
        }
        if (cancelled) return CANCELLED;
        if (approval === false) return DECLINED;
        if (approval !== true) return CONFIRMATION_UNVERIFIED;
        phase = 'checking';
        let rechecked;
        try {
          rechecked = await identify();
        } catch {
          return cancelled ? CANCELLED : IDENTITY_UNVERIFIED;
        }
        if (cancelled) return CANCELLED;
        if (
          rechecked.accountKey !== accountKey ||
          rechecked.label?.kind !== label.kind ||
          rechecked.label?.value !== label.value
        )
          return ACCOUNT_CHANGED;
        let installation;
        try {
          remaining();
          const slotId = generateSyncId(crypto);
          const revision = generateSyncId(crypto);
          if (slotId === revision) throw invalid();
          const record =
            provider === 'google'
              ? prepareGoogleCredentialRecord({
                  slotId,
                  clientId,
                  accountKey,
                  revision,
                  refreshToken: secrets.refreshToken,
                  refreshExpiresAt: summary.refreshExpiresAt
                })
              : prepareYandexCredentialRecord({
                  slotId,
                  clientId,
                  accountKey,
                  revision,
                  accessToken: secrets.accessToken,
                  expiresAt: summary.expiresAt
                });
          installation = Object.freeze({ slotId, clientId, accountKey, record });
        } catch {
          return TOKEN_UNAVAILABLE;
        }
        if (cancelled) return CANCELLED;
        try {
          remaining();
        } catch {
          return TOKEN_UNAVAILABLE;
        }
        phase = 'installing';
        let installed;
        try {
          installed = await installationStage(() => installIfAbsent(installation));
        } catch {
          return INSTALL_UNCERTAIN;
        }
        if (installed === 'occupied') return OCCUPIED;
        if (installed !== 'installed') return INSTALL_UNCERTAIN;
        phase = 'verifying_installation';
        try {
          if ((await installationStage(() => verifyInstallation(installation))) !== true) return INSTALL_UNCERTAIN;
          const after = now();
          if (provider === 'yandex' && after >= summary.expiresAt) return INSTALLED_ACCESS_EXPIRED;
          if (summary.refreshExpiresAt !== null && after >= summary.refreshExpiresAt) return INSTALLED_EXPIRED;
        } catch {
          return INSTALL_UNCERTAIN;
        }
        // Токен не возвращается в результат: установка ещё не проверяет
        // существующие облачные данные и не разрешает их изменение.
        return INSTALLED;
      } finally {
        secrets = null;
        if (phase !== 'cancelled') phase = cancelled ? 'cancelled' : 'finished';
      }
    }
  });
}

/** @param {Parameters<typeof createEnrollmentAttempt>[1]} options */
export function createGoogleEnrollmentAttempt(options) {
  return createEnrollmentAttempt('google', options);
}

/** @param {Parameters<typeof createEnrollmentAttempt>[1]} options */
export function createYandexEnrollmentAttempt(options) {
  return createEnrollmentAttempt('yandex', options);
}
