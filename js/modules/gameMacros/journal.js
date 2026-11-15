// Copy the complete retained snapshot, not the visible/reversed/scrolling DOM fragment.
export async function copyJournal(lines, container, status) {
  const entries = (Array.isArray(lines) ? lines : []).filter(line => typeof line === 'string');
  const text = entries.join('\n');
  container.querySelector('[data-gm-journal-copy-fallback]')?.remove();
  if (!text) {
    status.textContent = 'Журнал пуст — копировать нечего.';
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = `Скопирован весь сохранённый лог: ${entries.length} строк.`;
  } catch {
    // No additional native clipboard privileges: provide a visible manual-copy fallback.
    const field = document.createElement('textarea');
    field.dataset.gmJournalCopyFallback = '';
    field.className = 'gm-journal-copy-fallback';
    field.setAttribute('aria-label', 'Весь сохранённый лог для ручного копирования');
    field.readOnly = true;
    field.rows = 8;
    field.value = text;
    container.append(field);
    field.focus();
    field.select();
    status.textContent = 'Автокопирование недоступно. Весь лог выделен в поле ниже — нажмите Ctrl+C.';
  }
}
