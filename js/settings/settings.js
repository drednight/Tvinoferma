// js/settings/settings.js

import {
  getAdapter,
  saveNow,
  forceRenderAndPersist,
  persist,
  createBackup,
  isTauri,
  inspectStoredBackup,
  forgetStoredBackupInspection,
  restoreStoredBackup,
  deleteStoredBackup,
  assertStateWriteAvailable,
  haltAfterPartialStateChange
} from '../core/storage.js';
import { state, serializeState } from '../core/state.js';
import { SCHEMA_VERSION } from '../core/migrations.js';
import { isUncertainStateWrite } from '../core/stateWriteOutcome.js';
import { escapeHtml } from '../core/utils.js';
import { vaultStatus } from '../core/secrets.js';
import { hotkeyRows, applyDesktopSettings } from '../desktop/desktop.js';
import { applySections } from '../core/sections.js';
import { runNotificationTest, NOTIFY_KINDS } from '../desktop/notifications.js';
import { SOUND_TONES, previewNotificationSound, soundSettings, soundDiagnostics } from '../desktop/sound.js';
import { RECURRING_EVENTS, recurringEventScheduleText } from '../modules/dashboard/recurringEvents.js';
import { toast, confirmModal } from '../core/ui.js';
import { showInApp } from '../core/notifyCenter.js';
import { DANGER_ACTIONS, clearParties, clearMarathons, clearCharacters } from './dangerZone.js';
import { balanceSettingsColumns } from './columns.js';
import { bindGuides } from './guides.js';
import { bindFeedback } from './feedback.js';
import { openExportDialog } from '../data/export.js';
import { openImportDialog } from '../data/import.js';
import '../core/taskLog.js'; // подключает вид логов «Скрипты» к единому модулю логов
import { mountLogHub, logHubSummary, onLogsChange } from '../core/logHub.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import { refreshFreshnessLabels, formatHoursSpan } from '../core/freshness.js';
import { rescheduleUpdates } from '../desktop/updater.js';
import { refreshUpdateSchedule } from '../desktop/updateUi.js';
import { resolveUpdateMode } from '../desktop/updateSchedule.js';
import { bindCloudRegistrationCheck } from '../modules/cloudSync/ui/registrationCheckPanel.js';
import { bindCloudReviewPanel } from '../modules/cloudSync/ui/cloudReviewPanel.js';
import '../modules/automation/promoLogView.js'; // виды логов «Промокоды», «Передачи» и «Подарки»
import '../modules/automation/transferLogView.js';
import '../modules/automation/shopLogView.js'; // вид логов «Подарки» (покупка за Древние монеты)
import '../modules/launcher/launchLogView.js'; // вид логов «Запуски» (история и статистика запуска игры)

export const BACKUPS_SHOWN = 5; // сколько последних бэкапов показываем в панели

/** Tauri отдаёт { name, createdAt, size }, браузерный адаптер — строки; возвращаем от новых к старым. */
async function loadBackups() {
  const adapter = getAdapter();
  if (!adapter) return [];
  const list = (await adapter.listBackups()).map(b => (typeof b === 'string' ? { name: b } : b));
  return list.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0) || String(y.name).localeCompare(String(x.name)));
}

