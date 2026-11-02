async function defaultReadStatus() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('bank_status');
}

export function initCookieBankInfo({ characters, readStatus = defaultReadStatus }) {
  const button = document.getElementById('cookie-bank-refresh');
  const target = document.getElementById('cookie-bank-expiry');
  if (!button || !target) return;
  button.onclick = async () => {
    button.disabled = true;
    target.textContent = 'Читаю сроки сохранённых куки…';
    try {
      const rows = await readStatus();
      target.replaceChildren();
      for (const character of characters()) {
        const row = rows.find(item => item.charId === character.id);
        const line = document.createElement('p');
        const expiry = Number(row?.expiresAt);
        const date = expiry > 0 ? new Date(expiry * 1000) : null;
        const label = row?.error
          ? 'не удалось прочитать банк'
          : !row || !row.cookies
            ? 'нет сохранённых куки'
            : date && Number.isFinite(date.getTime())
              ? `${date.toLocaleString('ru-RU')} ${expiry * 1000 <= Date.now() ? '· срок истёк' : ''}${row.sessionCookies ? ' · также есть сессионные куки' : ''}`
              : 'сессионные куки — дата не задана';
        line.textContent = `${character.nick || 'Персонаж'} → ${label}`;
        target.append(line);
      }
      if (!target.childElementCount) target.textContent = 'Персонажи пока не добавлены.';
    } catch {
      target.textContent = 'Сроки доступны в приложении при чтении банка куки.';
    } finally {
      button.disabled = false;
    }
  };
  void button.onclick();
}
