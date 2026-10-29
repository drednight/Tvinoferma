// @ts-check
// Отключённая модель согласования обновления Google OAuth. Экспериментальный
// Windows-store и первое подключение не подтвердили устойчивость или защиту от
// отката. НЕ использовать с реальными токенами и не подменять store на localStorage.
// Контракт атомарного, устойчивого и защищённого store и доверенного verifyAccount
// описан в docs/CLOUD-SYNC.md; все строки записей и ошибки адаптеров чувствительны.
import { generateSyncId } from '../envelope.js';
import { object } from '../exportSchema.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';
import {
  parseGoogleCredentialRecord as parseRecord,
  serializeGoogleCredentialRecord as serializeRecord,
  validCredentialId as validId
} from './oauthCredentialRecord.js';
import { createCloudOAuthTokenTransport, createGoogleRefreshRequest } from './oauthTokenTransport.js';

const LEASE_MS = 60 * 1000;
const INVALID = 'Некорректная конфигурация обновления доступа к диску';
const EXPIRED = 'Данные доступа больше недоступны';

const result = status => Object.freeze({ status });
// Отсутствие записи при уже переданном pin может означать потерю хранилища,
// а не новое устройство: автоматически создавать подключение нельзя.
const MISSING = result('blocked_missing');
const DAMAGED = result('blocked_record');
const WRONG_CONNECTION = result('blocked_binding');
const PENDING = result('blocked_pending');
const UNAVAILABLE = result('store_unavailable');
const BUSY = result('busy');
const BLOCKED = result('blocked_in_session');
const CHANGED = result('changed');
const EXPIRED_REFRESH = result('refresh_expired');
const BEGIN_UNCERTAIN = result('begin_uncertain');
const EXCHANGE_UNCERTAIN = result('exchange_uncertain');
const SCOPE_UNVERIFIED = result('scope_unverified');
const IDENTITY_UNVERIFIED = result('identity_unverified');
const ACCOUNT_CHANGED = result('account_changed');
const FINISH_UNCERTAIN = result('finish_uncertain');
const ACCESS_EXPIRED = result('refreshed_access_expired');

function invalid() {
  return new Error(INVALID);
}
function nowValue(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}
function accessLease(token, expiresAt, capturedAt, createdAt, now) {
  let secret = token;
  const clear = () => {
    secret = null;
    clearTimeout(timer);
  };
  const remaining = Math.max(0, Math.min(LEASE_MS - (createdAt - capturedAt), expiresAt - createdAt));
  const timer = setTimeout(clear, remaining);
  return Object.freeze({
    summary: Object.freeze({ provider: 'google', expiresAt }),
    takeAccessToken() {
      let current;
      try {
        current = nowValue(now);
      } catch {
        clear();
        throw new Error(EXPIRED);
      }
      if (!secret || current < capturedAt || current - capturedAt >= LEASE_MS || current >= expiresAt) {
        clear();
        throw new Error(EXPIRED);
      }
      const value = secret;
      clear();
      return value;
    },
    discard() {
      clear();
    }
  });
}

