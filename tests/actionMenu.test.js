// tests/actionMenu.test.js
// Меню действий рядом с кнопкой (js/core/ui.js → openActionMenu).
//
// Меню нужно там, где у одного действия много вариантов: четыре кнопки в ряд занимали
// место в панели фильтров и обещали больше, чем нужно в этот момент.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openActionMenu } from '../js/core/ui.js';

/** Кнопка в разметке страницы: меню позиционируется относительно неё. */
function mountAnchor() {
  document.body.innerHTML = '<div class="action-menu-wrapper"><button id="btn" type="button">Порядок…</button></div>';
  return document.getElementById('btn');
}

const menu = () => document.querySelector('.dropdown-menu[data-open]');
const items = () => [
  { id: 'save', label: 'Сохранить как…', icon: '💾' },
  { id: 'delete', label: 'Удалить сохранённый', icon: '✕', danger: true }
];

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('меню действий', () => {
  it('открывается под кнопкой и перечисляет действия', () => {
    openActionMenu(mountAnchor(), items());
    expect(menu()).toBeTruthy();
    expect([...menu().querySelectorAll('[data-id]')].map(b => b.dataset.id)).toEqual(['save', 'delete']);
  });

  it('закрывается после выбора, и действие выполняется один раз', () => {
    const onSelect = vi.fn();
    openActionMenu(mountAnchor(), [{ id: 'save', label: 'Сохранить', onSelect }]);
    menu().querySelector('[data-id="save"]').click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('недоступный пункт не выполняется и не выбирается', () => {
    const onSelect = vi.fn();
    openActionMenu(mountAnchor(), [{ id: 'save', label: 'Сохранить', disabled: true, onSelect }]);
    const btn = menu().querySelector('[data-id="save"]');
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Escape закрывает', () => {
    openActionMenu(mountAnchor(), items());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu()).toBeNull();
  });

  it('клик мимо закрывает', () => {
    openActionMenu(mountAnchor(), items());
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu()).toBeNull();
  });

  it('клик по самой кнопке не закрывает: человек ещё может открыть заново', () => {
    const anchor = mountAnchor();
    openActionMenu(anchor, items());
    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu()).toBeTruthy();
  });

  it('второе открытие заменяет первое, а не кладёт поверх', () => {
    const anchor = mountAnchor();
    openActionMenu(anchor, items());
    openActionMenu(anchor, items());
    expect(document.querySelectorAll('.dropdown-menu[data-open]')).toHaveLength(1);
  });

  it('разделитель рисуется, но не выбирается', () => {
    openActionMenu(mountAnchor(), [{ id: 'a', label: 'Первое' }, { id: 'sep', separator: true }, { id: 'b', label: 'Второе' }]);
    expect(menu().querySelector('.dropdown-sep')).toBeTruthy();
    expect(menu().querySelector('[data-id="sep"]')).toBeNull();
  });

  it('название действия не пропускает HTML', () => {
    openActionMenu(mountAnchor(), [{ id: 'x', label: '<img src=x onerror=1>' }]);
    expect(menu().querySelector('img')).toBeNull();
    expect(menu().textContent).toContain('<img');
  });

  it('меню живёт рядом с кнопкой, а не у края окна', () => {
    // Без position: relative у обёртки меню уехало бы к краю окна
    const anchor = mountAnchor();
    openActionMenu(anchor, items());
    expect(anchor.parentElement.contains(menu())).toBe(true);
  });
});