// js/authStatus.js
// Единое отображение статуса авторизации персонажа.
// Статус "checking" живёт только в памяти (state.ui.authCheck) и не сохраняется в state.json.

import { state } from './state.js';

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
