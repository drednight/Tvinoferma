// @ts-check
// Only fixed codes cross the diagnostic boundary. Never display exception text,
// provider descriptions, response bodies, URLs, identifiers or credentials.
const REASONS = Object.freeze({
  client_secret_required:
    'Google требует параметр client_secret, который текущая сборка не передаёт. Это ограничение подключения в программе; не вставляйте секрет в поле Client ID.',
  invalid_client:
    'Сервис отклонил параметры OAuth-клиента. Это может быть несовместимость способа обмена, а не ошибка введённого ID.',
  invalid_grant:
    'Код авторизации отклонён: он мог истечь, быть использован или не совпасть с параметрами этой попытки.',
  invalid_request: 'Сервис отклонил параметры запроса авторизации.',
  unauthorized_client: 'Для этого OAuth-клиента сервис не разрешил выбранный способ авторизации.',
  invalid_scope: 'Сервис отклонил запрошенное разрешение.',
  access_denied: 'Сервис отказал в доступе.',
  api_disabled: 'Google Drive API отключён или ещё не активирован для проекта OAuth-клиента.',
  insufficient_scope: 'Для запроса сервису недостаточно выданного разрешения.',
  http_400: 'Сервис отклонил запрос (HTTP 400).',
  http_401: 'Сервис не принял авторизацию (HTTP 401).',
  http_403: 'Сервис запретил запрос (HTTP 403).',
  rate_limited: 'Сервис ограничил частоту запросов (HTTP 429). Автоматического повтора нет.',
  server_error: 'Ошибка на стороне сервиса (HTTP 5xx). Результат обмена может быть неизвестен.',
  http_rejected: 'Сервис вернул неподдерживаемый HTTP-ответ.',
  timeout: 'Истекло время ожидания. Результат обмена может быть неизвестен; автоматического повтора нет.',
  connection_failed:
    'Не удалось установить защищённое соединение с сервисом. Возможны ограничения сети, TLS или прокси.',
  network_failed: 'Сетевой запрос не завершён. Результат обмена может быть неизвестен.',
  busy: 'Предыдущий нативный запрос ещё выполняется. Автоматического повтора нет.',
  response_invalid: 'Ответ сервиса не прошёл проверку формата или разрешений.',
  transport_failed: 'Нативный запрос не выполнен или его ответ не прошёл проверку. Исходные данные ошибки скрыты.'
});
const STAGES = Object.freeze({
  browser: 'Ответ браузера',
  token: 'Обмен кода на токен',
  identity: 'Проверка аккаунта'
});
export function nativeOAuthDiagnostic(value) {
  if (typeof value !== 'string' || !value.startsWith('oauth_')) return 'transport_failed';
  const code = value.slice(6);
  return Object.hasOwn(REASONS, code) ? code : 'transport_failed';
}
export function createOAuthDiagnostics() {
  let stage = 'browser',
    code = null;
  return {
    progress(value) {
      if (Object.hasOwn(STAGES, value)) {
        stage = value;
        code = null;
      }
    },
    native(value) {
      code = Object.hasOwn(REASONS, value) ? value : 'transport_failed';
    },
    /** @returns {{status:'failed',diagnostic:{stage:string,code:string}}} */
    failure() {
      return { status: 'failed', diagnostic: { stage, code: code || 'response_invalid' } };
    }
  };
}
/** Revalidate even locally constructed results; no raw fallback text. */
export function describeOAuthFailure(diagnostic) {
  if (
    !diagnostic ||
    typeof diagnostic !== 'object' ||
    typeof diagnostic.stage !== 'string' ||
    typeof diagnostic.code !== 'string' ||
    !Object.hasOwn(STAGES, diagnostic.stage) ||
    !Object.hasOwn(REASONS, diagnostic.code)
  )
    return '';
  return `${STAGES[diagnostic.stage]}: ${REASONS[diagnostic.code]} Код: ${diagnostic.stage}/${diagnostic.code}. Токены и исходный ответ не выводятся.`;
}
