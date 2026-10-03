// Действия панели «Помощник входа» (Issue #54-2): окно браузера персонажа просит основное окно
// выполнить действие. Страница не получает доступа к командам Tauri: Rust перехватывает переход на
// `tf-panel://<действие>` и шлёт событие `panel-action` { charId, action } (charId берётся из окна,
// а не из страницы). Список действий закрыт, параметров нет.

import { state } from '../core/state.js';
import { formatCoins } from '../core/coins.js';
import { partiesOf, charactersInParty, coinSummary, isMainParty } from '../modules/parties/membership.js';

export const PANEL_ACTIONS = ['balance', 'parties', 'promo'];

const busy = new Set();

/** Текст «Статус партий» для персонажа: по строке на каждую его партию (★ — основная). */
export function partyStatusText(char, parties, chars) {
  const own = partiesOf(char, parties);
  if (!own.length) return 'Персонаж без пати';
  const { perParty } = coinSummary(parties, chars);
  return own.map((p) => {
    const members = charactersInParty(chars, p.id);
    const online = members.filter((m) => m.isLoggedIn === true).length;
    return `${isMainParty(char, p.id) ? '★ ' : ''}${p.name}: ${members.length} акк., 🟢 ${online}, 💰 ${formatCoins(perParty[p.id] || 0)}`;
  }).join('\n');
}

/** Скрипт, который показывает текст в панели окна персонажа. */
export function notifyScript(text) {
  const detail = JSON.stringify({ text: String(text) }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `(function(){var h=document.getElementById('__tf_login_panel__');`
    + `if(h)h.dispatchEvent(new CustomEvent('tf-panel-notify',{detail:${detail}}));})();`;
}

async function defaultDeps() {
  const { invoke } = await import('@tauri-apps/api/core');
  const sync = await import('../modules/sync/syncManager.js');
  return {
    notify: (charId, text) => invoke('execute_script_in_window', { label: `sync-win-${charId}`, script: notifyScript(text) }),
    // Сессия в банке кук нужна, чтобы баланс читался в фоновом окне, а не в окне, где пользователь вводит данные
    hasSession: async (charId) => (await invoke('bank_status')).some((r) => r.charId === charId && !r.error),
    isChecking: sync.isCheckInProgress,
    refreshBalance: sync.refreshBalanceFor
  };
}

/**
 * @param {{ charId: string, action: string }} payload
 * @param {Awaited<ReturnType<typeof defaultDeps>>} [deps]
 */
export async function handlePanelAction(payload, deps) {
  const { charId, action } = payload || {};
  const char = (state.characters || []).find((c) => c.id === charId);
  if (!char || !PANEL_ACTIONS.includes(action)) return;
  const d = deps || await defaultDeps();
  const say = (text) => Promise.resolve(d.notify(charId, text)).catch(() => { /* окно уже закрыто */ });

  if (action === 'parties') return say(partyStatusText(char, state.parties, state.characters));
  if (action === 'promo') return say('Активация промокодов появится вместе с Issue #25.');

  // balance
  if (busy.has(charId) || d.isChecking(charId)) return say('⏳ Для этого персонажа уже идёт проверка. Подождите.');
  const hasSession = await Promise.resolve(d.hasSession(charId)).catch(() => false);
  if (!hasSession) {
    return say('Сессия ещё не сохранена в приложении. Закройте это окно, нажмите «Проверить авторизацию» и повторите.');
  }
  busy.add(charId);
  try {
    await say('⏳ Запрашиваю баланс…');
    const res = await d.refreshBalance(char);
    await say(res?.failed || res?.cancelled
      ? '⚠️ Баланс получить не удалось. Подробности в журнале приложения.'
      : `💰 Древние монеты: ${formatCoins(char.ancientCoins)}`);
  } catch {
    await say('⚠️ Баланс получить не удалось. Подробности в журнале приложения.');
  } finally {
    busy.delete(charId);
  }
}

export async function initPanelActions() {
  const { listen } = await import('@tauri-apps/api/event');
  await listen('panel-action', (e) => handlePanelAction(e.payload).catch((err) => console.warn('[PANEL]', err)));
}
