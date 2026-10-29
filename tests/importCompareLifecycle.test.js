import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openCompareDialog } from '../js/data/compare.js';
import { normalizeCharacter } from '../js/core/state.js';
import { showModal } from '../js/core/ui.js';

const local = normalizeCharacter({ id: 'Bob', nick: 'Bob', level: 10 });
const incoming = normalizeCharacter({ id: 'Bob', nick: 'Bob', level: 20 });

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toast-root"></div>';
});

describe('жизненный цикл окна сравнения импорта', () => {
  it('отменяет импорт, если контейнер окна отсутствует', async () => {
    document.querySelector('#modal-root').remove();
    await expect(openCompareDialog(local, incoming)).resolves.toEqual({ action: 'cancel' });
  });

  it('возвращает выбор и удаляет только окно сравнения', async () => {
    const result = openCompareDialog(local, incoming);
    document.querySelector('[data-act="keep"]').click();
    await expect(result).resolves.toEqual({ action: 'keep' });
    expect(document.querySelector('.cmp-modal')).toBeNull();
  });

  it('отменяет сравнение при замене другим окном, не закрывая новое', async () => {
    const result = openCompareDialog(local, incoming);
    showModal({ title: 'Другое окно', content: 'Содержимое', submitText: null });
    await expect(result).resolves.toEqual({ action: 'cancel' });
    expect(document.querySelector('#modal-root').textContent).toContain('Другое окно');
    await Promise.resolve();
    expect(document.querySelector('#modal-root').textContent).toContain('Другое окно');
  });

  it('отменяет сравнение, если оверлей удалили в обход lifecycle, и оставляет новое содержимое', async () => {
    const result = openCompareDialog(local, incoming);
    document.querySelector('#modal-root').innerHTML = '<div id="replacement">Новое окно</div>';
    await expect(result).resolves.toEqual({ action: 'cancel' });
    expect(document.querySelector('#replacement').textContent).toBe('Новое окно');
  });

  it('не реагирует на Escape под другим оверлеем', async () => {
    const finished = vi.fn();
    const result = openCompareDialog(local, incoming).then(finished);
    const top = document.createElement('div');
    top.className = 'modal-overlay';
    document.querySelector('#modal-root').append(top);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    expect(document.querySelector('.cmp-modal')).not.toBeNull();
    top.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await result;
    expect(finished).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledWith({ action: 'cancel' });
  });

  it('отменяет ожидание при удалении самого контейнера', async () => {
    const result = openCompareDialog(local, incoming);
    document.querySelector('#modal-root').remove();
    await expect(result).resolves.toEqual({ action: 'cancel' });
  });
});
