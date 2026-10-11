// js/modules/automation/scriptUi.js
// Общий вид диалогов скриптов: промокоды (promo.js), передача предметов (transfer.js),
// активация подарков (shop.js) и сундук караванщика (caravan.js).
// Здесь только разметка: блок «что сделает скрипт», секции формы, полоса прогресса и чипы итогов.
// Оформление — css/modules/promo.css, раздел «Общий язык диалогов скриптов».
// Логика, данные и вызовы команд живут в самих диалогах и этим модулем не затрагиваются.

import { escapeHtml } from '../../core/utils.js';

/** Блок «что сделает скрипт» (или предупреждение). tone: info | warn | danger. */
export function noteHtml({ icon = 'ℹ️', title = '', text = '', tone = 'info' } = {}) {
  if (!text) return '';
  return `<div class="sd-note sd-note-${escapeHtml(tone)}">
      <span class="sd-note-icon" aria-hidden="true">${escapeHtml(icon)}</span>
      <div class="sd-note-body">
        ${title ? `<b class="sd-note-title">${escapeHtml(title)}</b>` : ''}
        <div class="sd-note-text">${text}</div>
      </div>
    </div>`;
}

/** Секция формы: подпись с номером шага и пояснением, справа — сводка (счётчики), под ней содержимое. */
export function sectionHtml(title, { step = '', hint = '', aside = '', labelFor = '', body = '' } = {}) {
  const num = step ? `<span class="sd-step">${escapeHtml(step)}</span>` : '';
  const head = labelFor
    ? `<label class="sd-section-title" for="${escapeHtml(labelFor)}">${num}${escapeHtml(title)}</label>`
    : `<span class="sd-section-title">${num}${escapeHtml(title)}</span>`;
  return `<section class="sd-section">
      <div class="sd-section-head">
        ${head}
        ${hint ? `<span class="sd-section-hint">${escapeHtml(hint)}</span>` : ''}
        ${aside ? `<span class="sd-section-aside">${aside}</span>` : ''}
      </div>
      ${body}
    </section>`;
}

export const pctOf = (done, total) => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);

/** Прогресс работы: «N из M», процент и заполняемая полоса. id — базовый идентификатор элементов. */
export function progressHtml(id, done, total) {
  const pct = pctOf(done, total);
  return `<div class="sd-progress">
      <div class="sd-progress-top"><b id="${escapeHtml(id)}">${done} из ${total}</b><span class="sd-progress-pct" id="${escapeHtml(id)}-pct">${pct}%</span></div>
      <div class="sd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span id="${escapeHtml(id)}-bar" style="width:${pct}%"></span></div>
    </div>`;
}

/** Обновляет полосу прогресса по id: текст, процент и заполнение. root — элемент, внутри которого искать. */
export function setProgress(root, id, done, total) {
  const pct = pctOf(done, total);
  const text = root.querySelector(`#${id}`);
  if (text) text.textContent = `${done} из ${total}`;
  const pctEl = root.querySelector(`#${id}-pct`);
  if (pctEl) pctEl.textContent = `${pct}%`;
  const bar = root.querySelector(`#${id}-bar`);
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.parentElement?.setAttribute('aria-valuenow', String(pct));
  }
}

/**
 * Итог чистыми чипами: [{ icon, label, value, tone, zero }].
 * Нулевые значения скрыты, если для них не сказано zero: true — иначе чипы шумят нулями.
 */
export function chipsHtml(items = []) {
  const rows = items.filter(i => i && (Number(i.value) !== 0 || i.zero));
  if (!rows.length) return '';
  return `<div class="sd-chips">${rows.map(i => `<span class="sd-chip${i.tone ? ` sd-chip-${escapeHtml(i.tone)}` : ''}">${
    i.icon ? `<span aria-hidden="true">${escapeHtml(i.icon)}</span>` : ''}${escapeHtml(i.label)}${
    i.value == null ? '' : ` <b>${escapeHtml(String(i.value))}</b>`}</span>`).join('')}</div>`;
}
