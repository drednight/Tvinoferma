import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
export function normalizeNotes(value) {
  return (Array.isArray(value) ? value : [])
    .filter(n => n && typeof n.id === 'string')
    .slice(0, 50)
    .map(n => ({
      id: n.id.slice(0, 80),
      title: String(n.title || 'Заметка').slice(0, 100),
      body: String(n.body || '').slice(0, 12000)
    }));
}
export function mountNotes(panel, editing) {
  const select = document.createElement('select'),
    title = document.createElement('input'),
    body = document.createElement('textarea'),
    save = document.createElement('button'),
    add = document.createElement('button'),
    status = document.createElement('small');
  select.setAttribute('aria-label', 'Выбрать заметку');
  title.placeholder = 'Название заметки';
  title.maxLength = 100;
  body.placeholder = 'Текст заметки (не храните здесь пароли)';
  body.maxLength = 12000;
  body.rows = 6;
  save.textContent = 'Сохранить заметку';
  add.textContent = '＋ Новая заметка';
  save.type = add.type = 'button';
  save.className = add.className = 'btn';
  title.className = body.className = select.className = 'input';
  let notes = normalizeNotes(state.settings.ui.todayNotes),
    draftId = notes[0]?.id || crypto.randomUUID();
  const drafts = new Map();
  const remember = () => drafts.set(draftId, { title: title.value, body: body.value });
  const draw = () => {
    if (!notes.some(n => n.id === draftId) && !drafts.has(draftId)) drafts.set(draftId, { title: '', body: '' });
    const listed = [
      ...notes,
      ...[...drafts]
        .filter(([id]) => !notes.some(n => n.id === id))
        .map(([id, n]) => ({ id, ...n, title: n.title || 'Новая заметка (не сохранена)' }))
    ];
    select.replaceChildren(
      ...listed.map(n => {
        const option = document.createElement('option');
        option.value = n.id;
        option.textContent = n.title;
        return option;
      })
    );
    select.value = draftId;
    const note = drafts.get(draftId) || notes.find(n => n.id === draftId);
    title.value = note?.title || '';
    body.value = note?.body || '';
  };
  select.onchange = () => {
    remember();
    draftId = select.value;
    draw();
  };
  add.onclick = () => {
    if (notes.length + [...drafts.keys()].filter(id => !notes.some(n => n.id === id)).length >= 50) {
      status.textContent = 'Можно сохранить не более 50 заметок.';
      return;
    }
    remember();
    draftId = crypto.randomUUID();
    draw();
  };
  save.onclick = async () => {
    if (editing) return;
    if (!notes.some(n => n.id === draftId) && notes.length >= 50) {
      status.textContent = 'Достигнут лимит 50 заметок. Текст оставлен в полях.';
      return;
    }
    save.disabled = true;
    const savedId = draftId;
    for (const el of [select, add, title, body]) el.disabled = true;
    const previous = state.settings.ui.todayNotes;
    const next = normalizeNotes([
      ...notes.filter(n => n.id !== draftId),
      { id: draftId, title: title.value, body: body.value }
    ]);
    state.settings.ui.todayNotes = next;
    try {
      await persist();
      notes = next;
      drafts.delete(savedId);
      status.textContent = 'Сохранено';
      draw();
    } catch {
      state.settings.ui.todayNotes = previous;
      status.textContent = 'Сохранение недоступно. Текст оставлен в полях — скопируйте его перед закрытием.';
    } finally {
      save.disabled = false;
      for (const el of [select, add, title, body]) el.disabled = false;
    }
  };
  for (const el of [select, title, body, save, add]) el.disabled = editing;
  panel.append(select, title, body, save, add, status);
  draw();
}
