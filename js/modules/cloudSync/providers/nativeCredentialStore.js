// @ts-check
// Экспериментальный мост к локальному Windows Credential Manager. Сценарий
// первого доступа вызывается из UI, но настоящие сборки, провайдеры и безопасное
// восстановление после сбоев не проверены. Никакого localStorage/fallback.
// Записи, аргументы IPC и исходные ошибки содержат секреты: не журналировать.
import { object } from '../exportSchema.js';
import { validOAuthAccountKey, validOAuthClientId } from './oauthCommon.js';
import { parseGoogleCredentialRecord, validCredentialId } from './oauthCredentialRecord.js';
import { parseYandexCredentialRecord } from './oauthYandexCredentialRecord.js';

const ERROR = 'Не удалось безопасно обработать локальное подключение к облаку';
function failed() {
  return new Error(ERROR);
}

function argumentsFor(provider, value) {
  const input = object(value, ['slotId', 'clientId', 'accountKey', 'record']);
  if (
    !validCredentialId(input.slotId) ||
    !validOAuthClientId(provider, input.clientId) ||
    !validOAuthAccountKey(input.accountKey)
  )
    throw failed();
  const parsed =
    provider === 'google' ? parseGoogleCredentialRecord(input.record) : parseYandexCredentialRecord(input.record);
  if (parsed.slotId !== input.slotId || parsed.clientId !== input.clientId || parsed.accountKey !== input.accountKey)
    throw failed();
  return { slotId: input.slotId, clientId: input.clientId, accountKey: input.accountKey, record: input.record, parsed };
}

function validProvider(provider) {
  return provider === 'google' || provider === 'yandex';
}

function response(value, statuses) {
  const reply = object(value, ['status'], ['slotId', 'record']);
  if (!statuses.includes(reply.status)) throw failed();
  if (reply.status === 'ready') {
    if (!Object.hasOwn(reply, 'slotId') || !Object.hasOwn(reply, 'record')) throw failed();
  } else if (Object.hasOwn(reply, 'slotId') || Object.hasOwn(reply, 'record')) throw failed();
  return reply;
}

function timeoutOf(value) {
  const timeout = value === undefined ? 25_000 : value;
  if (!Number.isSafeInteger(timeout) || timeout < 20 || timeout > 120_000) throw failed();
  return timeout;
}

