// scripts/tf/client.mjs
// Соединение с локальным API Твинофермы: адрес, токен, один запрос.
//
// Про токен — сознательное ограничение: у `tf` НЕТ флага `--token`. Флаг
// попадает в командную строку, а её видят `ps`, история оболочки и журнал агента.
// Приложение хранит токен в хранилище ОС и никогда не берёт его из аргументов
// (см. js/modules/externalApi/token.js), и CLI держит ту же планку: переменная
// окружения `TF_API_TOKEN` или файл (`--token-file`, `TF_API_TOKEN_FILE`).
// Вывод CLI токен не показывает никогда — в dry-run он скрыт и в заголовках.
import { readFileSync } from 'node:fs';

/** Порт по умолчанию: совпадает с `DEFAULT_PORT` в src-tauri/src/external_api/mod.rs. */
export const DEFAULT_PORT = 47831;
/** Порт тестовой сборки: `ACCEPTANCE_DEFAULT_PORT` того же файла. */
export const ACCEPTANCE_PORT = 47832;

/** Формат токена — те же 64 hex-символа, что требует `valid_token` в Rust. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Проверка порта: тот же диапазон, что в настройках приложения (1024–65535). */
function toPort(value, source, problems) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    problems.push(`${source}: нужен целый порт 1024–65535, получено «${value}»`);
    return 0;
  }
  return port;
}

/** Порт из `http://127.0.0.1:47832`, если он указан. */
function portFromBase(base) {
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/.exec(String(base || ''));
  return match ? Number(match[1]) : 0;
}

/**
 * Адрес и токен из аргументов и окружения. `readFile` подменяется в тестах,
 * чтобы проверка не зависела от файловой системы.
 *
 * @param {{ argv?: Record<string, any>, env?: Record<string, string|undefined>, readFile?: (path: string) => string }} input
 * @returns {{ base: string, port: number, token: string, tokenSource: string, problems: string[] }}
 */
export function resolveConnection(input = {}) {
  const argv = input.argv || {};
  const env = input.env || {};
  const readFile = input.readFile || (path => readFileSync(path, 'utf8'));
  const problems = [];

  let port = 0;
  if (argv.port !== undefined) port = toPort(argv.port, '--port', problems);
  else if (env.TF_API_PORT) port = toPort(env.TF_API_PORT, 'TF_API_PORT', problems);

  let base = String(argv.base || env.TF_API_BASE || '');
  base = base.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  if (!base) base = `http://127.0.0.1:${port || DEFAULT_PORT}`;
  if (!port) port = portFromBase(base) || DEFAULT_PORT;
  // `--base` и `--port` вместе — подозрительно: порт молча проиграл бы, а скрипт
  // мог решиться, что работает с тестовой сборкой.
  if (argv.port !== undefined && argv.base !== undefined) {
    const basePort = portFromBase(base);
    if (basePort && basePort !== port) {
      problems.push(`--base и --port противоречат друг другу: в адресе порт ${basePort}, а указан ${argv.port}`);
    }
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
    problems.push(`адрес «${base}» не подходит: API слушает только 127.0.0.1, используйте http://127.0.0.1:<порт>`);
  }

  let token = '';
  let tokenSource = '';
  if (argv.token !== undefined) {
    problems.push(
      'флаг --token не поддерживается: командную строку видят ps и история оболочки. ' +
        'Используйте переменную TF_API_TOKEN или --token-file <путь>.'
    );
  } else if (env.TF_API_TOKEN) {
    token = String(env.TF_API_TOKEN).trim().toLowerCase();
    tokenSource = 'TF_API_TOKEN';
  } else if (argv['token-file'] !== undefined || env.TF_API_TOKEN_FILE) {
    const file = String(argv['token-file'] || env.TF_API_TOKEN_FILE);
    try {
      token = String(readFile(file)).split(/\r?\n/)[0].trim().toLowerCase();
      tokenSource = `файл ${file}`;
    } catch (error) {
      problems.push(`не удалось прочитать токен из «${file}»: ${error?.message || error}`);
    }
  }
  if (token && !TOKEN_PATTERN.test(token)) {
    problems.push(
      'токен неполный: сервер ждёт 64 hex-символа. Скопируйте его заново: «Настройки → 🔌 Внешний API» → «Перевыпустить токен» → «Скопировать токен»'
    );
  }
  return { base, port, token, tokenSource, problems };
}

