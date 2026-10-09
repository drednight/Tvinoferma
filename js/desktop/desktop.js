// js/desktop/desktop.js
// Трей, фоновые проверки и горячие клавиши.

import { state } from '../core/state.js';
import { toast } from '../core/ui.js';
import { startCollectionSync } from '../modules/automation/collectionSync.js';
import { launchablePartyNames, decorateNotice, hasGameCenterPath } from '../modules/launcher/launch.js';
import { charactersInParty } from '../modules/parties/membership.js';

export const HOTKEYS = [
  { keys: 'Ctrl+K', text: 'Командная палитра: команды, персонажи, пати' },
  { keys: 'Ctrl+1…6', text: 'Разделы: Сегодня / Персонажи / Пати / Марафоны / Руны / Настройки' },
  { keys: 'Ctrl+F', text: 'Поиск по нику' },
  { keys: 'Ctrl+N', text: 'Новый персонаж / пати (как кнопка «+»)' },
  { keys: 'Ctrl+S', text: 'Сохранить сейчас' },
  { keys: 'Ctrl+Shift+A', text: 'Проверить авторизацию' },
  { keys: 'Ctrl+Shift+B', text: 'Обновить балансы' },
  { keys: 'Ctrl+Shift+M', text: 'Обновить марафоны' },
  { keys: 'Ctrl+A', text: 'В режиме выбора — выбрать всех по фильтру' },
  { keys: 'Esc', text: 'Закрыть окно / выйти из режима выбора' }
];

let backgroundTimer = null;
let backgroundChecking = false;

async function runScript(action) {
  if (typeof action === 'string' && action.startsWith('launch-favorite:')) {
    const id = action.slice('launch-favorite:'.length);
    const character = state.characters.find(c => String(c.id) === id);
    const { launchOne } = await import('../modules/launcher/partyLaunch.js');
    return launchOne(character, { interactive: false });
  }
  if (typeof action === 'string' && action.startsWith('launch-party:')) {
    const { launchPartyByName } = await import('../modules/launcher/partyLaunch.js');
    return launchPartyByName(action.slice('launch-party:'.length), { interactive: false });
  }
  if (action === 'promo') {
    const { openPromoDialog } = await import('../modules/automation/promo.js');
    return openPromoDialog();
  }
  if (action === 'transfer') {
    const { openTransferDialog } = await import('../modules/automation/transfer.js');
    return openTransferDialog();
  }
  if (action === 'shop') {
    const { openShopDialog } = await import('../modules/automation/shop.js');
    return openShopDialog();
  }
  if (action === 'game-windows') {
    const { openWindowPicker } = await import('../modules/launcher/windowPicker.js');
    return openWindowPicker();
  }
  if (action === 'caravan') {
    const { openCaravanDialog } = await import('../modules/automation/caravan.js');
    return openCaravanDialog();
  }
  const sync = await import('../modules/sync/syncManager.js');
  if (action === 'check-auth') return sync.refreshAllLoginStatuses();
  if (action === 'update-balance') return sync.refreshAllBalances();
  if (action === 'update-marathons') return sync.refreshAllMarathonStats();
}

