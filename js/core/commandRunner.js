// js/core/commandRunner.js
// Что делают команды командной палитры (Ctrl+K). Действия вынесены отдельно от показа палитры,
// чтобы палитра оставалась «тонкой» и не разрасталась зависимостями.
//
// Все обработчики ленивые (динамический импорт): палитра открывается по Ctrl+K, и тянуть в неё
// весь набор модулей приложения при старте не нужно.

import { state } from './state.js';
import { toast } from './ui.js';

const errText = (e) => String(e?.message || e || 'неизвестная ошибка');

/**
 * Создаёт исполнитель команд палитры.
 * @param {{ switchTab: (tab: string) => void }} deps
 * @returns {(action: string, payload?: any) => Promise<void>}
 */
export function createCommandRunner({ switchTab }) {
  return async function run(action, payload) {
    try {
      switch (action) {
        case 'open-character': {
          const char = state.characters.find(c => c.id === payload);
          if (!char) { toast('Персонаж не найден', 'error'); return; }
          const { openCharacterProfile } = await import('../modules/characters/profileView.js');
          openCharacterProfile(char);
          return;
        }
        case 'new-character': {
          switchTab('characters');
          const { openCharacterForm } = await import('../modules/characters/index.js');
          openCharacterForm(null);
          return;
        }
        case 'new-party': {
          switchTab('parties');
          const { openCreatePartyModal } = await import('../modules/parties/manager.js');
          openCreatePartyModal();
          return;
        }
        case 'new-marathon': {
          switchTab('marathons');
          const { createMarathonFromFab } = await import('../modules/marathons/page.js');
          createMarathonFromFab();
          return;
        }
        case 'open-party': {
          // Отдельного экрана пати нет: пати живут карточками в своём разделе
          switchTab('parties');
          const party = state.parties.find(p => p.id === payload);
          if (party) setTimeout(() => {
            const card = [...document.querySelectorAll('.pt-card')].find(el => el.dataset.partyName === party.name);
            card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, 60);
          return;
        }
        case 'open-marathon': {
          switchTab('marathons');
          const { openMarathon } = await import('../modules/marathons/page.js');
          openMarathon(payload);
          return;
        }
        case 'check-auth': {
          const { refreshAllLoginStatuses } = await import('../modules/sync/syncManager.js');
          await refreshAllLoginStatuses();
          return;
        }
        case 'check-auth-one': {
          const char = state.characters.find(c => c.id === payload);
          if (!char) { toast('Персонаж не найден', 'error'); return; }
          const { refreshAllLoginStatuses } = await import('../modules/sync/syncManager.js');
          await refreshAllLoginStatuses([char]);
          return;
        }
        case 'update-balance': {
          const { refreshAllBalances } = await import('../modules/sync/syncManager.js');
          await refreshAllBalances();
          return;
        }
        case 'balance-one': {
          const char = state.characters.find(c => c.id === payload);
          if (!char) { toast('Персонаж не найден', 'error'); return; }
          const { refreshAllBalances } = await import('../modules/sync/syncManager.js');
          await refreshAllBalances([char]);
          return;
        }
        case 'update-marathons': {
          const { refreshAllMarathonStats } = await import('../modules/sync/syncManager.js');
          await refreshAllMarathonStats();
          return;
        }
        case 'launch-one': {
          const char = state.characters.find(c => c.id === payload);
          if (!char) { toast('Персонаж не найден', 'error'); return; }
          const { launchOne } = await import('../modules/launcher/partyLaunch.js');
          await launchOne(char);
          return;
        }
        case 'launch-party': {
          const { launchPartyByName } = await import('../modules/launcher/partyLaunch.js');
          await launchPartyByName(payload);
          return;
        }
        case 'close-party': {
          const { closePartyWindows } = await import('../modules/launcher/partyLaunch.js');
          await closePartyWindows(payload);
          return;
        }
        case 'close-game': {
          const { closeAllGameWindows } = await import('../modules/launcher/partyLaunch.js');
          await closeAllGameWindows({ confirm: true });
          return;
        }
        case 'windows': {
          const { openWindowPicker } = await import('../modules/launcher/windowPicker.js');
          await openWindowPicker();
          return;
        }
        case 'promo': {
          const { openPromoDialog } = await import('../modules/automation/promo.js');
          openPromoDialog();
          return;
        }
        case 'transfer': {
          const { openTransferDialog } = await import('../modules/automation/transfer.js');
          openTransferDialog();
          return;
        }
        case 'save': {
          const { saveNow } = await import('./storage.js');
          await saveNow();
          toast('Сохранено', 'success');
          return;
        }
        case 'backup': {
          switchTab('settings');
          const { saveNow, createBackup } = await import('./storage.js');
          await saveNow();
          const name = await createBackup();
          toast(`Бэкап создан: ${name}`, 'success');
          return;
        }
        case 'export': {
          switchTab('settings');
          const { loadData } = await import('./storage.js');
          const data = await loadData();
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `tvinoferma-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
          a.click();
          URL.revokeObjectURL(url);
          toast('Экспорт выполнен', 'success');
          return;
        }
        case 'import': {
          switchTab('settings');
          document.getElementById('import-file')?.click();
          return;
        }
        case 'check-updates': {
          switchTab('settings');
          const { checkForUpdates } = await import('../desktop/updater.js');
          await checkForUpdates();
          return;
        }
        default:
          console.warn('[CMD] неизвестная команда:', action);
      }
    } catch (e) {
      console.error('[CMD]', action, e);
      toast(`Не удалось выполнить: ${errText(e)}`, 'error');
    }
  };
}
