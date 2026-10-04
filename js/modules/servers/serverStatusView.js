// js/modules/servers/serverStatusView.js
// Плашка «Статус серверов»: простое перечисление серверов с отметкой онлайн/оффлайн, как на странице сайта.
// Кнопок и выбора нет — только показ. Стоит в шапке приложения и в окне передачи предметов.

import { escapeHtml } from '../../core/utils.js';
import { formatAge } from '../../core/freshness.js';
import { getServerStatus, onServerStatus } from './serverStatus.js';

/** Подпись справа от заголовка: «обновлено 5 мин назад» / «⏳ обновляю…» / «не удалось обновить, данные от …». */
export function serverStatusMeta(snapshot, now = Date.now()) {
  const { status, busy, error } = snapshot;
  const at = status?.at ? new Date(status.at).getTime() : NaN;
  const age = Number.isFinite(at) ? formatAge(now - at) : '';
  if (busy) return { text: status ? `⏳ обновляю… (данные: ${age})` : '⏳ читаю…', warn: false };
  if (!status?.servers?.length) return { text: error ? '⚠ не удалось прочитать' : 'нет данных', warn: !!error };
  if (error) return { text: `⚠ не обновилось, данные: ${age}`, warn: true };
  return { text: `обновлено ${age}`, warn: false };
}

/** Подсказка: что за плашка, рекомендуемый сервер, когда и откуда прочитано. */
function titleText(snapshot, meta) {
  const { status, error } = snapshot;
  const lines = ['Статус серверов — страница pwonline.ru/server_status.php'];
  if (status?.recommended) lines.push(`Рекомендуемый сервер: ${status.recommended}`);
  if (status?.at) lines.push(`Прочитано: ${new Date(status.at).toLocaleString('ru-RU')}`);
  if (error) lines.push(error.status === 'challenge' ? 'Сайт показал проверку безопасности' : `Ошибка чтения: ${error.error || error.status}`);
  lines.push('Обновляется при запуске и по расписанию (Настройки → Свежесть данных)');
  return lines.join('\n') || meta.text;
}

/**
 * HTML плашки.
 * @param {{ status: object|null, busy: boolean, error: object|null }} snapshot
 */
export function serverStatusHtml(snapshot, now = Date.now()) {
  const meta = serverStatusMeta(snapshot, now);
  const servers = snapshot.status?.servers || [];
  const list = servers.length
    ? `<ul class="srv-list">${servers.map(s => {
      const cls = s.online === true ? 'is-on' : s.online === false ? 'is-off' : 'is-unknown';
      const tip = s.online === true ? 'Онлайн' : s.online === false ? 'Оффлайн' : 'Состояние неизвестно';
      return `<li class="srv ${cls}" title="${tip}"><span class="srv-dot"></span>${escapeHtml(s.name)}</li>`;
    }).join('')}</ul>`
    : '';
  return `<div class="srv-plaque${snapshot.busy ? ' is-busy' : ''}${meta.warn ? ' is-warn' : ''}" title="${escapeHtml(titleText(snapshot, meta))}">
      <div class="srv-head"><b>Статус серверов</b><span class="srv-age">${escapeHtml(meta.text)}</span></div>${list}</div>`;
}

/**
 * Рисует плашку в элемент и держит её актуальной: при каждом чтении и раз в минуту (подпись «5 мин назад»).
 * @returns {() => void} остановка
 */
export function mountServerStatus(el, { tickMs = 60000 } = {}) {
  if (!el) return () => {};
  const draw = () => { el.innerHTML = serverStatusHtml(getServerStatus()); };
  draw();
  const off = onServerStatus(draw);
  const id = setInterval(draw, tickMs);
  return () => { off(); clearInterval(id); };
}
