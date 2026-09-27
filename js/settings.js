// js/settings.js

import { getAdapter, saveNow, forceRenderAndPersist } from './storage.js'; 
import { state, serializeState, normalizeState } from './state.js';
import { persist } from './storage.js';
import { escapeHtml, nowISO } from './utils.js';
import { toast, confirmDialog, showModal } from './ui.js';
import { renderCharacters } from './characters.js';
import { renderParties } from './parties.js';
import { renderMarathons } from './marathon.js';
import { openExportDialog } from './exportManager.js'; // <-- НОВЫЙ ИМПОРТ

async function refreshBackups() {
  const adapter = getAdapter();
  const listEl = document.getElementById('backup-list');
  if (!adapter || !listEl) return;

  try {
    const backups = await adapter.listBackups();
    listEl.innerHTML = backups.length
      ? backups.map((name) => `
          <div class="backup-item">
            <div class="meta"><strong>${escapeHtml(name)}</strong></div>
            <div class="row gap">
              <button class="btn" data-backup-restore="${escapeHtml(name)}">Восстановить</button>
              <button class="btn danger" data-backup-delete="${escapeHtml(name)}">Удалить</button>
            </div>
          </div>
        `).join('')
      : '<div class="empty-state">Нет резервных копий.</div>';
  } catch (error) {
    listEl.innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(error.message || error)}</div>`;
  }
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function applyImport(incoming, mode) {
  const parsed = normalizeState(incoming);

  if (mode === 'replace') {
    state.parties = parsed.parties;
    state.characters = parsed.characters;
    state.marathons = parsed.marathons;
    state.settings = parsed.settings;
  } else if (mode === 'addOnly') {
     const existingPartyNames = new Set(state.parties.map(p => p.name));
     parsed.parties.forEach(p => { if(!existingPartyNames.has(p.name)) state.parties.push(p); });
     
     const existingCharIds = new Set(state.characters.map(c => c.id));
     parsed.characters.forEach(c => { if(!existingCharIds.has(c.id)) state.characters.push(c); });
     
     const existingMarathonIds = new Set(state.marathons.map(m => m.id));
     parsed.marathons.forEach(m => { if(!existingMarathonIds.has(m.id)) state.marathons.push(m); });
  } else if (mode === 'mergeLWW') {
     const charMap = new Map(state.characters.map(c => [c.id, c]));
     parsed.characters.forEach(c => {
       const local = charMap.get(c.id);
       if (!local || new Date(c.updatedAt) > new Date(local.updatedAt)) {
         charMap.set(c.id, { ...c, coinHistory: [] });
       }
     });
     state.characters = Array.from(charMap.values());
     
     const partyMap = new Map(state.parties.map(p => [p.name, p]));
     parsed.parties.forEach(p => {
       const local = partyMap.get(p.name);
       if (!local || new Date(p.updatedAt) > new Date(local.updatedAt)) {
         partyMap.set(p.name, p);
       }
     });
     state.parties = Array.from(partyMap.values());
     
     const marathonMap = new Map(state.marathons.map(m => [m.id, m]));
     parsed.marathons.forEach(m => {
       const local = marathonMap.get(m.id);
       if (!local || new Date(m.updatedAt) > new Date(local.updatedAt)) {
         marathonMap.set(m.id, m);
       }
     });
     state.marathons = Array.from(marathonMap.values());
  }

  // ВАЖНО: Используем forceRenderAndPersist для полного обновления UI после импорта
  forceRenderAndPersist().then(() => {
    toast('Импорт завершён', 'success');
  });
}

export async function renderSettings() {
  const adapter = getAdapter();
  
  // Защита: если адаптера нет, выходим тихо или пишем заглушку
  if (!adapter) {
     const runtimeEl = document.getElementById('storage-runtime');
     if(runtimeEl) runtimeEl.textContent = 'Недоступно (нет адаптера)';
     return;
  }

  // Runtime info
  const isTauri = window.__TAURI_INTERNALS__ || window.__TAURI__;
  const runtimeEl = document.getElementById('storage-runtime');
  if (runtimeEl) {
    runtimeEl.textContent = isTauri ? 'Tauri Desktop (Локальный файл)' : 'Browser (LocalStorage)';
  }

  // Data Dir
  const dirEl = document.getElementById('data-dir');
  if (dirEl) {
    try {
      const dir = await adapter.getDataDir();
      dirEl.textContent = dir;
    } catch {
      dirEl.textContent = 'Недоступно';
    }
  }

  // Backups
  await refreshBackups();
}

export function bindSettings() {
  // Save Now
  document.getElementById('save-now-btn')?.addEventListener('click', async () => {
    await saveNow();
    toast('Сохранено', 'success');
  });

  // Create Backup
  document.getElementById('create-backup-btn')?.addEventListener('click', async () => {
    const adapter = getAdapter();
    if (!adapter) return;
    try {
      const name = await adapter.createBackup();
      toast(`Бэкап создан: ${name}`, 'success');
      await refreshBackups();
    } catch (e) {
      toast(`Ошибка: ${e.message}`, 'error');
    }
  });

  // Refresh Backups
  document.getElementById('refresh-backups-btn')?.addEventListener('click', refreshBackups);

  // Backup Actions (Delegate)
  document.getElementById('backup-list')?.addEventListener('click', async (e) => {
    const restoreBtn = e.target.closest('[data-backup-restore]');
    const deleteBtn = e.target.closest('[data-backup-delete]');
    const adapter = getAdapter();
    if (!adapter) return;

    if (restoreBtn) {
      const name = restoreBtn.dataset.backupRestore;
      if (confirmDialog(`Восстановить из ${name}?`)) {
        try {
          await adapter.restoreBackup(name);
          window.location.reload();
        } catch (err) {
          toast(`Ошибка восстановления: ${err.message}`, 'error');
        }
      }
    }

    if (deleteBtn) {
      const name = deleteBtn.dataset.backupDelete;
      if (confirmDialog(`Удалить бэкап ${name}?`)) {
        try {
          await adapter.deleteBackup(name);
          toast('Удалено', 'success');
          await refreshBackups();
        } catch (err) {
          toast(`Ошибка удаления: ${err.message}`, 'error');
        }
      }
    }
  });

  // Export All (Старый быстрый экспорт всего JSON)
  document.getElementById('export-all-btn')?.addEventListener('click', async () => {
    await saveNow();
    const data = serializeState();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJson(data, `tvinoferma-export-${stamp}.json`);
    toast('Экспорт выполнен', 'success');
  });

  // NEW: Advanced Export Button (Гибкий экспорт с выбором полей)
  document.getElementById('advanced-export-btn')?.addEventListener('click', () => {
    openExportDialog();
  });

  // Import File
    // Import File
  document.getElementById('import-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      showModal({
        title: 'Режим импорта данных',
        content: `
          <div class="form-grid">
            <p class="muted" style="margin-bottom:10px;">Выберите стратегию слияния данных:</p>
            
            <label class="field radio-option" style="display:flex; align-items:center; gap:8px; padding:8px; border:1px solid var(--border); border-radius:4px; margin-bottom:8px; cursor:pointer;">
              <input type="radio" name="mode" value="replace" checked /> 
              <div>
                <strong>Заменить всё</strong>
                <p class="muted" style="font-size:0.8rem; margin:0;">Удалит текущие данные и загрузит новые из файла.</p>
              </div>
            </label>

            <label class="field radio-option" style="display:flex; align-items:center; gap:8px; padding:8px; border:1px solid var(--border); border-radius:4px; margin-bottom:8px; cursor:pointer;">
              <input type="radio" name="mode" value="addOnly" /> 
              <div>
                <strong>Добавить только новое</strong>
                <p class="muted" style="font-size:0.8rem; margin:0;">Игнорирует существующие ID, добавляет только тех, кого нет.</p>
              </div>
            </label>

            <label class="field radio-option" style="display:flex; align-items:center; gap:8px; padding:8px; border:1px solid var(--border); border-radius:4px; cursor:pointer;">
              <input type="radio" name="mode" value="mergeLWW" /> 
              <div>
                <strong>Слить (Last Write Wins)</strong>
                <p class="muted" style="font-size:0.8rem; margin:0;">Обновляет записи, если дата изменения во входящем файле новее.</p>
              </div>
            </label>
          </div>
        `,
        submitText: 'Импортировать',
        cancelText: 'Отменить', // <-- Изменили текст
        hideCloseButton: true,   // <-- НОВОЕ ПАРАМЕТР (см. шаг 3)
        onSubmit(formData) {
          applyImport(json, String(formData.get('mode')));
        }
      });
    } catch (error) {
      toast(`Ошибка чтения файла: ${error.message}`, 'error');
    }
  });

  // Clear All Characters
  document.getElementById('clear-all-characters-btn')?.addEventListener('click', () => {
    if (!state.characters.length) {
      toast('Список пуст', 'info');
      return;
    }
    if (confirmDialog('Удалить ВСЕХ персонажей? Это действие необратимо.')) {
      state.characters = [];
      state.ui.expandedCharacterId = null;
      
      // ВАЖНО: Используем forceRenderAndPersist для очистки и обновления UI
      forceRenderAndPersist().then(() => {
        toast('Все персонажи удалены', 'success');
      });
    }
  });

  // Copy Data Dir
  // js/settings.js (фрагмент bindSettings)

  // Open Data Dir (Вместо Copy Path)
  // js/settings.js (фрагмент внутри bindSettings)

  // Open/Copy Data Dir
  // js/settings.js (фрагмент bindSettings)

  document.getElementById('copy-data-dir-btn')?.addEventListener('click', async () => {
    const dirText = document.getElementById('data-dir').textContent;
    
    if (!dirText || dirText.includes('Недоступно') || dirText === '...') {
       toast('Путь к данным неизвестен.', 'error');
       return;
    }

    try {
      // Динамически импортируем функцию open из установленного плагина
      const { open } = await import('@tauri-apps/plugin-shell');
      
      // Пытаемся открыть папку в системном файловом менеджере
      await open(dirText);
      
      toast('Папка открыта в проводнике.', 'success');
      
    } catch (e) {
      console.warn('[SHELL PLUGIN ERROR]', e);
      
      // Fallback: если плагин не сработал или нет прав, копируем путь
      try {
        await navigator.clipboard.writeText(dirText);
        toast('Не удалось автоматически открыть папку. Путь скопирован в буфер обмена.', 'info');
      } catch (clipErr) {
        prompt("Скопируйте путь вручную:", dirText);
      }
    }
  });
}