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
      'aborted',
      'native_busy',
      'native_connect',
      'native_redirect',
      'native_redirect_target',
      'native_redirect_chain',
      'native_encoding',
      'native_size',
      'native_body',
      'native_policy',
      'native_client'
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
  native_busy: 'предыдущий запрос ещё выполняется; новая отправка не начата',
  native_connect: 'не удалось установить соединение с сервисом (сеть, DNS или TLS)',
  native_redirect: 'сервис ответил перенаправлением; переход остановлен безопасной политикой',
  native_redirect_target: 'сервер перенаправил на адрес, не разрешённый для скачивания Яндекса',
  native_redirect_chain: 'сервер запросил повторное перенаправление; разрешён только один переход на хранилище Яндекса',
  native_encoding: 'сервис прислал неподдерживаемое сжатие ответа',
  native_size: 'ответ превышает допустимый размер',
  native_body: 'не удалось безопасно прочитать содержимое ответа',
  native_policy: 'запрос остановлен безопасной политикой',
  native_client: 'не удалось подготовить защищённое соединение',
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

// Match ONLY exact fixed Rust codes, never parse message text, URLs or objects.
export function nativeCloudAccessDiagnostic(error, operation) {
  const reasons = {
    cloud_disk_timeout: 'timeout',
    cloud_disk_connect: 'native_connect',
    cloud_disk_transport: 'transport_unavailable',
    cloud_disk_busy: 'native_busy',
    cloud_disk_redirect: 'native_redirect',
    cloud_disk_redirect_target: 'native_redirect_target',
    cloud_disk_redirect_chain: 'native_redirect_chain',
    cloud_disk_encoding: 'native_encoding',
    cloud_disk_size: 'native_size',
    cloud_disk_body: 'native_body',
    cloud_disk_policy: 'native_policy',
    cloud_disk_client: 'native_client'
  };
  const stages = {
    identity: 'identity',
    list: 'disk',
    download: 'download_content',
    download_link: 'download_link',
    download_content: 'download_content',
    upload_link: 'upload_link',
    upload_content: 'upload_content',
    generate_id: 'file_id',
    create: 'upload_content'
  };
  if (typeof error !== 'string' || !Object.hasOwn(reasons, error) || !Object.hasOwn(stages, operation))
    return undefined;
  return `${stages[operation]}_${reasons[error]}`;
}
