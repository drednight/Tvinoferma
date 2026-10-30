// @ts-check
// Общие неизменяемые параметры предварительного OAuth desktop-клиента.
// Клиентские ID выдаются провайдерами и не являются секретом; сами ID здесь не заданы.
export const OAUTH_CALLBACK_PATH = '/oauth/cloud/callback';
// Предварительный адрес для регистрации desktop-клиента Яндекса. Работа с реальным
// сервисом ещё не проверена; занятый порт нельзя молча заменить другим.
export const YANDEX_OAUTH_CALLBACK_PORT = 37181;
export const OAUTH_PROVIDERS = Object.freeze({
  google: Object.freeze({
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive.file'
  }),
  yandex: Object.freeze({
    authorize: 'https://oauth.yandex.com/authorize',
    token: 'https://oauth.yandex.com/token',
    scope: 'cloud_api:disk.app_folder'
  })
});

/** @param {unknown} provider @param {unknown} clientId */
export function validOAuthClientId(provider, clientId) {
  if (typeof clientId !== 'string' || /[^\x21-\x7e]/.test(clientId)) return false;
  if (provider === 'google') return /^[A-Za-z0-9_-]{3,200}\.apps\.googleusercontent\.com$/.test(clientId);
  if (provider === 'yandex') return /^[A-Za-z0-9_-]{16,128}$/.test(clientId);
  return false;
}

/**
 * Консервативный формат непрозрачных Google Drive permissionId / Яндекс psuid; не email и
 * не доказательство аккаунта. Совместимость с реальными ответами ещё проверяется.
 * @param {unknown} value
 */
export function validOAuthAccountKey(value) {
  return typeof value === 'string' && !/[^\x21-\x7e]/.test(value) && /^[A-Za-z0-9._~-]{1,256}$/.test(value);
}

/** Консервативная проверка единственного локального redirect; не доказывает его регистрацию. */
export function validOAuthRedirect(value) {
  if (typeof value !== 'string' || /[^\x21-\x7e]/.test(value)) return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/cloud\/callback$/.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1024 && port <= 65535;
}
