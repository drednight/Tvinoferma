// @ts-check
// Only fixed, non-personal stage codes. No response, exception text, URL or token.
// WeakMap metadata never enters durable queues or serialized IPC payloads.
const codes = new Set(
  [
    'identity',
    'disk',
    'upload_link',
    'upload_content',
    'download_link',
    'download_content',
    'file_id',
    'verification'
  ].flatMap(stage =>
    [
      'unauthorized',
      'forbidden',
      'rate_limited',
      'service_unavailable',
      'http_error',
      'invalid_response',
      'transport_unavailable',
      'timeout',
      'aborted'
    ].map(reason => `${stage}_${reason}`)
  )
);
codes.add('verification_not_found');
codes.add('verification_mismatch');
const diagnostics = new WeakMap();
export function withCloudAccessDiagnostic(value, code) {
  if (value && (typeof value === 'object' || typeof value === 'function') && codes.has(code))
    diagnostics.set(value, code);
  return value;
}
export function cloudAccessDiagnostic(value) {
  return value && (typeof value === 'object' || typeof value === 'function') ? diagnostics.get(value) : undefined;
}
export function cloudAccessHttpDiagnostic(stage, status) {
  const reason =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 429
          ? 'rate_limited'
          : status >= 500 && status <= 599
            ? 'service_unavailable'
            : 'http_error';
  const code = `${stage}_${reason}`;
  return codes.has(code) ? code : undefined;
}

const STAGES = {
  identity: 'Сверка аккаунта',
  disk: 'Чтение списка файлов',
  upload_link: 'Получение ссылки отправки',
  upload_content: 'Отправка содержимого',
  download_link: 'Получение ссылки скачивания',
  download_content: 'Скачивание для сверки',
  file_id: 'Выделение ID файла',
  verification: 'Сверка отправленного файла'
};
const REASONS = {
  unauthorized: 'сервис отклонил доступ (HTTP 401)',
  forbidden: 'сервис запретил доступ (HTTP 403); проверьте права приложения',
  rate_limited: 'лимит запросов (HTTP 429); повторите позже',
  service_unavailable: 'сервис временно недоступен',
  http_error: 'сервис вернул ошибку HTTP',
  invalid_response: 'ответ или ссылка не прошли безопасную проверку',
  transport_unavailable: 'запрос не завершён; проверьте сеть и доступность сервиса',
  timeout: 'время ожидания истекло',
  aborted: 'запрос прерван',
  not_found: 'файл пока не найден; отправка не подтверждена',
  mismatch: 'содержимое отличается; повтор остановлен'
};
export const CLOUD_ACCESS_MESSAGES = Object.freeze(
  Object.fromEntries(
    [...codes].map(code => {
      const stage = Object.keys(STAGES).find(key => code.startsWith(key + '_'));
      return [code, `${STAGES[stage]} — ${REASONS[code.slice(stage.length + 1)]}`];
    })
  )
);
