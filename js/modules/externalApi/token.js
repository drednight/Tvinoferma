// @ts-check
// js/modules/externalApi/token.js
// Токен внешнего API: создаётся в JS, хранится в хранилище ОС через те же команды
// secrets_*, что и контакты персонажей, и никогда не попадает в state.json.
//
// Почему именно так: state.json синхронизируется между компьютерами и лежит в
// резервных копиях, а токен — «ключ от двери» локального сервера. В настройках
// остаётся только отметка `externalApi.tokenCreatedAt`.
//
// Ключ в vault свой (`external-api-v1`), а не `contacts:<id>`: он не должен ни
// пересекаться с персонажами, ни удаляться вместе с ними.

const SERVICE_KEY = 'external-api-v1';
const TOKEN_BYTES = 32;
/** Формат токена: 64 шестнадцатеричных символа. Проверяется и в Rust. */
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const UNAVAILABLE = 'Хранилище учётных данных ОС недоступно';
const WRITE_FAILED = 'Не удалось сохранить токен в хранилище ОС';
const READ_FAILED = 'Не удалось прочитать токен из хранилища ОС';

let invokeImpl = null;
async function invoke(cmd, args) {
  if (!invokeImpl) invokeImpl = (await import('@tauri-apps/api/core')).invoke;
  return invokeImpl(cmd, args);
}

/** Для тестов: подменить транспорт к Rust. */
export function __setInvoke(fn) {
  invokeImpl = fn;
}

/** Случайный токен: 32 байта из CSPRNG браузера, в шестнадцатеричной записи. */
export function newToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function isToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * Токен из хранилища ОС. `null` — записи нет или она не того формата;
 * ошибка — хранилище недоступно или запись повреждена.
 * @returns {Promise<string | null>}
 */
export async function readToken() {
  let records;
  try {
    records = await invoke('secrets_get_many', { keys: [SERVICE_KEY] });
  } catch {
    throw new Error(READ_FAILED);
  }
  if (!records || typeof records !== 'object') throw new Error(READ_FAILED);
  const value = records[SERVICE_KEY];
  if (value === undefined) return null;
  if (!isToken(value)) throw new Error('Токен в хранилище ОС повреждён: перевыпустите его в настройках');
  return value;
}

/**
 * Сохранить токен в хранилище ОС. Пустая строка удаляет запись.
 * @param {string} token
 */
export async function writeToken(token) {
  if (token && !isToken(token)) throw new Error('Токен имеет неверный формат');
  try {
    await invoke('secrets_set_many', { items: { [SERVICE_KEY]: token } });
  } catch {
    throw new Error(WRITE_FAILED);
  }
}

/** Удалить токен. Отсутствие записи — не ошибка. */
export async function forgetToken() {
  await writeToken('');
}

/**
 * Токен для запуска сервера: существующий из хранилища или новый (тогда он там же
 * сохраняется). Возвращает и признак «создан сейчас» — показать его пользователю.
 * @returns {Promise<{ token: string, created: boolean }>}
 */
export async function ensureToken() {
  let token;
  try {
    token = await readToken();
  } catch {
    // Хранилище недоступно или запись повреждена: без токена сервер не запускаем —
    // подставлять предсказуемое значение нельзя. Ошибка уходит вызывающему.
    throw new Error(UNAVAILABLE);
  }
  if (token) return { token, created: false };
  const created = newToken();
  await writeToken(created);
  return { token: created, created: true };
}
