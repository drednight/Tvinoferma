// @ts-check
// js/modules/externalApi/errors.js
// Единый вид ошибок внешнего API: формат ответа, подписи кодов и журнал.
//
// Формат ответа один и тот же везде — и в Rust, и в мосте:
//
//   { "error": { "code": "invalid_value", "message": "…" } }
//
// Поэтому каталог кодов живёт в одном месте: по нему строятся подписи в
// журнале приложения, на странице API и в справочнике. Если добавить код в
// мост и забыть про каталог — тест поймает: он сверяет коды в ошибках и здесь.

/**
 * Коды ошибок: HTTP-статус, короткая русская подпись и совет, что делать.
 * `hint` — для человека, который читает ответ или журнал.
 */
export const ERROR_CATALOG = {
  // 400
  invalid_json: { status: 400, title: 'Тело не разобралось', hint: 'Проверьте JSON и что тело — объект.' },
  bad_request: { status: 400, title: 'Некорректный запрос', hint: 'Строка запроса не похожа на HTTP.' },
  confirm_required: { status: 400, title: 'Нужно подтверждение', hint: 'Добавьте {"confirm": true}.' },
  // 401–403
  unauthorized: { status: 401, title: 'Токен не принят', hint: 'Проверьте Bearer-токен из настроек.' },
  forbidden_host: { status: 403, title: 'Неверный Host', hint: 'Обращайтесь на 127.0.0.1 или localhost.' },
  forbidden_scope: { status: 403, title: 'Право выключено', hint: 'Включите нужную галочку в настройках.' },
  forbidden: { status: 403, title: 'Запрос запрещён', hint: 'CORS не поддерживается: запрос со сторонней страницы.' },
  // 404–409
  not_found: { status: 404, title: 'Не найдено', hint: 'Проверьте адрес в справочнике.' },
  no_such_character: {
    status: 404,
    title: 'Персонаж не найден',
    hint: 'Сверьте id со списком: GET /characters возвращает их все.'
  },
  no_such_party: { status: 404, title: 'Пати не найдена', hint: 'Список — GET /parties.' },
  no_such_marathon: { status: 404, title: 'Марафон не найден', hint: 'Список — GET /marathons.' },
  no_such_task: { status: 404, title: 'Задание не найдено', hint: 'Список заданий — в GET /marathons/{id}.' },
  method_not_allowed: {
    status: 405,
    title: 'Метод не поддерживается',
    hint: 'Проверьте GET/POST/PATCH в справочнике.'
  },
  timeout: { status: 408, title: 'Таймаут запроса', hint: 'Запрос не дошёл целиком за 5 секунд.' },
  launch_not_ready: { status: 409, title: 'Запускать некого', hint: 'Список персонажей для запуска пуст.' },
  marathon_not_ready: { status: 409, title: 'Это папка марафонов', hint: 'Выберите марафон внутри папки.' },
  // 413–429
  payload_too_large: { status: 413, title: 'Слишком большой запрос', hint: 'Заголовки до 16 КиБ, тело до 64 КиБ.' },
  unsupported_media_type: { status: 415, title: 'Неверный Content-Type', hint: 'Для тела нужен application/json.' },
  invalid_value: {
    status: 422,
    title: 'Значение не принято',
    hint: 'Проверьте значения полей: допустимые перечислены в тексте ошибки.'
  },
  storage_blocked: { status: 423, title: 'Запись остановлена', hint: 'Снимите защиту «Сохранение остановлено».' },
  launch_busy: { status: 429, title: 'Уже идёт запуск', hint: 'Дождитесь завершения задания.' },
  too_many_requests: { status: 429, title: 'Слишком часто', hint: '60 запросов в минуту; см. Retry-After.' },
  // 500–504
  internal_error: { status: 500, title: 'Внутренняя ошибка', hint: 'Подробности — в журнале приложения.' },
  save_failed: { status: 500, title: 'Не удалось сохранить', hint: 'Изменение в памяти, но на диск не легло.' },
  app_not_ready: { status: 503, title: 'Приложение не готово', hint: 'Главное окно ещё загружается.' },
  too_many_connections: { status: 503, title: 'Слишком много соединений', hint: 'Не больше 16 одновременно.' },
  // 504 приходит и от Rust (JS не ответил), и как код таймаута
  gateway_timeout: { status: 504, title: 'Приложение не ответило', hint: 'JS не уложился в 15 секунд.' }
};

/**
 * Подпись кода: `invalid_value` → «Значение не принято (422)».
 *
 * Незнакомый код (Rust новее интерфейса) показываем как «Ошибка: code» — сам код
 * не теряем, но и не подсовываем пользователю латиницу без пояснения.
 * @param {string} code
 */
export function errorTitle(code) {
  const key = String(code || '');
  const entry = ERROR_CATALOG[key];
  if (entry) return `${entry.title} (${entry.status})`;
  return key ? `Ошибка: ${key}` : 'Ошибка';
}

/**
 * Совет по коду. Для незнакомого кода — общая подсказка: пустая строка в
 * интерфейсе выглядит как «ничего не известно», а это не так.
 * @param {string} code
 */
export function errorHint(code) {
  return (
    ERROR_CATALOG[String(code)]?.hint ||
    'Код не описан в текущей версии справочника — обновите приложение или посмотрите журнал.'
  );
}

/** Ответ моста для ошибки: всегда `{ status, body: { error: { code, message } } }`. */
export function errorBody(error) {
  const status = Number(error?.status) || 500;
  // Текст произвольного исключения наружу не отдаём: в нём бывают пути и
  // значения полей. Клиент получает код и понятное сообщение.
  const known = error?.code && typeof error.code === 'string' && status !== 500;
  return {
    status,
    body: {
      error: {
        code: String(error?.code || 'internal_error'),
        message: known ? String(error.message || 'Ошибка') : 'Внутренняя ошибка приложения'
      }
    }
  };
}

/**
 * Строка для журнала приложения и страницы: одна ошибка = одна строка.
 * `12:01:07  GET /api/v1/characters  → 404  Значение не принято (422)  (3 мс)`
 * @param {{ method?: string, path?: string, status?: number, code?: string, ms?: number, atMs?: number }} entry
 */
export function auditLine(entry) {
  const at = new Date(Number(entry.atMs) || Date.now());
  const time = Number.isNaN(at.getTime()) ? '—' : at.toLocaleTimeString('ru-RU', { hour12: false });
  const status = Number(entry.status) || 0;
  const parts = [time, String(entry.method || '—'), String(entry.path || '—'), `→ ${status}`];
  if (entry.code) parts.push(errorTitle(entry.code));
  parts.push(`(${Number(entry.ms) || 0} мс)`);
  return parts.join('  ');
}

/**
 * Коды, которые умеет отдавать API, — списком для справочника и тестов.
 * Сгруппированы по HTTP-статусу и отсортированы: так их удобно читать.
 */
export function errorCatalogRows() {
  return Object.entries(ERROR_CATALOG)
    .map(([code, meta]) => ({ code, ...meta }))
    .sort((a, b) => a.status - b.status || a.code.localeCompare(b.code));
}