async function verifyWithinDeadline(verifyAccount, accessToken, clientId, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(invalid());
      }, timeoutMs);
    });
    const reply = await Promise.race([
      Promise.resolve().then(() => verifyAccount(Object.freeze({ accessToken, clientId, signal: controller.signal }))),
      deadline
    ]);
    const identity = object(reply, ['accountKey']);
    if (!validOAuthAccountKey(identity.accountKey)) throw invalid();
    return identity.accountKey;
  } catch {
    controller.abort();
    throw invalid();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Готовит координатор ДЛЯ ЭКСПЕРИМЕНТА, не подключённый к приложению.
 * store — одна уже инициализированная защищённая запись, НЕ Web Storage:
 * read() -> точная строка/null; compareExchange(expected,next) -> 'swapped' или
 * 'mismatch'. Вся замена должна быть атомарной между всеми процессами и устойчивой
 * до ответа; чтение обязано возвращать актуальную запись. Модуль не проверяет эти
 * свойства, подлинность записи, откат или работу keyring. Неизвестный исход write
 * не позволяет утверждать, что прежняя запись осталась. Методы нельзя логировать.
 *
 * slotId и accountKey должны быть независимо и надёжно закреплены, а первый доступ
 * и учётная запись — ранее проверены пользователем. verifyAccount — доверенная
 * проверка аккаунта новым access token: она получает секрет, возвращает только
 * {accountKey} и должна соблюдать signal, TLS и конфиденциальность. Ни она, ни
 * первоначальная установка, хранение pin, смена аккаунта или восстановление здесь
 * не реализованы. reported scope не является независимой проверкой разрешений.
 *
 * @param {{slotId:string, clientId:string, accountKey:string,
 * store:{read:()=>Promise<string|null>, compareExchange:(expected:string,next:string)=>Promise<'swapped'|'mismatch'>},
 * fetchImpl:typeof fetch, verifyAccount:(arg:{accessToken:string,clientId:string,signal:AbortSignal})=>Promise<{accountKey:string}>,
 * cryptoSource?:Crypto, now?:()=>number, timeoutMs?:number, identityTimeoutMs?:number}} options
 */
export function createGoogleCredentialRotation(options) {
  let input;
  let store;
  try {
    input = object(
      options,
      ['slotId', 'clientId', 'accountKey', 'store', 'fetchImpl', 'verifyAccount'],
      ['cryptoSource', 'now', 'timeoutMs', 'identityTimeoutMs']
    );
    store = object(input.store, ['read', 'compareExchange']);
  } catch {
    throw invalid();
  }
  const crypto = input.cryptoSource === undefined ? globalThis.crypto : input.cryptoSource;
  const clock = input.now === undefined ? () => Date.now() : input.now;
  const timeoutMs = input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  const identityTimeoutMs = input.identityTimeoutMs === undefined ? 30000 : input.identityTimeoutMs;
  if (
    !validId(input.slotId) ||
    !validOAuthClientId('google', input.clientId) ||
    !validOAuthAccountKey(input.accountKey) ||
    typeof store.read !== 'function' ||
    typeof store.compareExchange !== 'function' ||
    typeof input.fetchImpl !== 'function' ||
    typeof input.verifyAccount !== 'function' ||
    typeof clock !== 'function' ||
    !crypto?.subtle ||
    typeof crypto.getRandomValues !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 20 ||
    timeoutMs > 120000 ||
    !Number.isSafeInteger(identityTimeoutMs) ||
    identityTimeoutMs < 20 ||
    identityTimeoutMs > 120000
  )
    throw invalid();
  // В одном экземпляре сдвиг часов назад не должен продлевать срок токена.
  // Между запусками защищённого источника времени здесь нет.
  let lastTime = null;
  const now = () => {
    const current = nowValue(clock);
    if (lastTime !== null && current < lastTime) throw invalid();
    lastTime = current;
    return current;
  };
  // Фиксируем методы и привязку до асинхронной работы; сам store всё равно доверенный.
  const read = store.read;
  const compareExchange = store.compareExchange;
  const { slotId, clientId, accountKey, fetchImpl, verifyAccount } = input;
  let running = false;
  let blocked = false;

  async function readCurrent() {
    let raw;
    try {
      raw = await read();
    } catch {
      return { outcome: UNAVAILABLE };
    }
    if (raw === null) return { outcome: MISSING };
    let record;
    try {
      record = parseRecord(raw);
    } catch {
      return { outcome: DAMAGED };
    }
    if (record.slotId !== slotId || record.clientId !== clientId || record.accountKey !== accountKey) {
      return { outcome: WRONG_CONNECTION };
    }
    if (record.phase === 'pending') return { outcome: PENDING };
    return { raw, record };
  }

  return Object.freeze({
    async inspect() {
      if (blocked) return BLOCKED;
      if (running) return BUSY;
      const current = await readCurrent();
      if (blocked) return BLOCKED;
      if (running) return BUSY;
      if (current.outcome) return current.outcome;
      try {
        if (current.record.refreshExpiresAt !== null && nowValue(now) >= current.record.refreshExpiresAt)
          return EXPIRED_REFRESH;
      } catch {
        return UNAVAILABLE;
      }
      // Случайная ревизия — не токен и не подтверждение аккаунта. Она нужна,
      // чтобы старый наблюдатель не начал второй refresh после успешного первого.
      return Object.freeze({ status: 'ready', revision: current.record.revision });
    },

    /** @param {{expectedRevision:string}} options */
    async refresh(options) {
      let argument;
      try {
        argument = object(options, ['expectedRevision']);
      } catch {
        throw invalid();
      }
      if (!validId(argument.expectedRevision)) throw invalid();
      if (blocked) return BLOCKED;
      if (running) return BUSY;
      running = true;
      try {
        const current = await readCurrent();
        if (current.outcome) return current.outcome;
        const { raw, record } = current;
        if (record.revision !== argument.expectedRevision) return CHANGED;
        let before;
        let pendingRevision;
        let attemptId;
        let nextRevision;
        let request;
        let transport;
        try {
          before = nowValue(now);
          if (record.refreshExpiresAt !== null && before >= record.refreshExpiresAt) return EXPIRED_REFRESH;
          pendingRevision = generateSyncId(crypto);
          attemptId = generateSyncId(crypto);
          nextRevision = generateSyncId(crypto);
          if (new Set([slotId, record.revision, pendingRevision, attemptId, nextRevision]).size !== 5) throw invalid();
          request = createGoogleRefreshRequest({ clientId, refreshToken: record.refreshToken });
          transport = createCloudOAuthTokenTransport({
            provider: 'google',
            clientId,
            operation: 'refresh',
            fetchImpl,
            timeoutMs,
            now
          });
        } catch {
          return UNAVAILABLE;
        }
        const pendingRaw = serializeRecord({
          ...record,
          revision: pendingRevision,
          phase: 'pending',
          attemptId,
          refreshToken: null,
          refreshExpiresAt: null
        });
        try {
          const written = await compareExchange(raw, pendingRaw);
          if (written === 'mismatch') return CHANGED;
          if (written !== 'swapped' || (await read()) !== pendingRaw) throw invalid();
        } catch {
          blocked = true;
          return BEGIN_UNCERTAIN;
        }
        // До POST удалённый из записи старый refresh живёт лишь в памяти этой
        // попытки. После перезапуска pending нельзя автоматически повторить.
        try {
          const currentTime = nowValue(now);
          if (currentTime < before || (record.refreshExpiresAt !== null && currentTime >= record.refreshExpiresAt)) {
            blocked = true;
            return EXCHANGE_UNCERTAIN;
          }
        } catch {
          blocked = true;
          return EXCHANGE_UNCERTAIN;
        }
        let response;
        try {
          response = await transport.send(request);
        } catch {
          blocked = true;
          return EXCHANGE_UNCERTAIN;
        }
        if (response.summary.scope !== 'reported') {
          response.discard();
          blocked = true;
          return SCOPE_UNVERIFIED;
        }
        let secrets;
        let capturedAt;
        try {
          secrets = response.takeSecrets();
          capturedAt = nowValue(now);
        } catch {
          response.discard();
          blocked = true;
          return EXCHANGE_UNCERTAIN;
        }
        let identified;
        try {
          if (capturedAt < before || capturedAt >= response.summary.expiresAt) throw invalid();
          const verifyTimeout = Math.min(identityTimeoutMs, LEASE_MS, response.summary.expiresAt - capturedAt);
          identified = await verifyWithinDeadline(verifyAccount, secrets.accessToken, clientId, verifyTimeout);
        } catch {
          blocked = true;
          return IDENTITY_UNVERIFIED;
        }
        if (identified !== accountKey) {
          blocked = true;
          return ACCOUNT_CHANGED;
        }
        // При подтверждённом ответе без нового refresh сохраняем именно старый
        // и его прежний срок. При новом — только новый и его срок, если указан.
        const rotated = secrets.refreshToken !== null;
        const nextRefreshExpiresAt = rotated ? response.summary.refreshExpiresAt : record.refreshExpiresAt;
        try {
          const afterIdentity = nowValue(now);
          if (
            afterIdentity < capturedAt ||
            afterIdentity - capturedAt >= LEASE_MS ||
            afterIdentity >= response.summary.expiresAt ||
            (nextRefreshExpiresAt !== null && afterIdentity >= nextRefreshExpiresAt)
          ) {
            blocked = true;
            return IDENTITY_UNVERIFIED;
          }
        } catch {
          blocked = true;
          return IDENTITY_UNVERIFIED;
        }
        const nextRaw = serializeRecord({
          ...record,
          revision: nextRevision,
          phase: 'ready',
          attemptId: null,
          refreshToken: rotated ? secrets.refreshToken : record.refreshToken,
          refreshExpiresAt: nextRefreshExpiresAt
        });
        try {
          const written = await compareExchange(pendingRaw, nextRaw);
          if (written !== 'swapped' || (await read()) !== nextRaw) throw invalid();
        } catch {
          blocked = true;
          return FINISH_UNCERTAIN;
        }
        let afterSave;
        try {
          afterSave = nowValue(now);
          if (nextRefreshExpiresAt !== null && afterSave >= nextRefreshExpiresAt) return EXPIRED_REFRESH;
          if (afterSave < capturedAt || afterSave - capturedAt >= LEASE_MS || afterSave >= response.summary.expiresAt) {
            return ACCESS_EXPIRED;
          }
        } catch {
          return ACCESS_EXPIRED;
        }
        return Object.freeze({
          status: 'refreshed',
          access: accessLease(secrets.accessToken, response.summary.expiresAt, capturedAt, afterSave, now)
        });
      } finally {
        running = false;
      }
    }
  });
}