async function callWithin(invoke, command, args, timeoutMs) {
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

function transition(before, after) {
  if (
    before.slotId !== after.slotId ||
    before.clientId !== after.clientId ||
    before.accountKey !== after.accountKey ||
    before.revision === after.revision
  )
    return false;
  return (
    (before.phase === 'ready' && after.phase === 'pending' && after.attemptId !== before.revision) ||
    (before.phase === 'pending' && after.phase === 'ready' && before.attemptId !== after.revision)
  );
}

/**
 * Только проверка локального состояния без возврата записи или токенов. `empty`
 * не доказывает, что подключения никогда не было; `configured` не подтверждает
 * действительность OAuth или видимость облака. Ошибка не считается отсутствием.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,timeoutMs?:number}} options
 */
export async function inspectNativeCredential(options) {
  try {
    const input = object(options, ['provider', 'invoke'], ['timeoutMs']);
    if (!validProvider(input.provider) || typeof input.invoke !== 'function') throw failed();
    const reply = response(
      await callWithin(input.invoke, 'cloud_credential_read', { provider: input.provider }, timeoutOf(input.timeoutMs)),
      ['empty', 'ready', 'blocked']
    );
    if (reply.status !== 'ready') return Object.freeze({ status: reply.status });
    const record =
      input.provider === 'google'
        ? parseGoogleCredentialRecord(reply.record)
        : parseYandexCredentialRecord(reply.record);
    if (reply.slotId !== record.slotId) return Object.freeze({ status: 'blocked' });
    return Object.freeze({ status: record.phase === 'pending' ? 'pending' : 'configured' });
  } catch {
    throw failed();
  }
}

/**
 * Читает только локальный pin, сверенный native с записью OAuth; токен не
 * возвращается. Сам pin не доказывает отсутствия совместного отката или живого
 * доступа к провайдеру. accountKey — личный идентификатор, не журналировать.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,timeoutMs?:number}} options
 * @returns {Promise<{status:string,binding?:{slotId:string,clientId:string,accountKey:string}}>}
 */
export async function readNativeCredentialBinding(options) {
  try {
    const input = object(options, ['provider', 'invoke'], ['timeoutMs']);
    if (!validProvider(input.provider) || typeof input.invoke !== 'function') throw failed();
    const reply = object(
      await callWithin(
        input.invoke,
        'cloud_credential_binding_read',
        { provider: input.provider },
        timeoutOf(input.timeoutMs)
      ),
      ['status'],
      ['slotId', 'clientId', 'accountKey']
    );
    if (['empty', 'blocked', 'pending'].includes(reply.status)) {
      if (Object.keys(reply).length !== 1) throw failed();
      return Object.freeze({ status: reply.status });
    }
    if (
      reply.status !== 'ready' ||
      Object.keys(reply).length !== 4 ||
      !validCredentialId(reply.slotId) ||
      !validOAuthClientId(input.provider, reply.clientId) ||
      !validOAuthAccountKey(reply.accountKey)
    )
      throw failed();
    return Object.freeze({
      status: 'ready',
      binding: Object.freeze({
        slotId: reply.slotId,
        clientId: reply.clientId,
        accountKey: reply.accountKey
      })
    });
  } catch {
    throw failed();
  }
}

/**
 * Адаптер ПЕРВОЙ установки для oauthCredentialEnrollment. Создаётся на одну
 * попытку и вызывается только после явного подтверждения аккаунта. Отсутствие
 * всех записей не доказывает, что это первый вход. `blocked`, ошибка IPC или
 * потеря ответа означают неопределённость и запрещают повтор в этом экземпляре.
 * Проверка чтением не доказывает fsync, отсутствие отката или работу Windows.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,timeoutMs?:number}} options
 */
export function createNativeCredentialInstaller(options) {
  let input;
  let timeoutMs;
  try {
    input = object(options, ['provider', 'invoke'], ['timeoutMs']);
    if (!validProvider(input.provider) || typeof input.invoke !== 'function') throw failed();
    timeoutMs = timeoutOf(input.timeoutMs);
  } catch {
    throw failed();
  }
  const { provider, invoke } = input;
  let phase = 'ready';
  let installed = null;
  return Object.freeze({
    async installIfAbsent(args) {
      if (phase !== 'ready') throw failed();
      let request;
      try {
        request = argumentsFor(provider, args);
        if (provider === 'google' && request.parsed.phase !== 'ready') throw failed();
      } catch {
        throw failed();
      }
      phase = 'installing';
      try {
        const result = response(
          await callWithin(
            invoke,
            'cloud_credential_install',
            { provider, slotId: request.slotId, record: request.record },
            timeoutMs
          ),
          ['installed', 'occupied', 'blocked']
        );
        if (result.status === 'occupied') {
          phase = 'finished';
          return 'occupied';
        }
        if (result.status !== 'installed') throw failed();
        installed = {
          slotId: request.slotId,
          clientId: request.clientId,
          accountKey: request.accountKey,
          record: request.record
        };
        phase = 'installed';
        return 'installed';
      } catch {
        phase = 'blocked';
        installed = null;
        throw failed();
      }
    },

    async verifyInstallation(args) {
      if (phase !== 'installed' || !installed) throw failed();
      phase = 'verifying';
      try {
        const request = argumentsFor(provider, args);
        if (
          request.slotId !== installed.slotId ||
          request.clientId !== installed.clientId ||
          request.accountKey !== installed.accountKey ||
          request.record !== installed.record
        )
          throw failed();
        const reply = response(await callWithin(invoke, 'cloud_credential_read', { provider }, timeoutMs), [
          'ready',
          'empty',
          'blocked'
        ]);
        const verified = reply.status === 'ready' && reply.slotId === request.slotId && reply.record === request.record;
        phase = verified ? 'finished' : 'blocked';
        return verified;
      } catch {
        phase = 'blocked';
        throw failed();
      } finally {
        installed = null;
      }
    }
  });
}

/**
 * Мост уже установленной записи для модели ротации Google. Не устанавливает
 * аккаунт, не подтверждает актуальность или сохранность pin и не запускает сеть.
 * Данные аккаунта должны быть получены из защищённой ранее подтверждённой записи;
 * нельзя считать их самостоятельно введённой строкой доказательством аккаунта.
 * Ошибку записи нельзя повторять автоматически; при неопределённости экземпляр
 * остаётся заблокированным, даже если позднее пришёл ответ.
 * @param {{slotId:string,clientId:string,accountKey:string,invoke:(command:string,args:any)=>Promise<any>,timeoutMs?:number}} options
 */
export function createNativeGoogleCredentialStore(options) {
  let input;
  let timeoutMs;
  try {
    input = object(options, ['slotId', 'clientId', 'accountKey', 'invoke'], ['timeoutMs']);
    if (
      !validCredentialId(input.slotId) ||
      !validOAuthClientId('google', input.clientId) ||
      !validOAuthAccountKey(input.accountKey) ||
      typeof input.invoke !== 'function'
    )
      throw failed();
    timeoutMs = timeoutOf(input.timeoutMs);
  } catch {
    throw failed();
  }
  const { slotId, clientId, accountKey, invoke } = input;
  let inFlight = false;
  let blocked = false;
  const checked = raw => argumentsFor('google', { slotId, clientId, accountKey, record: raw }).parsed;
  return Object.freeze({
    async read() {
      if (blocked || inFlight) throw failed();
      inFlight = true;
      try {
        const reply = response(await callWithin(invoke, 'cloud_credential_read', { provider: 'google' }, timeoutMs), [
          'ready',
          'empty',
          'blocked'
        ]);
        if (reply.status === 'empty') return null;
        if (reply.status !== 'ready' || reply.slotId !== slotId) throw failed();
        checked(reply.record);
        return reply.record;
      } catch {
        blocked = true;
        throw failed();
      } finally {
        inFlight = false;
      }
    },

    async compareExchange(expected, next) {
      if (blocked || inFlight) throw failed();
      try {
        if (!transition(checked(expected), checked(next))) throw failed();
      } catch {
        throw failed();
      }
      inFlight = true;
      try {
        const reply = response(
          await callWithin(
            invoke,
            'cloud_credential_compare_exchange',
            { provider: 'google', slotId, expected, next },
            timeoutMs
          ),
          ['swapped', 'mismatch', 'blocked']
        );
        if (reply.status === 'blocked') throw failed();
        return reply.status;
      } catch {
        blocked = true;
        throw failed();
      } finally {
        inFlight = false;
      }
    }
  });
}

/**
 * Удаляет только проверенную локальную запись доступа, если в тот же момент
 * нет pin набора. Native выполняет проверку pin и slot под общим lock. Не
 * удаляет ключи/файлы и не отзывает разрешение у провайдера. `empty` pin не
 * доказывает отсутствие старого облака. Ошибка или таймаут после вызова могут
 * означать частичный/неизвестный результат: автоматически повторять нельзя.
 * @param {{provider:'google'|'yandex',slotId:string,invoke:(command:string,args:any)=>Promise<any>,confirmed:boolean,timeoutMs?:number}} options
 * @returns {Promise<'forgotten'|'blocked'|'mismatch'>}
 */
export async function forgetUnboundNativeCredential(options) {
  try {
    const input = object(options, ['provider', 'slotId', 'invoke', 'confirmed'], ['timeoutMs']);
    if (
      !validProvider(input.provider) ||
      !validCredentialId(input.slotId) ||
      typeof input.invoke !== 'function' ||
      input.confirmed !== true
    )
      throw failed();
    const reply = response(
      await callWithin(
        input.invoke,
        'cloud_credential_forget_if_unbound',
        { provider: input.provider, expectedSlot: input.slotId, confirmed: true },
        timeoutOf(input.timeoutMs)
      ),
      ['forgotten', 'blocked', 'mismatch']
    );
    return reply.status;
  } catch {
    throw failed();
  }
}

/**
 * Только после отдельного необратимого подтверждения пользователя. Это локальное
 * забывание; файлы в облаке и разрешение приложения у провайдера не удаляются.
 * Ошибка/потеря ответа могут означать частичное удаление; не повторять автоматически.
 * @param {{provider:'google'|'yandex',invoke:(command:string,args:any)=>Promise<any>,confirmed:boolean,timeoutMs?:number}} options
 */
export async function forgetNativeCredential(options) {
  try {
    const input = object(options, ['provider', 'invoke', 'confirmed'], ['timeoutMs']);
    if (!validProvider(input.provider) || typeof input.invoke !== 'function' || input.confirmed !== true)
      throw failed();
    const reply = response(
      await callWithin(
        input.invoke,
        'cloud_credential_forget',
        { provider: input.provider, confirmed: true },
        timeoutOf(input.timeoutMs)
      ),
      ['forgotten']
    );
    return reply.status === 'forgotten';
  } catch {
    throw failed();
  }
}