function backupRowsHtml(backups) {
  return backups.length
    ? backups
        .map(
          ({ name, createdAt, size }) => `
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
        `
        )
        .join('')
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
        : 'Копий состояния пока нет: нажмите «Создать копию состояния».';
    }
    if (fullBackupsOverlay)
      fullBackupsOverlay.body.innerHTML = `<div class="list compact" id="full-backup-list">${backupRowsHtml(backups)}</div>`;
  } catch (error) {
    listEl.innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(error.message || error)}</div>`;
  }
}

/** Окно со всеми сохранёнными бэкапами (те же кнопки «Восстановить» / «Удалить»). */
async function openFullBackups() {
  if (fullBackupsOverlay) return;
  const ov = openOverlay({
    title: '📚 Полный список бэкапов',
    wide: true,
    onClose: () => {
      fullBackupsOverlay = null;
    }
  });
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
  // The browser may need the URL after this event handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// May contain contacts/passwords. Keep only in memory, never display or log it;
// JS strings cannot be reliably wiped. `ui` is not part of saved state.
function stateReviewWitness() {
  const { ui: _ui, ...persisted } = state;
  const raw = JSON.stringify(persisted);
  if (typeof raw !== 'string') throw new Error('no state');
  return raw;
}

function stateStillMatches(expected) {
  try {
    return stateReviewWitness() === expected;
  } catch {
    return false;
  }
}

function reviewDescription(review) {
  const count = value => (value === null ? 'не определено' : String(value));
  const marker =
    review.vaultReference === 'os-referenced'
      ? 'В копии есть ссылка на хранилище ОС, но самих контактов ОС в ней нет.'
      : review.vaultReference === 'unknown'
        ? 'Отметку хранилища ОС не удалось определить.'
        : 'Явной отметки хранилища ОС нет; это не доказывает, что отдельных записей ОС не было.';
  const current =
    review.currentState === 'missing'
      ? 'Текущий файл состояния не найден.'
      : review.currentState === 'damaged'
        ? 'Текущий файл повреждён; перед заменой будут сохранены его точные байты.'
        : 'Перед заменой будет создана отдельная копия текущего сохранённого файла.';
  const missingSections = [review.characters, review.archivedCharacters, review.plannerEntries].some(
    value => value === null
  )
    ? ' Некоторые разделы в копии не определены и после восстановления могут оказаться пустыми.'
    : '';
  return `Версия данных: ${review.schemaVersion}; персонажей: ${count(review.characters)}, в архиве: ${count(review.archivedCharacters)}, задач и событий: ${count(review.plannerEntries)}.${missingSections} ${marker} ${current} Несохранённые изменения, контакты ОС, входы GameCenter, сессии и отдельные журналы в эти копии не входят. Контакты ОС после восстановления останутся прежними и могут не соответствовать копии. Завершите выполняющиеся операции; приложение перезапустится.`;
}

let reviewingBackup = false;
let exportingAll = false;

export async function renderSettings() {
  const adapter = getAdapter();

  // Защита: если адаптера нет, выходим тихо или пишем заглушку
  if (!adapter) {
    const runtimeEl = document.getElementById('storage-runtime');
    if (runtimeEl) runtimeEl.textContent = 'Недоступно (нет адаптера)';
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
    vaultEl.textContent = v.blocked
      ? `⚠️ ${v.error || 'Хранилище учётных данных недоступно'}. Сохранение остановлено; проверьте данные и копии перед перезапуском. Копии state.json могут не содержать контакты.`
      : !isTauri()
        ? 'Недоступно в браузерном режиме — контакты хранятся в localStorage.'
        : state.settings.security?.useVault === false
          ? '⚠️ Выключено: email и пароли хранятся в state.json открытым текстом.'
          : v.ready
            ? `✅ Хранилище учётных данных ОС доступно (записей: ${v.count}). При успешном сохранении контакты не попадают в state.json; прежние резервные копии могут их содержать.`
            : v.error
              ? `⚠️ Хранилище ОС недоступно (${v.error}) — контакты сохраняются в state.json.`
              : '⚠️ Хранилище ОС ещё не проверено в этом сеансе. Контакты пока остаются в state.json; после перезапуска они будут проверены перед переносом.';
  }

  // Версия
  const verEl = document.getElementById('app-version');
  if (verEl && isTauri()) {
    try {
      verEl.textContent = await (await import('@tauri-apps/api/app')).getVersion();
    } catch (_) {
      /* не критично */
    }
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
  renderNotifyKinds();

  const hk = document.getElementById('hotkeys-list');
  if (hk && !hk.childElementCount) {
    // Подпись разделам собирается по текущим настройкам: выключенный или переставленный раздел
    // меняет и номера горячих клавиш, и их названия
    hk.innerHTML = hotkeyRows()
      .map(h => `<span><kbd>${escapeHtml(h.keys)}</kbd></span><span>${escapeHtml(h.text)}</span>`)
      .join('');
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

/**
 * Список видов уведомлений: показывать ли всплывающее окно и играть ли звук.
 *
 * Список рисуется из `NOTIFY_KINDS`, а не из разметки: добавили вид в `notifications.js` —
 * он сразу появился в настройках, и рассинхрона «вид есть, а галочки нет» не будет.
 */
function renderNotifyKinds() {
  const root = document.getElementById('notify-kinds');
  if (!root) return;
  const kinds = state.settings?.notifications?.kinds || {};
  root.innerHTML = `
    <div class="notify-kinds-head">
      <span>Уведомление</span>
      <span title="Карточка внутри приложения: стоит, пока не закроете">В приложении</span>
      <span title="Сообщение Windows поверх остальных окон">Окно Windows</span>
      <span title="Короткий сигнал рядом с сообщением">Звук</span>
    </div>
    ${NOTIFY_KINDS.map(item => {
      const conf = kinds[item.kind] || { popup: true, inapp: true, sound: true };
      const tone = conf.tone || '';
      return `<div class="notify-kind-row">
        <label class="notify-kind-name">
          <input type="checkbox" data-kind-popup="${escapeHtml(item.kind)}"${conf.popup !== false ? ' checked' : ''} />
          <span><b>${escapeHtml(item.title)}</b><small class="muted">${escapeHtml(item.hint)}</small></span>
        </label>
        <label class="notify-kind-inapp" title="В приложении: ${escapeHtml(item.title)}">
          <input type="checkbox" data-kind-inapp="${escapeHtml(item.kind)}"${conf.inapp !== false ? ' checked' : ''} />
        </label>
        <label class="notify-kind-sound" title="Звук: ${escapeHtml(item.title)}">
          <input type="checkbox" data-kind-sound="${escapeHtml(item.kind)}"${conf.sound !== false ? ' checked' : ''} />
        </label>
        <span class="notify-kind-extra">
          <label for="tone-${escapeHtml(item.kind)}">Набор</label>
          <select class="select notify-kind-tone" id="tone-${escapeHtml(item.kind)}" data-kind-tone="${escapeHtml(item.kind)}"
                  aria-label="Набор звука: ${escapeHtml(item.title)}">
            <option value=""${tone ? '' : ' selected'}>как у всех</option>
            ${SOUND_TONES.map(t => `<option value="${escapeHtml(t.id)}"${tone === t.id ? ' selected' : ''}>${escapeHtml(t.title)}</option>`).join('')}
          </select>
          <button type="button" class="btn ghost small notify-kind-listen" data-kind-listen="${escapeHtml(item.kind)}"
                  title="Послушать звук этого вида" aria-label="Послушать звук: ${escapeHtml(item.title)}">🔊</button>
        </span>
      </div>`;
    }).join('')}`;

  root.querySelectorAll('[data-kind-popup]').forEach(el => {
    el.addEventListener('change', () => saveNotifyKind(el.dataset.kindPopup, { popup: el.checked }));
  });
  root.querySelectorAll('[data-kind-inapp]').forEach(el => {
    el.addEventListener('change', () => saveNotifyKind(el.dataset.kindInapp, { inapp: el.checked }));
  });
  root.querySelectorAll('[data-kind-sound]').forEach(el => {
    el.addEventListener('change', () => saveNotifyKind(el.dataset.kindSound, { sound: el.checked }));
  });
  root.querySelectorAll('[data-kind-tone]').forEach(el => {
    el.addEventListener('change', () => saveNotifyKind(el.dataset.kindTone, { tone: el.value || undefined }));
  });
  // Своя кнопка «Послушать» у каждого вида: общая кнопка проигрывала бы общий набор,
  // а у вида он может быть своим — и оценять надо ровно то, что услышат потом
  root.querySelectorAll('[data-kind-listen]').forEach(el => {
    el.addEventListener('click', async () => {
      const label = el.textContent;
      el.textContent = '⏳';
      const res = await previewNotificationSound(state.settings.notifications, el.dataset.kindListen);
      el.textContent = res === 'played' ? label : '🔇';
      if (res !== 'played') {
        toast('Звук не прозвучал: браузер разрешает звук только после первого клика по приложению', 'warning');
      }
      setTimeout(() => {
        el.textContent = label;
      }, 800);
    });
  });
}

/** Сохранение одной настройки вида: остальные виды и настройки не затрагиваются. */
async function saveNotifyKind(kind, patch) {
  const notifications = state.settings.notifications || (state.settings.notifications = {});
  const kinds = notifications.kinds || (notifications.kinds = {});
  const next = { ...(kinds[kind] || { popup: true, inapp: true, sound: true }), ...patch };
  // Пустой выбор набора означает «как у всех»: хранить его незачем, иначе общий набор
  // перестанет действовать для этого вида после смены общего в выпадающем списке
  if (!patch.tone) delete next.tone;
  kinds[kind] = next;
  await persist();
}

/**
 * Выбор набора звука и кнопка «Послушать».
 *
 * Список наборов берём из `sound.js`, а не пишем здесь: наборы должны совпадать
 * с теми, что действительно играют. Пояснение под списком меняется вместе с выбором —
 * иначе приходилось бы запоминать, какой набор как звучит.
 */
function initSoundTonePicker() {
  const select = document.getElementById('sound-tone');
  const hint = document.getElementById('sound-tone-hint');
  const button = document.getElementById('sound-preview');
  if (!select || !button) return;

  const fill = () => {
    const current = soundSettings(state.settings).tone;
    select.innerHTML = SOUND_TONES.map(
      t => `<option value="${escapeHtml(t.id)}"${t.id === current ? ' selected' : ''}>${escapeHtml(t.title)}</option>`
    ).join('');
    updateHint();
  };
  const updateHint = () => {
    if (!hint) return;
    const tone = SOUND_TONES.find(t => t.id === select.value);
    hint.textContent = tone ? tone.hint : '';
  };

  fill();
  // Настройки перечитываются при открытии окна — список должен показать актуальный выбор
  select.addEventListener('change', updateHint);

  button.addEventListener('click', async () => {
    const result = await previewNotificationSound(state.settings);
    if (result === 'played') {
      const tone = SOUND_TONES.find(t => t.id === soundSettings(state.settings).tone);
      toast(`Звук «${tone ? tone.title : ''}»`, 'info');
      return;
    }
    if (result === 'no-audio') {
      toast('В этом окне звук недоступен — это бывает в браузере. В приложении звук работает.', 'warning');
      return;
    }
    // Движок держит звук выключенным до первого клика по окну — честно говорим об этом
    toast(soundDiagnostics().reason || 'Звук заблокирован браузером: нажмите на окно и попробуйте ещё раз.', 'warning');
  });
}

/** Подписи к полям «часов»: 24 → «= 1 день», 30 → «= 1 день 6 часов». */

/**
 * Разделы настроек: слева список, справа открытый раздел целиком.
 *
 * Раньше все шесть разделов шли одной длинной страницей, а список категорий был карточками
 * наверху. Теперь открыт ровно один раздел, поэтому прокрутка для перехода между ними не
 * нужна, но ссылки из справочника и гайда (`#settings-sync`) должны работать по-прежнему:
 * для этого есть `openSettingsSection(id)`, а якорь в адресе тоже переключает раздел.
 */
