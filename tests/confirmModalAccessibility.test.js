// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { confirmModal } from '../js/core/ui.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('подтверждение опасного действия', () => {
  it('позволяет прокручивать текст с клавиатуры и по умолчанию выбирает отмену', async () => {
    const result = confirmModal({ title: 'Восстановление', text: 'Проверьте копию.', danger: true });
    const dialog = document.querySelector('.tf-confirm');
    expect(dialog.querySelector('.modal-body').getAttribute('tabindex')).toBe('0');
    const description = document.getElementById(dialog.getAttribute('aria-describedby'));
    expect(description.textContent).toBe('Проверьте копию.');
    expect(document.activeElement).toBe(dialog.querySelector('[data-act="cancel"]'));
    document.activeElement.click();
    await expect(result).resolves.toBe(false);
    expect(document.querySelector('.tf-confirm')).toBeNull();
  });

  it('по Escape отменяет действие', async () => {
    const result = confirmModal({ title: 'Восстановление', text: 'Проверьте копию.', danger: true });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(result).resolves.toBe(false);
  });
});
