import { escapeHtml } from '../core/utils.js';

async function defaultReadStatus() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('bank_status');
}
const dateLabel = at => {
  const date = new Date(Number(at) * 1000);
  return at != null && Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU') : 'не сообщена';
};

export function initCookieBankInfo({ characters, readStatus = defaultReadStatus }) {
  const panel = document.getElementById('cookie-bank-info');
  const button = document.getElementById('cookie-bank-refresh');
  const target = document.getElementById('cookie-bank-expiry');
  if (!button || !target) return;
  let loaded = false;
  button.onclick = async () => {
    button.disabled = true;
    target.textContent = 'Читаю сохранённые куки сайта…';
    try {
      const rows = await readStatus();
      target.replaceChildren();
      for (const character of characters()) {
        const row = rows.find(item => item.charId === character.id);
        const line = document.createElement('details');
        line.className = 'cookie-bank-character';
        const metadata = Array.isArray(row?.cookieMetadata) ? row.cookieMetadata : [];
        const sessions = metadata.length
          ? metadata.filter(cookie => cookie.kind === 'session').length
          : Number(row?.sessionCookies) || 0;
        const persistent = metadata.filter(cookie => cookie.kind === 'persistent').length;
        const label = row?.error
          ? 'не удалось прочитать банк'
          : !row || !row.cookies
            ? 'нет сохранённых куки'
            : `${row.cookies} куки · сессионных: ${sessions} · постоянных: ${metadata.length ? persistent : 'нет подробных данных'}`;
        const summary = document.createElement('summary');
        summary.textContent = `${character.nick || 'Персонаж'} → ${label}`;
        line.append(summary);
        if (row && !row.error && row.cookies) {
          const saved = document.createElement('p');
          saved.className = 'muted';
          saved.textContent = `Сохранены в банк: ${dateLabel(row.savedAt || null)} (время этого ПК). Это не дата окончания входа.`;
          line.append(saved);
          if (metadata.length) {
            const wrap = document.createElement('div');
            wrap.className = 'promo-scroll';
            wrap.innerHTML = `<table class="cookie-bank-table"><thead><tr><th>Куки</th><th>Тип</th><th>Срок истечения</th></tr></thead><tbody>${metadata
              .map((cookie, index) => {
                const type =
                  cookie.kind === 'session'
                    ? 'Сессионная'
                    : cookie.kind === 'persistent'
                      ? 'Постоянная'
                      : 'Не распознана';
                const expires =
                  cookie.kind === 'session'
                    ? 'Не задан сайтом — точной даты нет'
                    : cookie.expiresAt != null
                      ? `${dateLabel(cookie.expiresAt)}${Number(cookie.expiresAt) * 1000 <= Date.now() ? ' · срок истёк' : ''}`
                      : 'Не сообщён';
                const basis =
                  cookie.expiryBasis === 'savedAtPlusMaxAge' ? ' · ориентир: Max-Age от времени сохранения' : '';
                return `<tr><td>№ ${index + 1}</td><td>${type}</td><td>${escapeHtml(expires + basis)}</td></tr>`;
              })
              .join('')}</tbody></table>`;
            line.append(wrap);
          } else {
            const hint = document.createElement('p');
            hint.textContent =
              'Подробные сроки недоступны в этой версии банка. Обновите приложение; значения куки не раскрываются.';
            line.append(hint);
          }
        }
        target.append(line);
      }
      if (!target.childElementCount) target.textContent = 'Персонажи пока не добавлены.';
      loaded = true;
    } catch {
      target.textContent = 'Банк можно прочитать только в приложении Windows. Доступ к сайту сейчас не проверялся.';
    } finally {
      button.disabled = false;
    }
  };
  if (panel)
    panel.ontoggle = () => {
      if (panel.open && !loaded && !button.disabled) void button.onclick();
    };
  else void button.onclick();
}
