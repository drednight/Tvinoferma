// js/modules/characters/coinHistory.js
// Окно «История Древних монет» персонажа — в виде лога (как окно лога задачи).
// Правила истории: новые записи сверху, «+0» не пишется (при том же балансе меняется только
// дата последней проверки), количество записей не ограничено.

import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/utils.js';
import { openOverlay } from '../marathons/overlay.js';
import { formatCoins, formatDelta, normalizeCoinHistory, needsCoinRecheck } from '../../core/coins.js';
import { mskStampSeconds } from '../../core/msk.js';

const fmtDate = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Неизвестно';
  // Время по Москве: в истории монет сравнивают с игровыми событиями, а не с часами машины
  return mskStampSeconds(d);
};

function entryHtml(h) {
  const up = h.delta >= 0;
  const after = h.balanceAfter != null ? ` · баланс ${formatCoins(h.balanceAfter)}` : '';
  return `<div class="tl-entry ch-entry">
    <span class="tl-time">${escapeHtml(fmtDate(h.date || h.createdAt))}</span>
    <span class="tl-icon">${up ? '📈' : '📉'}</span>
    <span><strong class="${up ? 'ch-up' : 'ch-down'}">${formatDelta(h.delta)}</strong>${after} <span class="muted">· ${escapeHtml(h.note || 'Операция')}</span></span>
  </div>`;
}

export function openCoinHistory(charOrId) {
  const id = typeof charOrId === 'string' ? charOrId : charOrId?.id;
  const char = [...state.characters, ...state.archivedCharacters].find(c => c.id === id)
    || (typeof charOrId === 'object' ? charOrId : null);
  if (!char) return;

  const archived = state.archivedCharacters.some(item => item.id === char.id);
  const history = normalizeCoinHistory(char.coinHistory);
  const ov = openOverlay({ title: `🪙 История Древних монет: ${char.nick}`, wide: true });
  const last = char.lastCoinUpdate ? fmtDate(char.lastCoinUpdate) : 'ещё не проверялся';

  const stale = needsCoinRecheck(char);
  ov.body.innerHTML = `
    ${stale ? `<p class="tf-warn" data-coin-warn>⚠ Баланс и записи ниже сделаны до исправления разбора: значение с запятой (28,5) могло записаться как 285.${archived ? ' Персонаж в архиве, поэтому автоматическая перепроверка отключена.' : ' Нажмите «Перепроверить» — баланс будет прочитан с сайта заново, в историю добавится запись о разнице.'}</p>` : ''}
    <div class="tl-summary">
      <strong>🪙 ${formatCoins(char.ancientCoins || 0)}</strong>
      <span class="muted">Последняя проверка: ${escapeHtml(last)}</span>
      <span class="muted">Записей: ${history.length}</span>
    </div>
    <div class="tl-entries tl-full">${history.length ? history.map(entryHtml).join('') : '<div class="muted" style="padding:8px;">История пуста: баланс ещё не менялся.</div>'}</div>
    <p class="muted" style="font-size:0.78rem; margin:8px 0 0;">Если при проверке баланс не изменился, запись не добавляется — обновляется только дата последней проверки.</p>`;

  ov.foot.innerHTML = `<span></span><div class="row gap">${stale && !archived ? '<button type="button" class="btn primary" data-recheck>🔄 Перепроверить</button>' : ''}<button type="button" class="btn" data-copy>📋 Скопировать лог</button><button type="button" class="btn primary" data-close>Закрыть</button></div>`;
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  const recheck = ov.foot.querySelector('[data-recheck]');
  if (recheck) recheck.onclick = async () => {
    recheck.disabled = true; recheck.textContent = '⏳ Проверяю…';
    try {
      const { refreshBalanceFor } = await import('../sync/syncManager.js');
      await refreshBalanceFor(char);
      ov.close();
      openCoinHistory(char.id);          // заново: уже с новым балансом и без предупреждения
    } catch (e) {
      recheck.disabled = false; recheck.textContent = '🔄 Перепроверить';
    }
  };
  ov.foot.querySelector('[data-copy]').onclick = async (e) => {
    const text = [
      `История Древних монет: ${char.nick} (баланс ${formatCoins(char.ancientCoins || 0)}, проверка: ${last})`,
      ...history.map(h => `${fmtDate(h.date || h.createdAt)}  ${formatDelta(h.delta)}${h.balanceAfter != null ? `  баланс ${formatCoins(h.balanceAfter)}` : ''}  ${h.note || 'Операция'}`)
    ].join('\n');
    try { await navigator.clipboard.writeText(text); e.target.textContent = '✔ Скопировано'; }
    catch (_) { e.target.textContent = 'Не удалось скопировать'; }
  };
}
