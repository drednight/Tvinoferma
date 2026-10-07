import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { showModal, closeModal } from '../js/core/ui.js';
import { openOverlay } from '../js/modules/marathons/overlay.js';

beforeEach(() => { closeModal(); document.body.innerHTML = '<div id="modal-root"></div>'; });
afterEach(() => { closeModal(); vi.restoreAllMocks(); });
const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const show = opts => showModal({ title: 'Форма', content: 'Текст', submitText: null, cancelText: 'Закрыть', ...opts });

describe('жизненный цикл модальных окон', () => {
  it('100 закрытий кнопкой не оставляют обработчиков Escape', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const onClose = vi.fn();
    for (let i = 0; i < 100; i++) { show({ onClose }); document.querySelector('.modal-footer button').click(); }
    const keys = added.mock.calls.filter(([type]) => type === 'keydown').map(([, fn]) => fn);
    expect(keys).toHaveLength(100);
    for (const fn of keys) expect(removed.mock.calls.some(([type, handler]) => type === 'keydown' && handler === fn)).toBe(true);
    escape();
    expect(onClose).toHaveBeenCalledTimes(100);
  });

  it('замена и программное закрытие вызывают очистку ровно один раз', () => {
    const first = vi.fn(), second = vi.fn();
    show({ onClose: first }); show({ onClose: second });
    expect(first).toHaveBeenCalledTimes(1);
    closeModal(); closeModal(); escape();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('замена overlay вызывает его очистку и снимает подписки через переопределённый close', () => {
    const onClose = vi.fn(), unsubscribe = vi.fn();
    const overlay = openOverlay({ onClose });
    const close = overlay.close; overlay.close = () => { unsubscribe(); close(); };
    show();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.tf-overlay')).toBeNull();
  });

  it('Escape закрывает только верхнее окно, а повторный close безопасен', () => {
    const first = vi.fn(), second = vi.fn();
    const a = openOverlay({ onClose: first }); const b = openOverlay({ onClose: second });
    escape(); expect(second).toHaveBeenCalledTimes(1); expect(first).not.toHaveBeenCalled();
    b.close(); expect(second).toHaveBeenCalledTimes(1);
    escape(); expect(first).toHaveBeenCalledTimes(1); a.close(); expect(first).toHaveBeenCalledTimes(1);
  });

  it('окно, открытое из onClose, не удаляется прежним закрытием', () => {
    show({ onClose: () => show({ title: 'Следующая форма' }) }); closeModal();
    expect(document.querySelector('.modal-header').textContent).toContain('Следующая форма');
  });

  it('завершение старой асинхронной формы не закрывает новую', async () => {
    let finish; const pending = new Promise(resolve => { finish = resolve; });
    show({ submitText: 'Сохранить', onSubmit: () => pending });
    document.querySelector('.modal-footer .primary').click();
    show({ title: 'Новая форма' }); finish(true); await pending; await Promise.resolve();
    expect(document.querySelector('.modal-header').textContent).toContain('Новая форма');
  });

  it('успешная отправка уведомляет о закрытии и снимает обработчик', async () => {
    const onClose = vi.fn(); show({ onClose, submitText: 'Сохранить', onSubmit: async () => true });
    document.querySelector('.modal-footer .primary').click(); await Promise.resolve();
    expect(onClose).toHaveBeenCalledTimes(1); expect(document.querySelector('.modal-overlay')).toBeNull(); escape(); expect(onClose).toHaveBeenCalledTimes(1);
  });
});
