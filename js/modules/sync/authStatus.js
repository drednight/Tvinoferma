// js/modules/sync/authStatus.js
// Единое отображение статуса авторизации персонажа.
// Статус "checking" живёт только в памяти (state.ui.authCheck) и не сохраняется в state.json.

import { state } from '../../core/state.js';
import { errorText } from '../../core/taskLog.js';

export const AUTH_VIEW = {
  online:   { icon: '🟢', color: '#9ece6a', text: 'Онлайн',     title: 'Аккаунт авторизован' },
  offline:  { icon: '🔴', color: '#f7768e', text: 'Оффлайн',    title: 'Требуется вход или истекла сессия' },
  checking: { icon: '🟡', color: '#e0af68', text: 'Проверка…',  title: 'Идёт проверка авторизации' }
};

export function getAuthState(char) {
  if (state.ui?.authCheck?.[char.id] === 'checking') return 'checking';
  return char.isLoggedIn === true ? 'online' : 'offline';
}

export function getAuthView(char) {
  return AUTH_VIEW[getAuthState(char)];
}

export function setAuthChecking(charId, isChecking) {
  if (!state.ui.authCheck) state.ui.authCheck = {};
  if (isChecking) state.ui.authCheck[charId] = 'checking';
  else delete state.ui.authCheck[charId];
}

const fmtCheck = (iso) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
};

/**
 * Результат последней проверки входа понятным текстом:
 * «Онлайн · проверено 02.10.2026 18:20» / «Оффлайн: не выполнен вход на сайт · проверено …» / «ещё не проверялся».
 */
export function authDetails(char) {
  const st = getAuthState(char);
  if (st === 'checking') return 'Проверка…';
  const when = char.lastLoginCheck ? fmtCheck(char.lastLoginCheck) : '';
  const head = AUTH_VIEW[st].text;
  const reason = st === 'offline' && char.lastLoginReason ? `: ${errorText(char.lastLoginReason)}` : '';
  return when ? `${head}${reason} · проверено ${when}` : `${head}${reason} · ещё не проверялся`;
}
