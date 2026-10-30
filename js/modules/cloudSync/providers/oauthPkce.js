// @ts-check
// Desktop OAuth: системный браузер, PKCE S256 и ограниченный локальный callback.
// Используется разовой диагностикой и экспериментальным первым входом; сам по
// себе не сохраняет токены. Реальные серверы и Tauri/Windows ещё не испытаны;
// права и устойчивость хранения не подтверждены. Секреты не передаются в ошибки.
import { object } from '../exportSchema.js';
import { OAUTH_CALLBACK_PATH, OAUTH_PROVIDERS, YANDEX_OAUTH_CALLBACK_PORT, validOAuthClientId } from './oauthCommon.js';

const MAX_ATTEMPT_MS = 5 * 60 * 1000;
const GENERIC = 'Не удалось подготовить авторизацию облачного диска';
const BAD_REPLY = 'Не удалось безопасно проверить ответ авторизации';
const CANCEL_UNKNOWN = 'Отмена локального ожидания не подтверждена; оно завершится по истечении срока';
const UNKNOWN_EXCHANGE = 'Результат обмена кода не подтверждён; начните авторизацию заново';

// Только объект запроса, созданный этой завершённой PKCE-попыткой, может служить
// свидетельством запрошенного права. Копия объекта и произвольный запрос им не
// являются. Это проверка связывания внутри одного доверенного JS-контекста, не
// проверка настоящего OAuth-сервера, браузера или условий регистрации.
const yandexCodeRequests = new WeakMap();

/** Используется транспортом один раз; вызывающий код и оба модуля должны быть доверенными. */
export function consumeYandexCodeScopeBinding(request, clientId) {
  const binding = yandexCodeRequests.get(request);
  if (!binding || binding.clientId !== clientId) return false;
  yandexCodeRequests.delete(request);
  return true;
}

function invalid() {
  return new Error(GENERIC);
}

function cryptoApi(source) {
  const crypto = source || globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.getRandomValues !== 'function') throw invalid();
  return crypto;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function randomNonce(crypto) {
  const bytes = new Uint8Array(32);
  try {
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** RFC 7636 S256; verifier не пишется в URL авторизации или в журнал. */
export async function pkceChallenge(verifier, cryptoSource) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw invalid();
  const bytes = new TextEncoder().encode(verifier);
  try {
    const digest = await cryptoApi(cryptoSource).subtle.digest('SHA-256', bytes);
    if (digest.byteLength !== 32) throw invalid();
    const result = new Uint8Array(digest);
    try {
      return base64url(result);
    } finally {
      result.fill(0);
    }
  } catch {
    throw invalid();
  } finally {
    bytes.fill(0);
  }
}

function validatedOptions(options) {
  let input;
  try {
    input = object(
      options,
      ['provider', 'clientId', 'invoke', 'openBrowser'],
      ['port', 'cryptoSource', 'now', 'requestOffline', 'forceConsent']
    );
  } catch {
    throw invalid();
  }
  if (typeof input.provider !== 'string' || !Object.hasOwn(OAUTH_PROVIDERS, input.provider)) throw invalid();
  if (
    !validOAuthClientId(input.provider, input.clientId) ||
    typeof input.invoke !== 'function' ||
    typeof input.openBrowser !== 'function' ||
    (input.now !== undefined && typeof input.now !== 'function') ||
    (input.requestOffline !== undefined && typeof input.requestOffline !== 'boolean') ||
    (input.forceConsent !== undefined && typeof input.forceConsent !== 'boolean') ||
    (input.forceConsent === true && (input.provider !== 'google' || input.requestOffline === false))
  ) {
    throw invalid();
  }
  const port = input.port === undefined ? (input.provider === 'yandex' ? YANDEX_OAUTH_CALLBACK_PORT : 0) : input.port;
  if (
    !Number.isSafeInteger(port) ||
    (input.provider === 'google' && port !== 0) ||
    (input.provider === 'yandex' && (port < 1024 || port > 65535))
  ) {
    throw invalid();
  }
  return { ...input, port };
}

function readStart(value, provider, requestedPort) {
  let reply;
  try {
    reply = object(value, ['port']);
  } catch {
    throw invalid();
  }
  if (
    !Number.isSafeInteger(reply.port) ||
    reply.port < 1024 ||
    reply.port > 65535 ||
    (provider === 'yandex' && reply.port !== requestedPort)
  ) {
    throw invalid();
  }
  return reply.port;
}

function readPoll(value) {
  let reply;
  try {
    reply = object(value, ['status'], ['code']);
  } catch {
    throw new Error(BAD_REPLY);
  }
  const statuses = ['pending', 'code', 'denied', 'error', 'expired', 'cancelled', 'consumed'];
  if (!statuses.includes(reply.status)) throw new Error(BAD_REPLY);
  if (reply.status === 'code') {
    if (typeof reply.code !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(reply.code)) throw new Error(BAD_REPLY);
  } else if (Object.hasOwn(reply, 'code')) throw new Error(BAD_REPLY);
  return reply;
}

function authorizeUrl(provider, clientId, redirectUri, challenge, state, requestOffline, forceConsent) {
  const config = OAUTH_PROVIDERS[provider];
  const url = new URL(config.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // В диагностике не запрашиваем долговременный refresh token Google. Яндекс
  // всё равно может выдать его; диагностический код отбрасывает оба токена.
  if (provider === 'google' && requestOffline) url.searchParams.set('access_type', 'offline');
  // При новом явном подключении повторное согласие может понадобиться, чтобы
  // Google снова выдал refresh token после диагностического входа. Это просьба,
  // а не гарантия выдачи; модуль установки проверяет сам ответ.
  if (provider === 'google' && forceConsent) url.searchParams.set('prompt', 'consent');
  return url.toString();
}

function tokenRequest(provider, clientId, redirectUri, verifier, code) {
  const fields = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier
  });
  // Google требует идентичный redirect_uri. В документированном запросе Яндекса
  // этого параметра нет; пригодность конкретной регистрации ещё нужно проверить.
  if (provider === 'google') fields.set('redirect_uri', redirectUri);
  const request = Object.freeze({
    method: 'POST',
    url: OAUTH_PROVIDERS[provider].token,
    headers: Object.freeze({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }),
    redirect: 'error',
    body: fields.toString()
  });
  // authorizeUrl выше запросил ровно cloud_api:disk.app_folder как обязательное
  // право без optional_scope. PKCE связывает обмен с этой попыткой; сохранение
  // свидетельства по идентичности объекта не позволяет случайно приписать его
  // скопированному запросу или коду другого клиента.
  if (provider === 'yandex') yandexCodeRequests.set(request, { clientId });
  return request;
}

