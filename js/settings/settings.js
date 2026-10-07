// js/settings/settings.js

import { getAdapter, saveNow, forceRenderAndPersist, persist, createBackup, isTauri } from '../core/storage.js';
import { state, serializeState } from '../core/state.js';
import { escapeHtml } from '../core/utils.js';
import { vaultStatus } from '../core/secrets.js';
import { HOTKEYS, applyDesktopSettings } from '../desktop/desktop.js';
import { runNotificationTest } from '../desktop/notifications.js';
import { RECURRING_EVENTS, recurringEventScheduleText } from '../modules/dashboard/recurringEvents.js';
import { toast, confirmModal } from '../core/ui.js';
import { DANGER_ACTIONS, clearParties, clearMarathons, clearCharacters } from './dangerZone.js';
import { balanceSettingsColumns } from './columns.js';
import { bindGuides } from './guides.js';
import { openExportDialog } from '../data/export.js';
import { openImportDialog } from '../data/import.js';
import '../core/taskLog.js';   // подключает вид логов «Скрипты» к единому модулю логов
import { mountLogHub, logHubSummary, onLogsChange } from '../core/logHub.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import { refreshFreshnessLabels, formatHoursSpan } from '../core/freshness.js';
import { rescheduleUpdates } from '../desktop/updater.js';
import { refreshUpdateSchedule } from '../desktop/updateUi.js';
import { resolveUpdateMode } from '../desktop/updateSchedule.js';
import '../modules/automation/promoLogView.js';      // виды логов «Промокоды», «Передачи» и «Подарки»
import '../modules/automation/transferLogView.js';
import '../modules/automation/shopLogView.js';       // вид логов «Подарки» (покупка за Древние монеты)

export const BACKUPS_SHOWN = 5;   // сколько последних бэкапов показываем в панели

/** Tauri отдаёт { name, createdAt, size }, браузерный адаптер — строки; возвращаем от новых к старым. */
async function loadBackups() {
  const adapter = getAdapter();
  if (!adapter) return [];
  const list = (await adapter.listBackups()).map(b => typeof b === 'string' ? { name: b } : b);
  return list.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0) || String(y.name).localeCompare(String(x.name)));
}

function backupRowsHtml(backups) {
  return backups.length
    ? backups.map(({ name, createdAt, size }) => `
          <div class="backup-item">
            <div class="meta">
              <strong>${createdAt ? escapeHtml(new Date(createdAt).toLocaleString('ru-RU')) : escapeHtml(name)}</strong>
              ${createdAt ? `<small class="muted">${escapeHtml(name)}${size ? ` · ${Math.round(size / 1024)} КБ` : ''}</small>` : ''}
            </div>
            <div class="row gap">
              <button class="btn" data-backup-restore="${escapeHtml(name)}">Восстановить</button>
              <button class="btn danger" data-backup-delete="${escapeHtml(name)}">Удалить</button>
            </div>
          </div>
        `).join('')
    : '<div class="empty-state">Нет резервных копий.</div>';
}

let fullBackupsOverlay = null;

