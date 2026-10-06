// js/modules/characters/statsImport.js
// Окно «Распознать характеристики со скриншота»: выбор картинки → разбор → подтверждение → перенос в форму.
//
// Разбор делает Rust (`stats_ocr.rs`, встроенный в Windows OCR), сопоставление подпись↔значение —
// statsOcr.js. Результат никогда не применяется молча: пользователь видит каждое значение, может снять
// галочку и поправить число. Это важно, потому что OCR путает цифры («3 680» → «з 680», «12%» → «1296»).

import { isTauri } from '../../core/storage.js';
import { toast } from '../../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { openOverlay } from '../marathons/overlay.js';
import { readStats, readSummary, parseNumber } from './statsOcr.js';

const errText = (e) => String(e?.message || e || 'неизвестная ошибка');

async function invoke(cmd, args) {
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call(cmd, args);
}

/** Доступен ли разбор скриншотов (есть ли в системе распознаватель с русским языком). */
export async function statsOcrAvailable() {
  if (!isTauri()) return false;
  try { return await invoke('stats_ocr_available'); } catch { return false; }
}

/**
 * Открывает окно разбора скриншота.
 * @param {{ onApply: (values: Record<string, number>) => void, current?: Record<string, number> }} opts
 *   `onApply` получает подтверждённые характеристики, `current` — сохранённые сейчас (для сравнения «было → стало»)
 * @returns {Promise<any>} закрытое окно
 */
