// js/desktop/desktop.js
// Трей, фоновые проверки и горячие клавиши.

import { state } from '../core/state.js';
import { toast } from '../core/ui.js';

export const HOTKEYS = [
  { keys: 'Ctrl+1…4', text: 'Вкладки: Персонажи / Пати / Марафоны / Настройки' },
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

async function runScript(action) {
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

    if (!e.shiftKey && ['1', '2', '3', '4'].includes(key) && !modalOpen) {
      e.preventDefault();
      switchTab(['characters', 'parties', 'marathons', 'settings'][Number(key) - 1]);
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
  }

  if (backgroundTimer) { clearInterval(backgroundTimer); backgroundTimer = null; }
  const minutes = Number(tray.backgroundAuthMinutes) || 0;
  if (minutes > 0 && window.__TAURI_INTERNALS__) {
    backgroundTimer = setInterval(async () => {
      const { verifySavedLoginsOnStartup } = await import('../modules/sync/syncManager.js');
      verifySavedLoginsOnStartup({ title: '🔐 Фоновая проверка входа', quiet: true })
        .catch(e => console.warn('[BACKGROUND AUTH]', e));
    }, minutes * 60 * 1000);
  }
}

export async function initDesktop() {
  if (!window.__TAURI_INTERNALS__) return;
  const { listen } = await import('@tauri-apps/api/event');
  await listen('tray-action', (e) => runScript(e.payload));
  const { initPanelActions } = await import('./panelActions.js');
  await initPanelActions();
  await applyDesktopSettings();
}
