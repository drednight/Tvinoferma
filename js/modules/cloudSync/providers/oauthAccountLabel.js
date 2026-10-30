// @ts-check
// Консервативный формат меток для будущего подтверждения аккаунта.
// Это личные данные только для показа пользователю: не логировать, не записывать
// в состояние, облачный снимок или журнал. Метка не заменяет стабильный accountKey.
import { object } from '../exportSchema.js';

function invalid() {
  return new Error('Не удалось безопасно показать выбранную учётную запись');
}

/** Допускаем только однозначно отображаемый ASCII-вариант; другие не исправляем. */
export function validGoogleAccountEmail(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 254) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    domain.length > 253
  )
    return false;
  const labels = domain.split('.');
  return (
    labels.length >= 2 &&
    labels.every(part => part.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part))
  );
}

/** Логин Яндекса показывается ровно как получен, не как догадка о почте. */
export function validYandexAccountLogin(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value);
}

/**
 * Снимок display-метки без getters/лишних полей; не является подтверждением того,
 * что пользователь узнал аккаунт. null означает, что метки нет, а не пустой логин.
 * @param {'google'|'yandex'} provider
 * @param {unknown} label
 */
export function copyOAuthAccountLabel(provider, label) {
  if (label === null) return null;
  try {
    const value = object(label, ['kind', 'value']);
    if (!(
      (provider === 'google' && value.kind === 'email' && validGoogleAccountEmail(value.value)) ||
      (provider === 'yandex' && value.kind === 'login' && validYandexAccountLogin(value.value))
    ))
      throw invalid();
    return Object.freeze({ kind: value.kind, value: value.value });
  } catch {
    throw invalid();
  }
}