export async function openStatsImport({ onApply, current = {} } = {}) {
  const ov = openOverlay({ title: '📷 Распознать характеристики со скриншота', wide: true });

  /** @type {Array<{key: string, label: string, value: number, line: string, confidence: number}>} */
  let found = [];
  /** @type {string[]} */
  let missed = [];

  if (!isTauri()) {
    ov.body.innerHTML = '<div class="empty-state">Разбор скриншота работает в приложении: в браузере нет доступа к распознаванию текста Windows.</div>';
    ov.foot.innerHTML = '<button type="button" class="btn primary" data-x="close">Закрыть</button>';
    bindClose(ov);
    return ov;
  }

  const available = await statsOcrAvailable();

  const intro = `
    <p class="muted">Сфотографируйте или снимите окно с характеристиками персонажа (например, клавишей Print Screen) и выберите файл.
    Распознавание идёт на этом компьютере встроенными средствами Windows — картинка никуда не отправляется.</p>`;

  ov.body.innerHTML = intro + `
    <div class="si-drop" id="si-drop">
      <input id="si-file" type="file" accept="image/png,image/jpeg,image/webp,image/bmp" hidden />
      <div class="si-drop-inner">
        <span class="si-drop-ico" aria-hidden="true">🖼</span>
        <b>Выберите скриншот</b>
        <span class="muted">или перетащите файл сюда</span>
        <button type="button" class="btn primary" data-x="pick">Выбрать файл…</button>
      </div>
    </div>
    <div id="si-result"></div>`;

  ov.foot.innerHTML = `<button type="button" class="btn ghost" data-x="close">Отмена</button>
    <button type="button" class="btn primary" data-x="apply" disabled>Перенести в форму</button>`;

  const drop = /** @type {HTMLElement} */ (ov.body.querySelector('#si-drop'));
  const resultEl = /** @type {HTMLElement} */ (ov.body.querySelector('#si-result'));
  const fileInput = /** @type {HTMLInputElement} */ (ov.body.querySelector('#si-file'));
  const applyBtn = /** @type {HTMLButtonElement} */ (ov.foot.querySelector('[data-x="apply"]'));

  if (!available) {
    ov.body.innerHTML = '<div class="empty-state">В Windows не установлен компонент распознавания текста для русского языка. Он ставится вместе с языковым пакетом: «Параметры → Время и язык → Язык и регион → Русский → Параметры языка → Оптическое распознавание символов».</div>';
    applyBtn.disabled = true;
    bindClose(ov);
    return ov;
  }

  const drawResult = () => {
    if (!found.length) {
      resultEl.innerHTML = `<div class="empty-state">Характеристики не распознаны.${missed.length ? ' Проверьте, что на скриншоте видно окно с характеристиками и текст читается.' : ''}</div>`;
      applyBtn.disabled = true;
      return;
    }
    resultEl.innerHTML = `
      <div class="si-summary">
        <b>${escapeHtml(readSummary(found, missed))}</b>
        <span class="muted">Проверьте значения: распознавание может путать цифры. Снимите галочку там, где число неверное.</span>
      </div>
      <div class="si-grid">
        ${found.map(item => {
          const old = savedValue(current, item.key);
          return `
          <label class="si-item">
            <input type="checkbox" checked data-key="${escapeHtml(item.key)}" />
            <span class="si-item-label">
              <b>${escapeHtml(item.label)}</b>
              <small class="muted" title="Что распознано в строке скриншота">распознано: ${escapeHtml(item.line)}</small>
              <small class="muted si-old" title="Значение, сохранённое в карточке сейчас">было: ${old === null ? '—' : old.toLocaleString('ru-RU')}</small>
            </span>
            <input class="input si-item-value ${compareClass(old, item.value)}" type="number" step="any" min="0" value="${item.value}" data-key="${escapeHtml(item.key)}" data-old="${old ?? ''}" />
          </label>`;
        }).join('')}
      </div>
      ${missed.length ? `<details class="si-missed"><summary>Не распознано: ${missed.length}</summary>
        <p class="muted">${missed.map(escapeHtml).join(', ')}. Эти поля останутся как были.</p></details>` : ''}`;
    applyBtn.disabled = false;
  };

  /** Разбирает выбранный файл и показывает результат. */
  const handleFile = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) { toast('Нужен файл изображения (PNG или JPEG)', 'error'); return; }
    resultEl.innerHTML = '<div class="si-loading"><span class="srv-age">⏳ Распознаю текст на скриншоте…</span></div>';
    applyBtn.disabled = true;
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const res = await invoke('stats_ocr_read', { image: Array.from(buffer) });
      const parsed = readStats(res?.lines || []);
      found = parsed.found;
      missed = parsed.missed;
      drawResult();
      if (!found.length) toast('Характеристики на скриншоте не распознаны', 'warning');
    } catch (e) {
      found = [];
      missed = [];
      resultEl.innerHTML = `<div class="empty-state">Не удалось разобрать скриншот: ${escapeHtml(errText(e))}</div>`;
    }
  };

  ov.el.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-x]'));
    if (!btn) return;
    const act = btn.dataset.x;
    if (act === 'close') { ov.close(); return; }
    if (act === 'pick') { fileInput.click(); return; }
    if (act === 'apply') {
      // Берём только отмеченные строки, а числа — из полей: пользователь мог поправить распознанное
      const values = {};
      for (const box of ov.body.querySelectorAll('input[type="checkbox"][data-key]')) {
        if (!/** @type {HTMLInputElement} */ (box).checked) continue;
        const key = /** @type {HTMLInputElement} */ (box).dataset.key;
        const field = ov.body.querySelector(`input.si-item-value[data-key="${CSS.escape(key)}"]`);
        const value = parseNumber(/** @type {HTMLInputElement} */ (field)?.value ?? '', 'decimal');
        if (key && value !== null) values[key] = value;
      }
      if (!Object.keys(values).length) { toast('Отметьте хотя бы одну характеристику', 'warning'); return; }
      onApply?.(values);
      ov.close();
    }
  });

  // Правка числа в окне перекрашивает его относительно сохранённого значения
  ov.body.addEventListener('input', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (!input?.classList?.contains('si-item-value')) return;
    input.classList.remove('is-up', 'is-down');
    const old = input.dataset.old === '' ? null : Number(input.dataset.old);
    const cls = compareClass(old, parseNumber(input.value, 'decimal') ?? NaN);
    if (cls) input.classList.add(cls);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    handleFile(file);
  });

  // Перетаскивание файла на область
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
  }));
  drop.addEventListener('drop', (e) => {
    const file = /** @type {DragEvent} */ (e).dataTransfer?.files?.[0];
    handleFile(file);
  });

  // Вставка скриншота из буфера обмена (Ctrl+V) — самый быстрый путь после Print Screen
  const onPaste = (e) => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    handleFile(item.getAsFile());
  };
  bindClose(ov);
  document.addEventListener('paste', onPaste);
  ov.el.addEventListener('remove', () => document.removeEventListener('paste', onPaste));

  return ov;
}

/** Сохранённое значение стата: число > 0 или null (если характеристика ещё не заполнена). */
const savedValue = (current, key) => {
  const n = Number(current?.[key]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Подсветка нового значения относительно сохранённого:
 * сохранённое выше нового — красный (is-down), ниже — зелёный (is-up), равно или нет сохранённого — без подсветки.
 */
export function compareClass(oldValue, newValue) {
  if (oldValue === null || oldValue === undefined || !Number.isFinite(newValue)) return '';
  if (oldValue > newValue) return 'is-down';
  if (oldValue < newValue) return 'is-up';
  return '';
}

function bindClose(ov) {
  ov.el.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-x="close"]'));
    if (btn) ov.close();
  });
}
