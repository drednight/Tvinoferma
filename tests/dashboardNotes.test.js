import { beforeEach, it, expect, vi } from 'vitest';
const persist = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../js/core/storage.js', () => ({ persist }));
import { state } from '../js/core/state.js';
import { mountNotes, normalizeNotes } from '../js/modules/dashboard/notesWidget.js';
beforeEach(() => {
  document.body.innerHTML = '<section></section>';
  state.settings.ui = { todayNotes: [{ id: 'a', title: 'Первая', body: 'Текст' }] };
  persist.mockReset().mockResolvedValue();
});
const mount = () => {
  mountNotes(document.querySelector('section'), false);
  return {
    title: document.querySelector('input'),
    body: document.querySelector('textarea'),
    save: document.querySelectorAll('button')[0],
    add: document.querySelectorAll('button')[1],
    select: document.querySelector('select')
  };
};
it('does not execute or save anything on mounting; saves a named note explicitly', async () => {
  const ui = mount();
  expect(persist).not.toHaveBeenCalled();
  ui.title.value = 'Новая';
  ui.body.value = 'Описание';
  ui.save.click();
  await vi.waitFor(() => expect(document.querySelector('small').textContent).toBe('Сохранено'));
  expect(state.settings.ui.todayNotes[0]).toEqual({ id: 'a', title: 'Новая', body: 'Описание' });
});
it('retains unsaved text when navigating away and back', () => {
  const ui = mount();
  ui.body.value = 'Черновик';
  ui.add.click();
  ui.select.value = 'a';
  ui.select.dispatchEvent(new Event('change'));
  expect(ui.body.value).toBe('Черновик');
  expect(persist).not.toHaveBeenCalled();
});
it('rolls back stored notes and preserves input when protected persistence fails', async () => {
  persist.mockRejectedValueOnce(new Error('blocked'));
  const ui = mount();
  ui.body.value = 'Не потерять';
  ui.save.click();
  await vi.waitFor(() => expect(ui.save.disabled).toBe(false));
  expect(ui.body.value).toBe('Не потерять');
  expect(state.settings.ui.todayNotes[0].body).toBe('Текст');
});
it('does not silently truncate a newly created note at capacity', () => {
  state.settings.ui.todayNotes = Array.from({ length: 50 }, (_, i) => ({ id: String(i), title: 'Заметка', body: '' }));
  const ui = mount();
  ui.add.click();
  expect(document.querySelector('small').textContent).toContain('50');
  expect(persist).not.toHaveBeenCalled();
});
it('bounds imported titles, text and collection size', () => {
  const notes = normalizeNotes(
    Array.from({ length: 60 }, () => ({ id: 'a', title: 'a'.repeat(200), body: 'b'.repeat(14000) }))
  );
  expect(notes).toHaveLength(50);
  expect(notes[0].title).toHaveLength(100);
  expect(notes[0].body).toHaveLength(12000);
});