function initSettingsSections() {
  const nav = document.querySelector('.settings-nav');
  const body = document.querySelector('.settings-body');
  if (!nav || !body || nav.dataset.navSpy) return;
  nav.dataset.navSpy = 'true';
  const links = [...nav.querySelectorAll('.settings-nav-item')];
  const sections = links.map(link => document.getElementById(link.getAttribute('href').slice(1))).filter(Boolean);
  if (!sections.length) return;

  /**
   * Открыть раздел настроек по id. Возвращает, открыт ли он.
   * Вызывается из клика по навигации, из ссылки в адресной строке и из справочника.
   */
  function openSettingsSection(id) {
    const section = sections.find(s => s.id === id) || null;
    sections.forEach(s => {
      s.hidden = !section || s !== section;
    });
    links.forEach(link => {
      const on = !!section && link.getAttribute('href') === `#${section.id}`;
      link.classList.toggle('is-active', on);
      if (on) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
    return !!section;
  }

  nav.addEventListener('click', event => {
    const link = event.target.closest?.('.settings-nav-item');
    if (!link) return;
    event.preventDefault();
    openSettingsSection(link.getAttribute('href').slice(1));
    // В узком окне меню находится над содержимым, а не сбоку: прокрутка к body
    // прятала его за шапкой сразу после выбора раздела.
    const compact = window.matchMedia?.('(max-width: 980px)').matches;
    (compact ? nav : body).scrollIntoView?.({ block: 'start', behavior: 'auto' });
  });

  // Переход по прямой ссылке: справочник и гайд ведут и на раздел (`#settings-sync`),
  // и на панель внутри него (`#settings-notifications`) — во втором случае открываем тот
  // раздел, в котором панель находится
  const fromHash = () => {
    const id = location.hash.slice(1);
    const target = id ? document.getElementById(id)?.closest('.settings-group') : null;
    const sectionId = sections.some(s => s.id === id) ? id : target?.id;
    return sectionId ? openSettingsSection(sectionId) : false;
  };
  window.addEventListener('hashchange', fromHash);
  // Если в адресе нет раздела или он неизвестен — открываем первый. Иначе страница
  // показала бы сразу все разделы разом, то есть ровно то, от чего ушли
  if (!fromHash()) openSettingsSection(sections[0].id);

  // Справка и гайды переходят к панели через `#id` — разделы надо переключить заранее,
  // иначе панели некуда показывать (всё, кроме активного раздела, скрыто)
  window.addEventListener('tf:open-section', event => openSettingsSection(event.detail?.id));
}

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
  keys.slice(0, -1).forEach(k => {
    if (!obj[k] || typeof obj[k] !== 'object') obj[k] = {};
    obj = obj[k];
  });
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
        if (path.startsWith('freshness.')) value = Math.round(value); // порог — целое число часов
        el.value = value;
        updateHoursHints();
      } else value = el.value;
      setSetting(path, value);
      if (path === 'updates.mode') setSetting('updates.checkOnStartup', true); // совместимость со старыми версиями
      await persist();
      if (path === 'updates.mode') {
        refreshUpdateSchedule();
        rescheduleUpdates();
      }
      if (path.startsWith('tray.') || path.startsWith('browser.')) await applyDesktopSettings();
      if (path.startsWith('freshness.')) refreshFreshnessLabels(state.settings); // подсветка устаревших обновляется сразу
      if (path === 'security.useVault') {
        toast(
          value
            ? 'Перед переносом контакты проверяются; при расхождении с хранилищем сохранение будет остановлено.'
            : 'Контакты будут храниться в state.json.',
          'info'
        );
      }
    });
  });
}

