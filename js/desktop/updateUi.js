// js/desktop/updateUi.js
// Интерфейс обновления: кнопка «Доступно обновление» в шапке, окно с подробностями
// и блок в «Настройки → Обновления». Данные берёт из updateState.js.

import { escapeHtml } from '../core/utils.js';
import { openOverlay } from '../modules/marathons/overlay.js';
import { installUpdate, checkForUpdates } from './updater.js';
import {
  subscribeUpdate, hasUpdate, isBusy, badgeLabel, installButtonLabel, statusText, checkedAtText, formatVersion
} from './updateState.js';

const NOTES_LIMIT = 4000;
let dialog = null;
let unsubscribeDialog = null;

export function openUpdateDialog() {
  if (dialog) return dialog;
  const ov = openOverlay({ title: '⬆️ Доступно обновление', wide: false, onClose: () => { dialog = null; unsubscribeDialog?.(); unsubscribeDialog = null; } });
  dialog = ov;

  const draw = (s) => {
    const busy = isBusy(s);
    const notes = (s.notes || '').trim();
    ov.body.innerHTML = `
      <div class="upd-versions">
        <span class="muted">Сейчас: <strong>${escapeHtml(formatVersion(s.currentVersion) || '—')}</strong></span>
        <span>→</span>
        <span>Новая: <strong>${escapeHtml(formatVersion(s.version))}</strong></span>
      </div>
      ${notes ? `<h4 class="upd-h">Что нового</h4><pre class="upd-notes">${escapeHtml(notes.slice(0, NOTES_LIMIT))}${notes.length > NOTES_LIMIT ? '\n…' : ''}</pre>` : '<p class="muted">Описание изменений не указано.</p>'}
      ${busy ? `<div class="upd-progress"><div class="upd-bar"><span style="width:${s.status === 'installing' ? 100 : (s.progress ?? 5)}%"></span></div>
        <small class="muted">${escapeHtml(s.status === 'installing' ? 'Установка, приложение перезапустится…' : s.progress == null ? 'Загрузка…' : `Загрузка ${s.progress}%`)}</small></div>` : ''}
      ${s.status === 'error' ? `<p class="upd-error">⚠️ ${escapeHtml(s.error || 'Не удалось установить обновление')}</p>` : ''}`;
    ov.foot.innerHTML = `<button type="button" class="btn ghost" data-later ${busy ? 'disabled' : ''}>Позже</button>
      <button type="button" class="btn primary" data-install ${busy ? 'disabled' : ''}>${s.status === 'error' ? 'Повторить' : 'Установить и перезапустить'}</button>`;
    ov.foot.querySelector('[data-later]').onclick = () => ov.close();
    ov.foot.querySelector('[data-install]').onclick = () => { installUpdate(); };
  };

  unsubscribeDialog = subscribeUpdate((s) => {
    if (!dialog) return;
    if (!hasUpdate(s)) { ov.close(); return; }
    draw(s);
  });
  if (!dialog) { unsubscribeDialog?.(); unsubscribeDialog = null; }
  return ov;
}

/** Подключает кнопку в шапке и блок в настройках. Вызывать один раз при старте. */
export function initUpdateUi() {
  const badge = document.getElementById('update-badge');
  const status = document.getElementById('update-status');
  const checkedAt = document.getElementById('update-checked-at');
  const installBtn = document.getElementById('install-update-btn');
  const checkBtn = document.getElementById('check-updates-btn');
  const supported = !!window.__TAURI_INTERNALS__;

  badge?.addEventListener('click', () => openUpdateDialog());
  installBtn?.addEventListener('click', () => { installUpdate(); });
  checkBtn?.addEventListener('click', () => checkForUpdates());

  subscribeUpdate((s) => {
    const show = hasUpdate(s);
    if (badge) {
      badge.hidden = !show;
      if (show) {
        badge.textContent = badgeLabel(s);
        badge.classList.toggle('is-busy', isBusy(s));
        badge.classList.toggle('is-error', s.status === 'error');
        badge.title = `Версия ${formatVersion(s.version)}: нажмите, чтобы посмотреть, что нового, и установить`;
      }
    }
    if (status) status.textContent = statusText(s, { supported });
    if (checkedAt) checkedAt.textContent = checkedAtText(s);
    if (installBtn) {
      installBtn.hidden = !show;
      if (show) {
        installBtn.textContent = installButtonLabel(s);
        installBtn.disabled = isBusy(s);
      }
    }
    if (checkBtn) {
      checkBtn.disabled = s.status === 'checking' || isBusy(s) || !supported;
      checkBtn.textContent = s.status === 'checking' ? 'Проверяю…' : 'Проверить обновления';
    }
  });
}