/**
 * Один запрос к API. Ответ нормализуется, чтобы вывод и коды выхода не зависели
 * от того, кто ответил — Rust (транспорт) или JS-мост (данные).
 *
 * @param {{
 *   base: string, token: string, method: string, path: string, body?: any,
 *   timeoutMs?: number, fetchImpl?: typeof fetch
 * }} input
 * @returns {Promise<{ ok: boolean, status: number, data: any, rawText?: string, contentType: string, disposition: string, networkError?: string }>}
 */
export async function sendRequest(input) {
  const { base, token, method, path, body } = input;
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      status: 0,
      data: null,
      contentType: '',
      disposition: '',
      networkError: 'в этом Node нет fetch (нужен Node 18+)'
    };
  }
  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const contentType = String(response.headers?.get?.('content-type') || '');
    const disposition = String(response.headers?.get?.('content-disposition') || '');
    const text = await response.text();
    if (contentType.includes('json')) {
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { error: { code: 'invalid_json', message: 'ответ сервера не разобран как JSON' } };
      }
      return { ok: response.ok, status: response.status, data, contentType, disposition };
    }
    // Выгрузки (`/export/*`) отдают файл: CSV или JSON-текст без обёртки.
    return { ok: response.ok, status: response.status, data: null, rawText: text, contentType, disposition };
  } catch (error) {
    const aborted = String(error?.name || '') === 'AbortError';
    return {
      ok: false,
      status: 0,
      data: null,
      contentType: '',
      disposition: '',
      networkError: aborted
        ? `сервер молчал ${timeoutMs} мс, запрос отменён (увеличьте --timeout)`
        : String(error?.message || error || 'сеть не ответила')
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Подсказка по отказу: что именно сделать. Это главная ценность CLI над `curl` —
 * таблицу статусов (раздел 4.17 docs/EXTERNAL-API.md) знать не обязательно.
 */
export function hintFor(result) {
  const code = String(result?.data?.error?.code || '');
  const status = Number(result?.status) || 0;
  if (result?.networkError) {
    return (
      `сервер не ответил: ${result.networkError}. Проверьте, что Твиноферма запущена и «🔌 Внешний API» включён; ` +
      `порт по умолчанию ${DEFAULT_PORT}, у тестовой сборки — ${ACCEPTANCE_PORT}.`
    );
  }
  if (status === 401)
    return 'токен не подошёл: приложение показывает его только один раз — «Настройки → 🔌 Внешний API» → «Перевыпустить токен» и сохранить новый.';
  if (status === 403 && code === 'forbidden_scope')
    return 'право выключено: включите нужное в «Настройки → 🔌 Внешний API» — «изменение» или «запуск и закрытие окон».';
  if (status === 403)
    return 'доступ запрещён: API отвечает только на запросы к 127.0.0.1 и только из приложения с включённым правом.';
  if (code === 'launch_busy') return 'уже идёт запуск: дождитесь итога (tf jobs --job-id <id>) и повторите.';
  if (code === 'launch_not_ready') return 'некого запускать: посмотрите tf characters --json и tf windows --json.';
  if (status === 404 && code.startsWith('no_such_'))
    return 'список id нужно взять самим: tf characters --json, tf parties --json, tf marathons --json.';
  if (status === 404) return 'такого маршрута нет: tf ls покажет команды, tf call — прямой запрос к API.';
  if (status === 422) return 'значение не подошло: tf describe <команда> перечисляет поля и допустимые варианты.';
  if (status === 423) return 'запись состояния остановлена защитой приложения: сначала разблокируйте сохранение.';
  if (status === 429) return 'слишком часто: у API есть лимит частоты, посмотрите заголовок Retry-After.';
  if (status === 503) return 'приложение ещё не готово: дождитесь загрузки главного окна и повторите.';
  if (status === 504) return 'JS-мост не ответил за 15 с: проверьте, что окно приложения открыто.';
  return '';
}
