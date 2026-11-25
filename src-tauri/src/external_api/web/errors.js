// Сгенерировано из js/modules/externalApi/errors.js — не править руками.
// Каталог кодов ошибок для страницы API (CSP запрещает inline-скрипты).
// Проверка совпадения — tests/externalApiErrors.test.js.
(() => {
  'use strict';
  window.TF_ERROR_CATALOG = [
    {
      "code": "bad_request",
      "status": 400,
      "title": "Некорректный запрос",
      "hint": "Строка запроса не похожа на HTTP."
    },
    {
      "code": "confirm_required",
      "status": 400,
      "title": "Нужно подтверждение",
      "hint": "Добавьте {\"confirm\": true}."
    },
    {
      "code": "invalid_json",
      "status": 400,
      "title": "Тело не разобралось",
      "hint": "Проверьте JSON и что тело — объект."
    },
    {
      "code": "unauthorized",
      "status": 401,
      "title": "Токен не принят",
      "hint": "Проверьте Bearer-токен из настроек."
    },
    {
      "code": "forbidden",
      "status": 403,
      "title": "Запрос запрещён",
      "hint": "CORS не поддерживается: запрос со сторонней страницы."
    },
    {
      "code": "forbidden_host",
      "status": 403,
      "title": "Неверный Host",
      "hint": "Обращайтесь на 127.0.0.1 или localhost."
    },
    {
      "code": "forbidden_scope",
      "status": 403,
      "title": "Право выключено",
      "hint": "Включите нужную галочку в настройках."
    },
    {
      "code": "no_such_character",
      "status": 404,
      "title": "Персонаж не найден",
      "hint": "Список id — GET /characters."
    },
    {
      "code": "no_such_marathon",
      "status": 404,
      "title": "Марафон не найден",
      "hint": "Список — GET /marathons."
    },
    {
      "code": "no_such_party",
      "status": 404,
      "title": "Пати не найдена",
      "hint": "Список — GET /parties."
    },
    {
      "code": "no_such_task",
      "status": 404,
      "title": "Задание не найдено",
      "hint": "Список заданий — в GET /marathons/{id}."
    },
    {
      "code": "not_found",
      "status": 404,
      "title": "Не найдено",
      "hint": "Проверьте адрес в справочнике."
    },
    {
      "code": "method_not_allowed",
      "status": 405,
      "title": "Метод не поддерживается",
      "hint": "Проверьте GET/POST/PATCH в справочнике."
    },
    {
      "code": "timeout",
      "status": 408,
      "title": "Таймаут запроса",
      "hint": "Запрос не дошёл целиком за 5 секунд."
    },
    {
      "code": "launch_not_ready",
      "status": 409,
      "title": "Запускать некого",
      "hint": "Список персонажей для запуска пуст."
    },
    {
      "code": "marathon_not_ready",
      "status": 409,
      "title": "Это папка марафонов",
      "hint": "Выберите марафон внутри папки."
    },
    {
      "code": "payload_too_large",
      "status": 413,
      "title": "Слишком большой запрос",
      "hint": "Заголовки до 16 КиБ, тело до 64 КиБ."
    },
    {
      "code": "unsupported_media_type",
      "status": 415,
      "title": "Неверный Content-Type",
      "hint": "Для тела нужен application/json."
    },
    {
      "code": "invalid_value",
      "status": 422,
      "title": "Значение не принято",
      "hint": "Сообщение в ответе объясняет, что именно."
    },
    {
      "code": "storage_blocked",
      "status": 423,
      "title": "Запись остановлена",
      "hint": "Снимите защиту «Сохранение остановлено»."
    },
    {
      "code": "launch_busy",
      "status": 429,
      "title": "Уже идёт запуск",
      "hint": "Дождитесь завершения задания."
    },
    {
      "code": "too_many_requests",
      "status": 429,
      "title": "Слишком часто",
      "hint": "60 запросов в минуту; см. Retry-After."
    },
    {
      "code": "internal_error",
      "status": 500,
      "title": "Внутренняя ошибка",
      "hint": "Подробности — в журнале приложения."
    },
    {
      "code": "save_failed",
      "status": 500,
      "title": "Не удалось сохранить",
      "hint": "Изменение в памяти, но на диск не легло."
    },
    {
      "code": "app_not_ready",
      "status": 503,
      "title": "Приложение не готово",
      "hint": "Главное окно ещё загружается."
    },
    {
      "code": "too_many_connections",
      "status": 503,
      "title": "Слишком много соединений",
      "hint": "Не больше 16 одновременно."
    },
    {
      "code": "gateway_timeout",
      "status": 504,
      "title": "Приложение не ответило",
      "hint": "JS не уложился в 15 секунд."
    }
  ];
})();
