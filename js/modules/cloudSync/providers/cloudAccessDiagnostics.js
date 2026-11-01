// @ts-check
// Only fixed, non-personal stage codes. No response, exception text, URL or token.
// WeakMap metadata never enters durable queues or serialized IPC payloads.
const codes = new Set(
  [
    'refresh',
    'identity',
    'disk',
    'folder',
    'upload_link',
    'upload_content',
    'download_link',
    'download_content',
    'file_id',
    'verification'
  ].flatMap(stage =>
    [
      'oauth_invalid_client',
      'oauth_invalid_grant',
      'oauth_client_secret_required',
      'oauth_rejected',
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
      'native_redirect_format',
      'native_redirect_host',
      'native_redirect_host_authority',
      'native_redirect_host_storage_case',
      'native_redirect_host_storage_shape',
      'native_redirect_host_disk_net',
      'native_redirect_host_disk_ru',
      'native_redirect_host_yandex_net',
      'native_redirect_host_yandex_ru',

      'native_redirect_path',
      'native_redirect_headers',
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
  refresh: 'Обновление доступа Google',
  identity: 'Сверка аккаунта',
  disk: 'Чтение списка файлов',
  folder: 'Папка Яндекс Диска',
  upload_link: 'Получение ссылки отправки',
  upload_content: 'Отправка содержимого',
  download_link: 'Получение ссылки скачивания',
  download_content: 'Скачивание для сверки',
  file_id: 'Выделение ID файла',
  verification: 'Сверка отправленного файла'
};
const REASONS = {
  oauth_invalid_client: 'сервис отклонил настройки OAuth-клиента; нужна проверка Desktop JSON того же приложения',
  oauth_invalid_grant: 'сервис отклонил refresh-токен; нужен новый вход в прежний аккаунт',
  oauth_client_secret_required:
    'не найден обязательный client_secret; восстановите Desktop JSON прежнего клиента локально',
  oauth_rejected: 'сервис отклонил обновление доступа; результат нельзя повторять автоматически',
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
  native_redirect_format: 'формат подписанного перенаправления не прошёл проверку (HTTPS, длина или кодирование)',
  native_redirect_host: 'хост перенаправления не входит в разрешённое семейство серверов хранения Яндекса',
  native_redirect_host_authority:
    'адрес перенаправления содержит запрещённые данные авторизации или нестандартный порт',
  native_redirect_host_storage_case:
    'семейство storage.yandex.net распознано, но регистр имени сервера не соответствует политике',
  native_redirect_host_storage_shape:
    'семейство storage.yandex.net распознано, но форма имени узла хранения не соответствует политике',
  native_redirect_host_disk_net:
    'перенаправление ведёт в семейство disk.yandex.net, а не на разрешённый узел storage.yandex.net',
  native_redirect_host_disk_ru:
    'перенаправление ведёт в семейство disk.yandex.ru, а не на разрешённый узел storage.yandex.net',
  native_redirect_host_yandex_net: 'перенаправление ведёт в другое подсемейство yandex.net; переход не разрешён',
  native_redirect_host_yandex_ru: 'перенаправление ведёт в другое подсемейство yandex.ru; переход не разрешён',
  native_redirect_path: 'путь перенаправления не соответствует безопасной ссылке хранилища Яндекса',
  native_redirect_headers: 'сервис прислал отсутствующий, повторный или некорректный заголовок перенаправления',
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
    cloud_disk_redirect_format: 'native_redirect_format',
    cloud_disk_redirect_host: 'native_redirect_host',
    cloud_disk_redirect_host_authority: 'native_redirect_host_authority',
    cloud_disk_redirect_host_storage_case: 'native_redirect_host_storage_case',
    cloud_disk_redirect_host_storage_shape: 'native_redirect_host_storage_shape',
    cloud_disk_redirect_host_disk_net: 'native_redirect_host_disk_net',
    cloud_disk_redirect_host_disk_ru: 'native_redirect_host_disk_ru',
    cloud_disk_redirect_host_yandex_net: 'native_redirect_host_yandex_net',
    cloud_disk_redirect_host_yandex_ru: 'native_redirect_host_yandex_ru',

    cloud_disk_redirect_path: 'native_redirect_path',
    cloud_disk_redirect_headers: 'native_redirect_headers',
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
    identity_preview: 'identity',
    folder_create: 'folder',
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

// Only fixed native OAuth reasons; never provider descriptions or raw errors.
export function googleRefreshDiagnostic(code) {
  const reasons = {
    invalid_client: 'oauth_invalid_client',
    invalid_grant: 'oauth_invalid_grant',
    client_secret_required: 'oauth_client_secret_required',
    timeout: 'timeout',
    connection_failed: 'native_connect',
    busy: 'native_busy',
    server_error: 'service_unavailable',
    network_failed: 'transport_unavailable',
    transport_failed: 'transport_unavailable',
    rate_limited: 'rate_limited',
    response_invalid: 'invalid_response',
    invalid_request: 'oauth_rejected',
    unauthorized_client: 'oauth_rejected',
    invalid_scope: 'oauth_rejected',
    access_denied: 'oauth_rejected',
    http_400: 'oauth_rejected',
    http_401: 'unauthorized',
    http_403: 'forbidden',
    http_rejected: 'oauth_rejected'
  };
  return typeof code === 'string' && Object.hasOwn(reasons, code) ? `refresh_${reasons[code]}` : undefined;
}
