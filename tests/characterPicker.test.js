import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeModalRoot } from '../js/core/modalLifecycle.js';
import { CHARS } from '../demo/lab-data.js';
import { loginStatus, openCharacterPicker } from '../demo/character-picker.js';

const click = element => {
  expect(element).toBeTruthy();
  element.click();
};
const change = (element, value) => {
  expect(element).toBeTruthy();
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
};
const input = (element, value) => {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
};
const ids = dlg => [...dlg.body.querySelectorAll('[data-picker-id]')].map(el => el.dataset.pickerId);
const names = dlg => [...dlg.body.querySelectorAll('.cp-character-copy b')].map(el => el.textContent);

function mount(selected = []) {
  const parent = document.createElement('div');
  parent.className = 'modal-overlay';
  parent.innerHTML = '<button type="button">Выбрать вручную</button>';
  document.getElementById('modal-root').append(parent);
  const returnFocus = parent.querySelector('button');
  const onClose = vi.fn();
  const dlg = openCharacterPicker({ characters: CHARS, selected: new Set(selected), parent, returnFocus, onClose });
  return { dlg, parent, returnFocus, onClose };
}

describe('Демо: окно выбора персонажей', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="modal-root"></div>';
  });
  afterEach(() => {
    closeModalRoot(document.getElementById('modal-root'));
    document.body.innerHTML = '';
  });

  it('фильтрует по состоянию входа, пати, классу и поиску; сортирует по алфавиту', () => {
    const { dlg } = mount();
    const $ = selector => dlg.body.querySelector(selector);
    expect(loginStatus(CHARS.find(c => c.id === 'c5'))).toBe('checking');
    expect(ids(dlg)).toHaveLength(8);
    change($('[data-picker-status]'), 'online');
    expect(ids(dlg)).toEqual(expect.arrayContaining(['c1', 'c2', 'c4', 'c6', 'c8']));
    expect(ids(dlg)).not.toContain('c5'); // проверка — отдельный статус, даже если старое значение true
    change($('[data-picker-status]'), 'offline');
    expect(ids(dlg).sort()).toEqual(['c3', 'c7']);
    change($('[data-picker-status]'), 'checking');
    expect(ids(dlg)).toEqual(['c5']);
    change($('[data-picker-status]'), 'all');
    change($('[data-picker-party]'), 'Альфа');
    change($('[data-picker-class]'), 'Маг');
    expect(ids(dlg)).toEqual(['c2']);
    input($('[data-picker-search]'), 'тИХо');
    expect(ids(dlg)).toEqual(['c2']);
    input($('[data-picker-search]'), 'не найдено');
    expect(ids(dlg)).toHaveLength(0);
    expect($('[data-picker-list]').textContent).toContain('не найдены');
    expect($('[data-picker-all]').disabled).toBe(true);
    input($('[data-picker-search]'), '');
    change($('[data-picker-party]'), '');
    change($('[data-picker-class]'), '');
    const ascending = names(dlg);
    expect(ascending).toEqual([...ascending].sort((a, b) => a.localeCompare(b, 'ru')));
    change($('[data-picker-sort]'), 'desc');
    expect(names(dlg)).toEqual([...ascending].reverse());
  });

  it('массовые действия относятся к видимым строкам и не стирают скрытые отметки', () => {
    const { dlg, onClose } = mount(['c1', 'c2', 'c3', 'c5']);
    const $ = selector => dlg.body.querySelector(selector);
    change($('[data-picker-status]'), 'online');
    click($('[data-picker-none]'));
    expect($('[data-picker-count]').textContent).toContain('Выбрано: 2 из 8'); // c3 и c5 скрыты фильтром
    change($('[data-picker-status]'), 'all');
    expect($('[data-picker-id="c3"]').checked).toBe(true);
    expect($('[data-picker-id="c5"]').checked).toBe(true);
    expect($('[data-picker-id="c1"]').checked).toBe(false);
    click($('[data-picker-only-selected]'));
    expect(ids(dlg).sort()).toEqual(['c3', 'c5']);
    click(dlg.foot.querySelector('[data-picker-save]'));
    expect(onClose).toHaveBeenCalledWith(new Set(['c3', 'c5']));
  });

  it('отмена и Escape не сохраняют черновик; фокус и доступность родителя восстанавливаются', () => {
    const { dlg, parent, returnFocus, onClose } = mount(['c1']);
    expect(parent.inert).toBe(true);
    expect(dlg.el.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dlg.body.querySelector('[data-picker-search]'));
    click(dlg.body.querySelector('[data-picker-id="c2"]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledWith(null);
    expect(parent.inert).toBe(false);
    expect(document.activeElement).toBe(returnFocus);
    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);
  });

  it('Tab и Shift+Tab остаются внутри открытого окна', () => {
    const { dlg } = mount();
    const first = dlg.el.querySelector('.tf-close');
    const last = dlg.foot.querySelector('[data-picker-save]');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
  });
});