function isTyping(e) {
  const el = e.target;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function initHotkeys({ switchTab }) {
  document.addEventListener('keydown', async (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const key = e.key.toLowerCase();
    const modalOpen = !!document.querySelector('.modal-overlay');
    // Палитра — единственное сочетание, которое работает и при открытом окне:
    // она нужна как раз тогда, когда пользователь уже что-то открыл
    const { isPaletteOpen, openCommandPalette } = await import('../core/commandPalette.js');

    if (!e.shiftKey && (key === 'k' || key === 'л')) {
      e.preventDefault();
      if (isPaletteOpen()) return;
      const { createCommandRunner } = await import('../core/commandRunner.js');
      openCommandPalette({ switchTab, run: createCommandRunner({ switchTab }) });
      return;
    }

    if (!e.shiftKey && ['1', '2', '3', '4', '5', '6'].includes(key) && !modalOpen) {
      e.preventDefault();
      switchTab(['today', 'characters', 'parties', 'marathons', 'runes', 'settings'][Number(key) - 1]);
    } else if (!e.shiftKey && (key === 'f' || key === 'а') && !modalOpen) {
      e.preventDefault();
      switchTab('characters');
      document.getElementById('search-input')?.focus();
    } else if (!e.shiftKey && (key === 'n' || key === 'т') && !modalOpen) {
      e.preventDefault();
      document.getElementById('fab-main-btn')?.click();
    } else if (!e.shiftKey && (key === 's' || key === 'ы')) {
      e.preventDefault();
      const { saveNow } = await import('../core/storage.js');
      await saveNow();
      toast('Сохранено', 'success');
    } else if (!e.shiftKey && (key === 'a' || key === 'ф') && state.ui.selectionMode && !isTyping(e)) {
      e.preventDefault();
      const { selectAllVisible } = await import('../modules/characters/list.js');
      selectAllVisible();
    } else if (e.shiftKey && !modalOpen) {
      const action = { a: 'check-auth', ф: 'check-auth', b: 'update-balance', и: 'update-balance', m: 'update-marathons', ь: 'update-marathons' }[key];
      if (action) { e.preventDefault(); runScript(action); }
    }
  });
}

/** Синхронизировать настройку «сворачивать в трей» с Rust и перезапустить фоновые проверки. */
export async function applyDesktopSettings() {
  const tray = state.settings?.tray || {};
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_close_to_tray', { enabled: !!tray.closeToTray });
    } catch (e) { console.warn('[TRAY]', e); }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_unlimited_items', { enabled: state.settings?.browser?.unlimitedGiftItems !== false });
    } catch (e) { console.warn('[BROWSER]', e); }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_collection_panel', { enabled: state.settings?.browser?.collectionPanel !== false });
    } catch (e) { console.warn('[BROWSER]', e); }
    startCollectionSync(state.settings?.browser?.collectionPanel !== false);
  }

  if (backgroundTimer) { clearInterval(backgroundTimer); backgroundTimer = null; }
  const minutes = Number(tray.backgroundAuthMinutes) || 0;
  if (minutes > 0 && window.__TAURI_INTERNALS__) {
    backgroundTimer = setInterval(async () => {
      // Пачка может идти дольше интервала. Не копим новые пачки и не мешаем ручной проверке.
      if (backgroundChecking || Object.keys(state.ui?.authCheck || {}).length) return;
      backgroundChecking = true;
      try {
        const { authCheckCandidates, verifySavedLoginsOnStartup } = await import('../modules/sync/syncManager.js');
        // Фоновый таймер может быть короче интервала автопроверки. Без этой проверки он
        // будил бы задачу вхолостую: запускал очередь и тут же выходил, не проверив никого.
        if (!authCheckCandidates().length) return;
        await verifySavedLoginsOnStartup({ title: '🔐 Фоновая проверка входа', quiet: true });
      } catch (e) { console.warn('[BACKGROUND AUTH]', e); }
      finally { backgroundChecking = false; }
    }, minutes * 60 * 1000);
  }
}

let trayPartiesKey = null;

/** Меню трея «🎮 Запустить пати»: только пати, где есть персонажи с путём к GameCenter. Обновляется при каждом сохранении. */
export async function syncTrayParties() {
  if (!window.__TAURI_INTERNALS__) return;
  const names = launchablePartyNames(state.parties, state.characters, charactersInParty);
  const favorites = state.characters
    .filter(c => c.favorite === true && hasGameCenterPath(c))
    .map(c => `${c.id}\u001f${c.nick}`);
  const key = JSON.stringify([names, favorites]);
  if (key === trayPartiesKey) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_tray_parties', { names, favorites });
    trayPartiesKey = key;
  } catch (e) { console.warn('[TRAY]', e); }
}

export async function initDesktop() {
  if (!window.__TAURI_INTERNALS__) return;
  const { listen } = await import('@tauri-apps/api/event');
  await listen('tray-action', (e) => runScript(e.payload));
  // «🛑 Закрыть все окна игры» в трее закрывает окна в Rust и присылает отчёт
  await listen('game-closed', async (e) => {
    const { showCloseReport } = await import('../modules/launcher/partyLaunch.js');
    showCloseReport(e.payload);
  });
  // Окно игры подписывается уже после запуска; если не вышло (например, игра от администратора) — говорим почему, один раз за сеанс
  const told = new Set();
  await listen('launcher-decorate', (e) => {
    const text = decorateNotice(e.payload);
    if (!text || told.has(e.payload.status)) return;
    told.add(e.payload.status);
    toast(text, 'error', 15000);
  });
  window.addEventListener('tf-persisted', () => { syncTrayParties(); });
  await applyDesktopSettings();
  await syncTrayParties();
}