export function bindSettings() {
  bindCloudRegistrationCheck({ desktop: isTauri() });
  bindCloudReviewPanel({ desktop: isTauri() });
  bindGuides();
  bindFeedback();
  balanceSettingsColumns();
  bindSettingInputs();
  initSettingsSections();
  initSoundTonePicker();

  document.getElementById('test-notifications-btn')?.addEventListener('click', async () => {
    const result = await runNotificationTest();
    // Различаем «нечего напоминать» и «напоминать есть о чём, но Windows не показала» — это разные проблемы
    const text = !result.sent
      ? 'Сейчас нечего напоминать — всё идёт по плану.'
      : result.delivered === result.sent
        ? `Отправлено уведомлений: ${result.sent}${result.soundOnly ? `, из них только звуком: ${result.soundOnly}` : ''}`
        : `Отправлено ${result.delivered} из ${result.sent}: остальные Windows не показала.`;
    toast(text, result.delivered === result.sent ? 'info' : 'warning');
    const diagnostics = document.getElementById('notify-diagnostics');
    if (!diagnostics) return;
    diagnostics.textContent = result.diagnostics.reasons.length
      ? `⚠️ ${result.diagnostics.reasons.join(' ')}`
      : result.diagnostics.sound?.available
        ? '✅ Уведомления доступны: Windows разрешает их показывать, звук играет.'
        : '✅ Уведомления доступны: Windows разрешает их показывать.';
  });

  // Кнопка «Показать пример»: «Проверить сейчас» зависит от того, есть ли что напоминать,
  // и от разрешений Windows, поэтому по ней нельзя понять, как выглядит сама карточка.
  // Здесь показывается ровно та карточка, какая придёт на настоящее уведомление.
  document.getElementById('show-notification-btn')?.addEventListener('click', () => {
    showInApp({
      title: '🎯 Битва Династий — через 10 минут',
      body: 'Начало в 20:20 (МСК), осталось 10 мин. Понедельник и пятница, 20:20–22:20.\nКарточка стоит, пока её не закроют: крестик справа или клик по самой карточке.',
      kind: 'event',
      once: false
    });
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

  import('../modules/launcher/layoutSync.js').then(m => m.bindLayoutPanel()).catch(e => console.warn('[LAYOUT]', e));

  import('../desktop/autostart.js').then(m => m.bindAutostart()).catch(e => console.warn('[AUTOSTART]', e));

  // Разделы: список строится кодом, а изменения сразу видны в меню — иначе пришлось бы
  // закрывать и открывать настройки, чтобы понять, что галочка сработала.
  import('./sectionsPanel.js')
    .then(m => m.bindSectionsPanel({ onChange: () => applySections(document, state.settings) }))
    .catch(e => console.warn('[SECTIONS]', e));

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
  const refreshLogSummary = () => {
    if (logSummary) logSummary.textContent = logHubSummary();
  };
  refreshLogSummary();
  onLogsChange(refreshLogSummary);
  let logMounted = false;
  logPanel?.addEventListener('toggle', () => {
    if (logPanel.open && !logMounted && logBody) {
      logMounted = true;
      mountLogHub(logBody);
    }
  });

  // Create Backup
  document.getElementById('create-backup-btn')?.addEventListener('click', async () => {
    const adapter = getAdapter();
    if (!adapter) return;
    try {
      await saveNow();
      const name = await createBackup();
      toast(`Копия состояния создана: ${name}. Отдельные контакты ОС в неё не входят.`, 'success');
      await refreshBackups();
    } catch (e) {
      toast(`Ошибка: ${e.message}`, 'error');
    }
  });

  // Refresh Backups
  document.getElementById('refresh-backups-btn')?.addEventListener('click', refreshBackups);
  document.getElementById('all-backups-btn')?.addEventListener('click', openFullBackups);

  // Backup Actions (Delegate)
  document.addEventListener('click', async e => {
    const restoreBtn = e.target.closest?.('[data-backup-restore]');
    const deleteBtn = e.target.closest?.('[data-backup-delete]');
    if (!restoreBtn && !deleteBtn) return;
    const adapter = getAdapter();
    if (!adapter) return;

    if (restoreBtn) {
      if (reviewingBackup) return;
      reviewingBackup = true;
      restoreBtn.disabled = true;
      const name = restoreBtn.dataset.backupRestore;
      let inspection;
      try {
        const approvedState = stateReviewWitness();
        inspection = await inspectStoredBackup(name);
        if (!stateStillMatches(approvedState)) {
          toast('Данные изменились во время проверки. Откройте копию заново.', 'warning', 60000);
          return;
        }
        if (inspection.schemaVersion === null) {
          toast('Не удалось определить версию данных копии; восстановление остановлено.', 'error', 60000);
          return;
        }
        if (inspection.schemaVersion > SCHEMA_VERSION) {
          toast('Копия создана более новой версией приложения. Сначала обновите Твиноферму.', 'error', 60000);
          return;
        }
        if (inspection.vaultReference === 'unknown') {
          toast('Не удалось проверить отметку хранилища ОС в копии; восстановление остановлено.', 'error', 60000);
          return;
        }
        const ok = await confirmModal({
          title: 'Восстановить файл состояния?',
          text: `Выбрана копия «${name}». ${reviewDescription(inspection)}`,
          okText: 'Восстановить состояние',
          danger: true
        });
        if (!ok) return;
        await restoreStoredBackup(name, inspection, () => stateStillMatches(approvedState));
        window.location.reload();
      } catch (err) {
        // Неопределённый результат отдельно показывается постояннее через tf-storage-uncertain.
        // Непроверенные исключения могут содержать личные данные и не выводятся в журнал.
        if (!isUncertainStateWrite(err)) {
          const message = err instanceof Error ? err.message : '';
          const known = [
            'Данные изменились после просмотра; откройте копию заново',
            'Данные или выбранная копия изменились после просмотра; восстановление остановлено',
            'Данные или выбранная копия изменились; восстановление остановлено',
            'Не удалось проверить выбранную копию; обновите список и попробуйте снова'
          ];
          toast(
            known.includes(message) ? message : 'Не удалось подтвердить восстановление. Проверьте данные и копии.',
            'error',
            60000
          );
        }
      } finally {
        if (inspection) forgetStoredBackupInspection(inspection);
        restoreBtn.disabled = false;
        reviewingBackup = false;
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
          await deleteStoredBackup(name);
          toast('Удалено', 'success');
          await refreshBackups();
        } catch (err) {
          toast(`Ошибка удаления: ${err.message}`, 'error');
          await refreshBackups();
        }
      }
    }
  });

  // The legacy JSON export is deliberately separate from cloud encryption and
  // can contain passwords in plaintext. Require explicit confirmation each time.
  document.getElementById('export-all-btn')?.addEventListener('click', async () => {
    if (exportingAll) return;
    exportingAll = true;
    try {
      const status = vaultStatus();
      if (status.blocked || (isTauri() && state.settings?.security?.useVault !== false && !status.ready)) {
        toast('Экспорт остановлен: контакты из хранилища ОС не удалось проверить.', 'error', 60000);
        return;
      }
      const approvedState = stateReviewWitness();
      const ok = await confirmModal({
        title: 'Экспортировать открытый JSON?',
        text: 'Файл не шифруется и может содержать email, телефоны и пароли персонажей открытым текстом, в том числе из хранилища ОС. Любой, кто получит файл, сможет их прочитать. Это не полная резервная копия хранилища ОС, GameCenter, сессий и отдельных журналов. Сохраняйте его только в доверенном месте.',
        okText: 'Экспортировать открытый JSON',
        danger: true
      });
      if (!ok) return;
      if (!stateStillMatches(approvedState)) {
        toast('Данные изменились после подтверждения. Начните экспорт заново.', 'warning', 60000);
        return;
      }
      await saveNow();
      if (!stateStillMatches(approvedState)) {
        toast('Данные изменились во время сохранения. Начните экспорт заново.', 'warning', 60000);
        return;
      }
      const data = serializeState();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadJson(data, `tvinoferma-export-${stamp}.json`);
      toast('Сохранение файла запрошено. Проверьте его; JSON не зашифрован.', 'warning', 60000);
    } catch {
      toast('Экспорт остановлен: не удалось подтвердить сохранение данных или подготовить файл.', 'error', 60000);
    } finally {
      exportingAll = false;
    }
  });

  // NEW: Advanced Export Button (Гибкий экспорт с выбором полей)
  document.getElementById('advanced-export-btn')?.addEventListener('click', () => {
    openExportDialog();
  });

  // Import File
  document.getElementById('import-file')?.addEventListener('change', async event => {
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

  // Только одно подтверждение/удаление за раз в этом UI. Другие окна и прямые IPC
  // не участвуют в этой блокировке.
  let dangerBusy = false;
  const runExclusiveDanger = async operation => {
    if (dangerBusy) {
      toast('Другое опасное действие ещё выполняется. Дождитесь его завершения.', 'warning');
      return;
    }
    dangerBusy = true;
    try {
      await operation();
    } catch {
      toast('Результат действия не подтверждён и может быть частичным. Проверьте данные и копии.', 'error', 60000);
    } finally {
      dangerBusy = false;
    }
  };

  // Свидетельство может содержать секреты: держим его только в памяти и не журналируем.
  // Оно не является проверкой файла или межпроцессной блокировкой.
  const dangerStateWitness = () => {
    const { ui: _ui, ...persisted } = state;
    const snapshot = JSON.stringify(persisted);
    if (typeof snapshot !== 'string') throw new Error('Нет снимка состояния');
    return snapshot;
  };

  // Опасные действия: описание каждого действия, подтверждение с числом записей и резервная копия перед удалением
  const runDanger = async kind => {
    const action = DANGER_ACTIONS[kind];
    const count = action.count(state);
    if (!count) {
      toast(`Удалять нечего: ${action.what} нет`, 'info');
      return;
    }
    let approvedState;
    try {
      approvedState = dangerStateWitness();
    } catch {
      toast('Удаление остановлено: не удалось проверить данные. Проверьте состояние и резервные копии.', 'error');
      return;
    }
    const isUnchanged = () => {
      try {
        return dangerStateWitness() === approvedState;
      } catch {
        return false;
      }
    };
    const reportChanged = () =>
      toast(
        'Данные изменились после подготовки удаления. Проверьте их и подтвердите действие заново.',
        'warning',
        60000
      );
    const accountWarning =
      kind === 'characters'
        ? ' Копия состояния не содержит контакты из хранилища ОС и сохранённые входы GameCenter: после удаления восстановить их из этой копии нельзя. Сохраните нужные данные отдельно.'
        : '';
    const ok = await confirmModal({
      title: `${action.title}?`,
      text: `Будет удалено: ${count} (${action.what}). ${action.description} Перед удалением создастся копия состояния; если это не удастся подтвердить, удаление остановится.${accountWarning}`,
      okText: `Удалить (${count})`,
      danger: true
    });
    if (!ok) return;
    if (!isUnchanged()) {
      reportChanged();
      return;
    }
    try {
      if (!getAdapter()) throw new Error('Хранилище недоступно');
      await saveNow();
      if (!isUnchanged()) {
        reportChanged();
        return;
      }
      const name = await createBackup(`before-delete-${kind}`);
      if (typeof name !== 'string' || !name.trim()) throw new Error('Копия не подтверждена');
    } catch {
      // Детали ошибки могут включать путь или чувствительные данные.
      console.warn('[DANGER] Не удалось подтвердить резервную копию; удаление остановлено.');
      toast(
        'Удаление остановлено: не удалось подтвердить сохранение и резервную копию. Проверьте данные и список копий.',
        'error',
        60000
      );
      return;
    }
    let accountRemovalUnconfirmed = false;
    let mutationStarted = false;
    try {
      // Импорт до последней проверки: во время ожидания данные могли измениться.
      const accountKeysOf =
        kind === 'characters' ? (await import('../modules/launcher/gameCenters.js')).accountKeysOf : undefined;
      if (!isUnchanged()) {
        reportChanged();
        return;
      }
      // Без await между проверкой и началом изменения в этом JS-контексте.
      assertStateWriteAvailable();
      mutationStarted = true;
      if (kind === 'parties') clearParties(state);
      else if (kind === 'marathons') clearMarathons(state);
      else {
        const { accountKeys } = clearCharacters(state, accountKeysOf);
        if (isTauri() && accountKeys.length) {
          const { forgetAccount } = await import('../modules/launcher/launch.js');
          const results = await Promise.allSettled(accountKeys.map(k => forgetAccount(k)));
          accountRemovalUnconfirmed = results.some(
            result => result.status === 'rejected' || (result.value !== null && result.value !== undefined)
          );
        }
      }
      // forceRenderAndPersist сохраняет данные и перерисовывает все вкладки
      await forceRenderAndPersist();
    } catch {
      if (mutationStarted) {
        haltAfterPartialStateChange();
        toast(
          'Результат удаления не подтверждён и может быть частичным. Сохранение и восстановление остановлены; проверьте данные и копии перед перезапуском.',
          'error',
          60000
        );
      } else {
        toast('Удаление остановлено: сохранение недоступно. Проверьте данные и резервные копии.', 'error', 60000);
      }
      return;
    }
    if (accountRemovalUnconfirmed) {
      toast(
        'Персонажи удалены, но удаление некоторых сохранённых входов не подтверждено. Проверьте хранилище ОС.',
        'warning',
        60000
      );
    } else {
      toast(`Удалено: ${count} (${action.what})`, 'success');
    }
  };
  document.getElementById('danger-zone')?.addEventListener('click', e => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-danger]'));
    if (btn?.dataset.danger && DANGER_ACTIONS[btn.dataset.danger]) {
      runExclusiveDanger(() => runDanger(btn.dataset.danger));
    }
  });

  // Полный сброс известных локальных данных. Некоторые записи ОС и журналы могут остаться.
  // Подтверждение отдельное и явное: действие необратимо, потому что копии тоже удаляются.
  document.getElementById('factory-reset-btn')?.addEventListener('click', () => {
    runExclusiveDanger(async () => {
      const { prepareFactoryReset, discardFactoryResetPlan, resetWarning, performFactoryReset } =
        await import('./factoryReset.js');
      let plan;
      try {
        plan = prepareFactoryReset(state);
      } catch {
        toast('Не удалось подготовить список данных для сброса. Проверьте состояние и резервные копии.', 'error');
        return;
      }
      const ok = await confirmModal({
        title: 'Удалить локальные данные?',
        text: resetWarning(plan.summary),
        okText: 'Удалить данные и копии',
        danger: true
      });
      if (!ok) {
        discardFactoryResetPlan(plan);
        return;
      }
      await performFactoryReset(state, plan);
    });
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
        prompt('Скопируйте путь вручную:', dirText);
      }
    }
  });
}