async function refreshBackups() {
  const listEl = document.getElementById('backup-list');
  const summaryEl = document.getElementById('backup-summary');
  const allBtn = document.getElementById('all-backups-btn');
  if (!listEl) return;

  try {
    const backups = await loadBackups();
    listEl.innerHTML = backupRowsHtml(backups.slice(0, BACKUPS_SHOWN));
    if (allBtn) {
      allBtn.hidden = backups.length <= BACKUPS_SHOWN;
      allBtn.textContent = `📚 Полный список бэкапов (${backups.length})`;
    }
    if (summaryEl) {
      const last = backups[0];
      summaryEl.textContent = backups.length
        ? `Копий: ${backups.length}${last?.createdAt ? ` · последняя: ${new Date(last.createdAt).toLocaleString('ru-RU')}` : ''}`
        : 'Резервных копий пока нет: нажмите «Создать бэкап».';
    }
    if (fullBackupsOverlay) fullBackupsOverlay.body.innerHTML = `<div class="list compact" id="full-backup-list">${backupRowsHtml(backups)}</div>`;
  } catch (error) {
    listEl.innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(error.message || error)}</div>`;
  }
}

/** Окно со всеми сохранёнными бэкапами (те же кнопки «Восстановить» / «Удалить»). */
async function openFullBackups() {
  if (fullBackupsOverlay) return;
  const ov = openOverlay({ title: '📚 Полный список бэкапов', wide: true, onClose: () => { fullBackupsOverlay = null; } });
  fullBackupsOverlay = ov;
  ov.foot.innerHTML = '<button type="button" class="btn primary" data-close>Закрыть</button>';
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  await refreshBackups();
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

export async function renderSettings() {
  const adapter = getAdapter();
  
  // Защита: если адаптера нет, выходим тихо или пишем заглушку
  if (!adapter) {
     const runtimeEl = document.getElementById('storage-runtime');
     if(runtimeEl) runtimeEl.textContent = 'Недоступно (нет адаптера)';
     return;
  }

  // Runtime info
  const runtimeEl = document.getElementById('storage-runtime');
  if (runtimeEl) {
    runtimeEl.textContent = isTauri() ? 'Tauri Desktop (Локальный файл)' : 'Browser (LocalStorage)';
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


  // Безопасность
  const vaultEl = document.getElementById('vault-status');
  if (vaultEl) {
    const v = vaultStatus();
    vaultEl.textContent = !isTauri()
      ? 'Недоступно в браузерном режиме — контакты хранятся в localStorage.'
      : state.settings.security?.useVault === false
        ? '⚠️ Выключено: email и пароли хранятся в state.json открытым текстом.'
        : v.ready
          ? `✅ Email, пароли и телефоны хранятся в хранилище учётных данных ОС (записей: ${v.count}). В state.json и бэкапах их нет.`
          : `⚠️ Хранилище ОС недоступно (${v.error || 'нет ответа'}) — контакты сохраняются в state.json.`;
  }

  // Версия
  const verEl = document.getElementById('app-version');
  if (verEl && isTauri()) {
    try { verEl.textContent = await (await import('@tauri-apps/api/app')).getVersion(); } catch (_) { /* не критично */ }
  }

  // Значения настроек
  document.querySelectorAll('[data-setting]').forEach(el => {
    const value = getSetting(el.dataset.setting);
    if (el.type === 'checkbox') el.checked = value !== false && value !== undefined;
    else if (el.dataset.setting === 'updates.mode') el.value = resolveUpdateMode(state.settings);
    else el.value = value ?? '';
  });
  updateHoursHints();
  renderEventNotifications();

  const hk = document.getElementById('hotkeys-list');
  if (hk && !hk.childElementCount) {
    hk.innerHTML = HOTKEYS.map(h => `<span><kbd>${escapeHtml(h.keys)}</kbd></span><span>${escapeHtml(h.text)}</span>`).join('');
  }
}

/** Варианты «за сколько предупредить» — те же значения, что проверяет notifications.js. */
const LEAD_CHOICES = [
  { minutes: 5, label: 'За 5 минут' },
  { minutes: 10, label: 'За 10 минут' },
  { minutes: 15, label: 'За 15 минут' },
  { minutes: 30, label: 'За 30 минут' },
  { minutes: 60, label: 'За 1 час' }
];

/**
 * Список постоянных ивентов с галочкой и выбором «за сколько».
 *
 * Список рисуется из расписания (`RECURRING_EVENTS`), а не из разметки: добавили ивент в модуль —
 * он сразу появился в настройках, и рассинхрона «ивент есть, а напоминания нет» не будет.
 */
function renderEventNotifications() {
  const root = document.getElementById('event-notify-list');
  if (!root) return;
  const settings = state.settings?.notifications?.events || {};
  root.innerHTML = RECURRING_EVENTS.map(event => {
    const conf = settings[event.id] || { enabled: true, leadMinutes: 10 };
    return `<div class="event-notify-row" data-event="${escapeHtml(event.id)}">
      <label class="event-notify-check">
        <input type="checkbox" data-event-enabled="${escapeHtml(event.id)}"${conf.enabled !== false ? ' checked' : ''} />
        <span>
          <b><i class="event-notify-dot is-${escapeHtml(event.color)}" aria-hidden="true"></i>${escapeHtml(event.title)}</b>
          <small class="muted">${escapeHtml(recurringEventScheduleText(event))} (МСК)</small>
        </span>
      </label>
      <select class="select setting-num" data-event-lead="${escapeHtml(event.id)}" aria-label="За сколько предупредить: ${escapeHtml(event.title)}">
        ${LEAD_CHOICES.map(o => `<option value="${o.minutes}"${Number(conf.leadMinutes) === o.minutes ? ' selected' : ''}>${o.label}</option>`).join('')}
      </select>
    </div>`;
  }).join('');

  root.querySelectorAll('[data-event-enabled]').forEach(el => {
    el.addEventListener('change', () => saveEventNotification(el.dataset.eventEnabled, { enabled: el.checked }));
  });
  root.querySelectorAll('[data-event-lead]').forEach(el => {
    el.addEventListener('change', () => saveEventNotification(el.dataset.eventLead, { leadMinutes: Number(el.value) }));
  });
}

/** Сохранение одной настройки ивента: остальные ивенты и прочие настройки не затрагиваются. */
async function saveEventNotification(id, patch) {
  const notifications = state.settings.notifications || (state.settings.notifications = {});
  const events = notifications.events || (notifications.events = {});
  events[id] = { ...(events[id] || { enabled: true, leadMinutes: 10 }), ...patch };
  await persist();
}

/** Подписи к полям «часов»: 24 → «= 1 день», 30 → «= 1 день 6 часов». */
function updateHoursHints() {
  document.querySelectorAll('[data-hours-for]').forEach(hint => {
    const input = document.querySelector(`[data-setting="${hint.dataset.hoursFor}"]`);
    const text = input instanceof HTMLInputElement ? formatHoursSpan(input.value) : '';
    hint.textContent = text ? `= ${text}` : '';
  });
}

function getSetting(path) {
  return path.split('.').reduce((o, k) => o?.[k], state.settings);
}

function setSetting(path, value) {
  const keys = path.split('.');
  let obj = state.settings;
  keys.slice(0, -1).forEach(k => { if (!obj[k] || typeof obj[k] !== 'object') obj[k] = {}; obj = obj[k]; });
  obj[keys[keys.length - 1]] = value;
}

function bindSettingInputs() {
  // Подпись «= 3 дня» меняется по мере ввода, до сохранения значения
  document.querySelectorAll('[data-hours-for]').forEach(hint => {
    document.querySelector(`[data-setting="${hint.dataset.hoursFor}"]`)?.addEventListener('input', updateHoursHints);
  });
  document.querySelectorAll('[data-setting]').forEach(el => {
    el.addEventListener('change', async () => {
      const path = el.dataset.setting;
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.dataset.valueType === 'string') value = el.value;
      else if (el.type === 'number' || el.tagName === 'SELECT') {
        const n = Number(el.value);
        const min = el.min !== '' ? Number(el.min) : -Infinity;
        const max = el.max !== '' ? Number(el.max) : Infinity;
        value = Math.min(max, Math.max(min, Number.isFinite(n) ? n : 0));
        if (path.startsWith('freshness.')) value = Math.round(value);   // порог — целое число часов
        el.value = value;
        updateHoursHints();
      } else value = el.value;
      setSetting(path, value);
      if (path === 'updates.mode') setSetting('updates.checkOnStartup', true);   // совместимость со старыми версиями
      await persist();
      if (path === 'updates.mode') { refreshUpdateSchedule(); rescheduleUpdates(); }
      if (path.startsWith('tray.') || path.startsWith('browser.')) await applyDesktopSettings();
      if (path.startsWith('freshness.')) refreshFreshnessLabels(state.settings);   // подсветка устаревших обновляется сразу
      if (path === 'security.useVault') {
        toast(value ? 'Контакты перенесутся в хранилище ОС после перезапуска.' : 'Контакты будут храниться в state.json.', 'info');
      }
    });
  });
}

export function bindSettings() {
  bindGuides();
  balanceSettingsColumns();
  bindSettingInputs();

  document.getElementById('test-notifications-btn')?.addEventListener('click', async () => {
    const result = await runNotificationTest();
    // Различаем «нечего напоминать» и «напоминать есть о чём, но Windows не показала» — это разные проблемы
    const text = !result.sent
      ? 'Сейчас нечего напоминать — всё идёт по плану.'
      : result.delivered === result.sent
        ? `Отправлено уведомлений: ${result.sent}`
        : `Отправлено ${result.delivered} из ${result.sent}: остальные Windows не показала.`;
    toast(text, result.delivered === result.sent ? 'info' : 'warning');
    const diagnostics = document.getElementById('notify-diagnostics');
    if (!diagnostics) return;
    diagnostics.textContent = result.diagnostics.reasons.length
      ? `⚠️ ${result.diagnostics.reasons.join(' ')}`
      : '✅ Уведомления доступны: Windows разрешает их показывать.';
  });

  // Запуск игры: список GameCenter с названиями и привязка персонажей (окно собирается в js/modules/launcher/gcSettingsModal.js)
  const gcSummary = document.getElementById('gc-summary');
  const refreshGcSummary = async () => {
    if (!gcSummary) return;
    const { gcSummaryText } = await import('../modules/launcher/gcSettingsModal.js');
    gcSummary.textContent = gcSummaryText();
  };
  refreshGcSummary();
  window.addEventListener('tf-persisted', refreshGcSummary);
  document.getElementById('gc-manage-btn')?.addEventListener('click', async () => {
    const { openGameCentersModal } = await import('../modules/launcher/gcSettingsModal.js');
    openGameCentersModal({ onClose: refreshGcSummary });
  });

  import('../desktop/autostart.js').then(m => m.bindAutostart()).catch(e => console.warn('[AUTOSTART]', e));

  document.getElementById('close-game-windows-btn')?.addEventListener('click', async () => {
    const { closeAllGameWindows } = await import('../modules/launcher/partyLaunch.js');
    await closeAllGameWindows({ confirm: true });
  });

  // Список запущенных окон игры: закрыть выбранные, по пати или все
  document.getElementById('pick-game-windows-btn')?.addEventListener('click', async () => {
    const { openWindowPicker } = await import('../modules/launcher/windowPicker.js');
    await openWindowPicker();
  });

  // Журналы (единый модуль логов): список рисуется при первом раскрытии панели, заголовок обновляется всегда
  const logPanel = document.getElementById('log-hub-panel');
  const logBody = document.getElementById('log-hub-root');
  const logSummary = document.getElementById('log-hub-summary');
  const refreshLogSummary = () => { if (logSummary) logSummary.textContent = logHubSummary(); };
  refreshLogSummary();
  onLogsChange(refreshLogSummary);
  let logMounted = false;
  logPanel?.addEventListener('toggle', () => {
    if (logPanel.open && !logMounted && logBody) { logMounted = true; mountLogHub(logBody); }
  });

  // Create Backup
  document.getElementById('create-backup-btn')?.addEventListener('click', async () => {
    const adapter = getAdapter();
    if (!adapter) return;
    try {
      await saveNow();
      const name = await createBackup();
      toast(`Бэкап создан: ${name}`, 'success');
      await refreshBackups();
    } catch (e) {
      toast(`Ошибка: ${e.message}`, 'error');
    }
  });

  // Refresh Backups
  document.getElementById('refresh-backups-btn')?.addEventListener('click', refreshBackups);
  document.getElementById('all-backups-btn')?.addEventListener('click', openFullBackups);

  // Backup Actions (Delegate)
  document.addEventListener('click', async (e) => {
    const restoreBtn = e.target.closest?.('[data-backup-restore]');
    const deleteBtn = e.target.closest?.('[data-backup-delete]');
    if (!restoreBtn && !deleteBtn) return;
    const adapter = getAdapter();
    if (!adapter) return;

    if (restoreBtn) {
      const name = restoreBtn.dataset.backupRestore;
      const ok = await confirmModal({
        title: 'Восстановить из копии?',
        text: `Данные будут заменены содержимым копии «${name}». Текущее состояние сохранится отдельной копией, приложение перезапустится.`,
        okText: 'Восстановить',
        danger: true
      });
      if (ok) {
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
      const ok = await confirmModal({
        title: 'Удалить резервную копию?',
        text: `Копия «${name}» будет удалена безвозвратно. Восстановить из неё данные больше не получится.`,
        okText: 'Удалить копию',
        danger: true
      });
      if (ok) {
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
  document.getElementById('import-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      openImportDialog(json);
    } catch (error) {
      toast(`Ошибка чтения файла: ${error.message}`, 'error');
    }
  });

  // Опасные действия: описание каждого действия, подтверждение с числом записей и резервная копия перед удалением
  const runDanger = async (kind) => {
    const action = DANGER_ACTIONS[kind];
    const count = action.count(state);
    if (!count) { toast(`Удалять нечего: ${action.what} нет`, 'info'); return; }
    const ok = await confirmModal({
      title: `${action.title}?`,
      text: `Будет удалено: ${count} (${action.what}). ${action.description} Перед удалением создастся резервная копия — её можно восстановить в «Резервных копиях».`,
      okText: `Удалить (${count})`,
      danger: true
    });
    if (!ok) return;
    try { if (getAdapter()) { await saveNow(); await createBackup(`before-delete-${kind}`); } }
    catch (e) { console.warn('[DANGER] backup failed', e); }
    if (kind === 'parties') clearParties(state);
    else if (kind === 'marathons') clearMarathons(state);
    else {
      const { accountKeysOf } = await import('../modules/launcher/gameCenters.js');
      const { accountKeys } = clearCharacters(state, accountKeysOf);
      if (isTauri() && accountKeys.length) {
        const { forgetAccount } = await import('../modules/launcher/launch.js');
        await Promise.all(accountKeys.map(k => forgetAccount(k).catch(() => {})));
      }
    }
    // forceRenderAndPersist сохраняет данные и перерисовывает все вкладки
    await forceRenderAndPersist();
    toast(`Удалено: ${count} (${action.what})`, 'success');
  };
  document.getElementById('danger-zone')?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-danger]'));
    if (btn?.dataset.danger && DANGER_ACTIONS[btn.dataset.danger]) runDanger(btn.dataset.danger);
  });

  // Полный сброс: приложение возвращается к состоянию сразу после установки.
  // Подтверждение отдельное и явное: действие необратимо, потому что копии тоже удаляются.
  document.getElementById('factory-reset-btn')?.addEventListener('click', async () => {
    const { resetSummary, resetWarning, performFactoryReset } = await import('./factoryReset.js');
    const summary = resetSummary(state);
    const ok = await confirmModal({
      title: 'Вернуть к заводским настройкам?',
      text: resetWarning(summary),
      okText: 'Удалить всё и сбросить',
      danger: true
    });
    if (!ok) return;
    await performFactoryReset(state);
  });

  // Open/Copy Data Dir
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