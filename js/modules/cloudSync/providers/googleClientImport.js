// @ts-check
// Local diagnostics only. Never return/log JSON contents, secrets or imported URLs.
import { validOAuthClientId } from './oauthCommon.js';
export function googleClientImportProblem(raw) {
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return 'json_syntax';
  }
  if (data?.web) return 'web_client';
  if (!data?.installed || typeof data.installed !== 'object' || Array.isArray(data.installed)) return 'not_desktop';
  if (!validOAuthClientId('google', data.installed.client_id)) return 'client_id';
  const secret = data.installed.client_secret;
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(secret)) return 'client_secret';
  return null;
}
export const GOOGLE_IMPORT_MESSAGES = Object.freeze({
  json_syntax: 'Файл не является корректным JSON. Заново скачайте OAuth JSON клиента Desktop из Google Cloud.',
  web_client: 'Это OAuth-клиент Web. Нужен клиент типа Desktop app; переименовывать поле web в installed нельзя.',
  not_desktop:
    'Нужен OAuth JSON клиента Desktop с разделом installed. Firebase, service account и файл данных приложения сюда не подходят.',
  client_id: 'В разделе installed отсутствует корректный Google client_id. Скачайте исходный Desktop JSON заново.',
  client_secret:
    'В разделе installed отсутствует корректный client_secret. Выберите исходный Desktop JSON, без ручного редактирования.',
  oauth_client_config_invalid:
    'Native-проверка отклонила структуру JSON. Скачайте исходный файл Desktop заново; не меняйте поля вручную.',
  oauth_client_config_blocked:
    'Импорт остановлен: существующий вход заблокирован или обновление доступа не подтверждено. Ключи и файлы не удаляйте.',
  oauth_client_config_client_changed:
    'Этот JSON относится к другому OAuth-приложению. Существующий вход не заменён. Выберите JSON прежнего Desktop-клиента.',
  oauth_client_config_unavailable:
    'Windows не подтвердил сохранение настроек Google. Дождитесь завершения операций и повторите импорт. Записи вручную не удаляйте.'
});
