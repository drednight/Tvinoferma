import { beforeEach, expect, it, vi } from 'vitest';
import { copyJournal } from '../js/modules/gameMacros/journal.js';
let write;
beforeEach(() => {
  document.body.innerHTML = '<section id="journal"><p role="status"></p></section>';
  write = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
});
const host = () => document.getElementById('journal');
const status = () => document.querySelector('[role=status]');
it('copies every retained line chronologically, including newlines and Unicode, without HTML parsing', async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `${i} · #Дреднайт <message>`);
  await copyJournal(lines, host(), status());
  expect(write).toHaveBeenCalledWith(lines.join('\n'));
  expect(status().textContent).toContain('300 строк');
  expect(document.querySelector('message')).toBeNull();
});
it('does not overwrite the clipboard with an empty-state placeholder', async () => {
  await copyJournal([], host(), status());
  expect(write).not.toHaveBeenCalled();
  expect(status().textContent).toContain('Журнал пуст');
});
it('offers the whole text for manual copying if clipboard access fails and cleans up on retry', async () => {
  write.mockRejectedValueOnce(new Error('denied'));
  await copyJournal(['Первая', 'Последняя'], host(), status());
  const field = host().querySelector('textarea');
  expect(field.value).toBe('Первая\nПоследняя');
  expect(field.readOnly).toBe(true);
  expect(field.selectionStart).toBe(0);
  expect(field.selectionEnd).toBe(field.value.length);
  expect(status().textContent).toContain('Ctrl+C');
  await copyJournal(['Новый лог'], host(), status());
  expect(host().querySelector('textarea')).toBeNull();
  expect(status().textContent).toContain('Скопирован');
});
