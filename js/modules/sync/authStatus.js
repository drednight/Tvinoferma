// js/modules/sync/authStatus.js
// Единое отображение статуса авторизации персонажа.
// Статус "checking" живёт только в памяти (state.ui.authCheck) и не сохраняется в state.json.

import { state } from '../../core/state.js';
import { DEFAULT_SETTINGS } from '../../core/constants.js';
import { errorText } from '../../core/taskLog.js';
import { mskStamp } from '../../core/msk.js';

export const AUTH_VIEW = {
  online:   { icon: '🟢', color: '#9ece6a', cls: 'is-on',   text: 'Онлайн',     title: 'Аккаунт авторизован' },
  offline:  { icon: '🔴', color: '#f7768e', cls: 'is-off',  text: 'Оффлайн',    title: 'Требуется вход или истекла сессия' },
  checking: { icon: '🟡', color: '#e0af68', cls: 'is-busy', text: 'Проверка…',  title: 'Идёт проверка авторизации' }
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
  // Пометка «проверено …» — по Москве: сессии живут по игровому времени
  return isNaN(d.getTime()) ? '' : mskStamp(d);
};

/**
 * Через сколько времени вход проверяется автоматически: остаток интервала словами.
 * `null` — автопроверка выключена (интервал 0), `0` — пора прямо сейчас.
 * @param {string|null|undefined} iso время последней проверки
 */
export function nextAutoAuthIn(iso, settings, now = Date.now()) {
  const hours = Number(settings?.scripts?.authIntervalHours ?? DEFAULT_SETTINGS.scripts.authIntervalHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (!iso) return 0;                                    // ещё не проверялся: ждать нечего
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 0;
  const left = hours * 3600_000 - (now - at);
  if (left <= 0) return 0;
  const min = Math.ceil(left / 60000);
  if (min < 60) return min;
  return { min, h: Math.round((min / 60) * 10) / 10 };
}

/** «через 2 ч», «через 40 мин», «сейчас». `null` — автопроверки нет. */
export function nextAutoAuthText(iso, settings, now = Date.now()) {
  const left = nextAutoAuthIn(iso, settings, now);
  if (left === null) return '';
  if (left === 0) return 'сейчас';
  if (typeof left === 'number') return `через ${left} мин`;
  const h = left.h;
  return Number.isInteger(h) ? `через ${h} ч` : `через ${h.toFixed(1).replace('.', ',')} ч`;
}

/**
 * Результат последней проверки входа понятным текстом:
 * «Онлайн · проверено 02.10.2026 18:20 · автопроверка через 4 ч».
 */
export function authDetails(char, now = Date.now()) {
  const st = getAuthState(char);
  if (st === 'checking') return 'Проверка…';
  const when = char.lastLoginCheck ? fmtCheck(char.lastLoginCheck) : '';
  const head = AUTH_VIEW[st].text;
  const reason = st === 'offline' && char.lastLoginReason ? `: ${errorText(char.lastLoginReason)}` : '';
  const base = when ? `${head}${reason} · проверено ${when}` : `${head}${reason} · ещё не проверялся`;
  const next = nextAutoAuthText(char.lastLoginCheck, state.settings, now);
  return next ? `${base} · автопроверка ${next}` : base;
}
