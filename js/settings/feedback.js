// js/settings/feedback.js
// Раздел «Предложения»: отчёт об ошибке уходит на GitHub уже с версией приложения
// и диагностикой парсеров — пользователю остаётся описать шаги и приложить скриншот.
// Формы GitHub Issues поддерживают prefill: значение поля подставляется query-параметром
// по его id (у bug_report.yml это version и logs).

import { buildDiagnostics } from '../core/parserHealth.js';
import { copyToClipboard } from '../core/utils.js';
import { toast } from '../core/ui.js';

const ISSUES_NEW = 'https://github.com/drednight/Tvinoferma/issues/new';

/** Диагностика целиком уходит в параметр URL; у ссылки есть практический предел, поэтому обрезка. */
const LOGS_LIMIT = 3000;

/** Ссылка на Telegram автора. Пустая строка — карточка Telegram в разделе не показывается. */
export const TELEGRAM_URL = '';

/** Ссылка на форму ошибки с предзаполненными версией и диагностикой. */
export function bugReportUrl({ version = '', logs = '' } = {}) {
  const q = new URLSearchParams({ template: 'bug_report.yml' });
  if (version && version !== '—') q.set('version', version);
  if (logs) q.set('logs', logs.length > LOGS_LIMIT ? `${logs.slice(0, LOGS_LIMIT)}\n…` : logs);
  return `${ISSUES_NEW}?${q.toString()}`;
}

/** Открывает ссылку во внешней вкладке (в Tauri — в системном браузере). */
function openExternal(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function bindFeedback() {
  const tgRow = document.getElementById('feedback-telegram-row');
  const tgLink = document.getElementById('feedback-telegram-link');
  if (tgRow && tgLink && TELEGRAM_URL) {
    tgLink.href = TELEGRAM_URL;
    tgRow.hidden = false;
  }

  document.getElementById('feedback-bug-btn')?.addEventListener('click', async () => {
    const version = document.getElementById('app-version')?.textContent?.trim() || '';
    const logs = buildDiagnostics();
    const copied = await copyToClipboard(logs);
    openExternal(bugReportUrl({ version, logs }));
    toast(
      copied
        ? 'Диагностика скопирована и подставлена в форму — опишите, что произошло, и приложите скриншот.'
        : 'Форма открыта, но скопировать диагностику не удалось — вставьте её вручную (копия есть в «Оптимизации»).',
      copied ? 'success' : 'warning',
      4200
    );
  });
}