/**
 * Одна попытка для доверенного вызывающего кода: диагностики и первого входа.
 * invoke и openBrowser передаются явно: сам модуль не подключается к Tauri или сети.
 * Код и verifier удерживаются в замыкании; JavaScript не гарантирует стирания строк.
 * exchange принимает только доверенный транспорт, который обязан повторно проверить
 * адрес, TLS/redirect, размер и ответ. Постоянный вход дополнительно требует проверки
 * выданных прав и защищённого хранения токена, которых эта функция не обеспечивает.
 * Не повторяем обмен автоматически после неоднозначной ошибки.
 * @param {{provider: 'google'|'yandex', clientId: string, port?: number,
 * invoke: (command: string, args: any) => Promise<any>, openBrowser: (url: string) => Promise<any>,
 * cryptoSource?: Crypto, now?: () => number, requestOffline?: boolean, forceConsent?: boolean}} options
 */
export async function startCloudOAuth(options) {
  const input = validatedOptions(options);
  const crypto = cryptoApi(input.cryptoSource);
  const now = input.now || (() => Date.now());
  let startedAt;
  try {
    startedAt = now();
  } catch {
    throw invalid();
  }
  if (!Number.isFinite(startedAt)) throw invalid();
  let verifier;
  let state;
  let handle;
  try {
    verifier = randomNonce(crypto);
    state = randomNonce(crypto);
    handle = randomNonce(crypto);
  } catch {
    throw invalid();
  }
  if (new Set([verifier, state, handle]).size !== 3) throw invalid();
  const challenge = await pkceChallenge(verifier, crypto);
  let redirectUri;
  let elapsedAtOpen;
  let nativeStarted = false;

  async function cancelNative(currentHandle) {
    try {
      const response = await input.invoke('cloud_oauth_callback_cancel', { handle: currentHandle });
      return response === null || response === undefined;
    } catch {
      return false;
    }
  }

  try {
    // Ошибка/потеря IPC-ответа не доказывает, что локальный приёмник не открылся.
    nativeStarted = true;
    const response = await input.invoke('cloud_oauth_callback_begin', {
      provider: input.provider,
      port: input.port,
      state,
      handle
    });
    const actualPort = readStart(response, input.provider, input.port);
    redirectUri = `http://127.0.0.1:${actualPort}${OAUTH_CALLBACK_PATH}`;
    const beforeOpen = now();
    if (!Number.isFinite(beforeOpen) || beforeOpen < startedAt || beforeOpen - startedAt >= MAX_ATTEMPT_MS)
      throw invalid();
    await input.openBrowser(
      authorizeUrl(
        input.provider,
        input.clientId,
        redirectUri,
        challenge,
        state,
        input.requestOffline !== false,
        input.forceConsent === true
      )
    );
    const afterOpen = now();
    if (!Number.isFinite(afterOpen) || afterOpen < startedAt || afterOpen - startedAt >= MAX_ATTEMPT_MS)
      throw invalid();
    elapsedAtOpen = afterOpen - startedAt;
    state = null;
  } catch {
    if (nativeStarted) await cancelNative(handle);
    verifier = handle = null;
    throw invalid();
  }

  let phase = 'waiting';
  let code = null;
  let timer;
  const clearSecrets = () => {
    verifier = handle = code = null;
    clearTimeout(timer);
  };
  const isExpired = () => {
    try {
      const current = now();
      return !Number.isFinite(current) || current < startedAt || current - startedAt >= MAX_ATTEMPT_MS;
    } catch {
      return true;
    }
  };
  const expireLocally = () => {
    if (!['waiting', 'polling', 'ready'].includes(phase)) return;
    const currentHandle = handle;
    phase = 'expired';
    clearSecrets();
    // Ошибка не содержит код или URI и не меняет локальный запрет на обмен.
    void cancelNative(currentHandle);
  };
  // Таймер отсчитывается с начала попытки, а не с момента открытия браузера.
  // При изменении системных часов каждое действие дополнительно проверяет срок.
  timer = setTimeout(expireLocally, Math.max(0, MAX_ATTEMPT_MS - elapsedAtOpen));

  return Object.freeze({
    async poll() {
      if (isExpired()) expireLocally();
      if (phase === 'ready') return { status: 'code_ready' };
      if (phase === 'polling') throw new Error('Проверка авторизации уже выполняется');
      if (phase !== 'waiting') return { status: phase };
      phase = 'polling';
      const currentHandle = handle;
      let reply;
      try {
        reply = await input.invoke('cloud_oauth_callback_poll', { handle: currentHandle });
        // Отмена или истечение могли произойти во время IPC: код нельзя использовать.
        if (phase !== 'polling') return { status: phase };
        if (isExpired()) {
          expireLocally();
          return { status: 'expired' };
        }
        reply = readPoll(reply);
      } catch {
        if (phase !== 'polling') return { status: phase };
        phase = 'error';
        clearSecrets();
        void cancelNative(currentHandle);
        throw new Error(BAD_REPLY);
      }
      if (reply.status === 'pending') {
        phase = 'waiting';
        return { status: 'pending' };
      }
      if (reply.status === 'code') {
        code = reply.code;
        phase = 'ready';
        return { status: 'code_ready' };
      }
      phase = reply.status === 'consumed' ? 'error' : reply.status;
      clearSecrets();
      return { status: phase };
    },

    async cancel() {
      if (phase === 'exchanging') throw new Error('Обмен кода уже начался; его результат пока неизвестен');
      if (!['waiting', 'polling', 'ready'].includes(phase)) return { status: phase };
      const currentHandle = handle;
      phase = 'cancelled';
      clearSecrets();
      if (!(await cancelNative(currentHandle))) throw new Error(CANCEL_UNKNOWN);
      return { status: 'cancelled' };
    },

    async exchange(transport) {
      if (isExpired()) expireLocally();
      if (phase !== 'ready' || typeof transport !== 'function') throw new Error('Нет кода для безопасного обмена');
      const request = tokenRequest(input.provider, input.clientId, redirectUri, verifier, code);
      phase = 'exchanging';
      clearSecrets();
      try {
        const response = await transport(request);
        phase = 'consumed';
        return response;
      } catch {
        phase = 'error';
        throw new Error(UNKNOWN_EXCHANGE);
      }
    }
  });
}
