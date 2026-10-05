// Командная палитра: показ, навигация стрелками и выполнение (js/core/commandPalette.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/core/ui.js', () => ({ toast: vi.fn() }));

let state, openCommandPalette, closeCommandPalette, isPaletteOpen;

const overlay = () => document.querySelector('.cp-overlay');
const listEl = () => document.querySelector('.cp-list');
const input = () => document.querySelector('.cp-input');
const items = () => [...document.querySelectorAll('.cp-item')];
const activeTitle = () => document.querySelector('.cp-item.is-active .cp-item-title')?.textContent;

const type = (text) => {
  const el = /** @type {HTMLInputElement} */ (input());
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '';
  ({ state } = await import('../js/core/state.js'));
  ({ openCommandPalette, closeCommandPalette, isPaletteOpen } = await import('../js/core/commandPalette.js'));
  state.characters = [
    { id: 'a', nick: 'Ауразак', class: 'Воин', level: 105, tags: [] },
    { id: 'b', nick: 'Мираж', class: 'Маг', level: 100, tags: [] }
  ];
  state.parties = [{ id: 'p1', name: 'Основа' }];
  state.marathons = [];
});

afterEach(() => { closeCommandPalette(); });

describe('открытие и поиск', () => {
  it('открывается, показывает команды и ставит фокус в поиск', () => {
    openCommandPalette({ switchTab: vi.fn() });
    expect(overlay()).not.toBeNull();
    expect(isPaletteOpen()).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(items().length).toBeGreaterThan(0);
  });

  it('повторный вызов не открывает второе окно', () => {
    openCommandPalette({});
    openCommandPalette({});
    expect(document.querySelectorAll('.cp-overlay')).toHaveLength(1);
  });

  it('поиск по нику оставляет команды этого персонажа', () => {
    openCommandPalette({});
    type('аураз');
    expect(items().length).toBeGreaterThan(0);
    expect(items().every(el => el.textContent.includes('Ауразак'))).toBe(true);
  });

  it('поиск без совпадений показывает подсказку', () => {
    openCommandPalette({});
    type('щщщщ');
    expect(items()).toHaveLength(0);
    expect(listEl().textContent).toContain('Ничего не найдено');
  });

  it('первая команда выбрана сразу', () => {
    openCommandPalette({});
    expect(activeTitle()).toBeTruthy();
    expect(document.querySelectorAll('.cp-item.is-active')).toHaveLength(1);
  });
});

describe('клавиатура', () => {
  it('стрелка вниз и вверх перемещают выбор по кругу', () => {
    openCommandPalette({});
    const first = activeTitle();
    press('ArrowDown');
    const second = activeTitle();
    expect(second).not.toBe(first);
    press('ArrowUp');
    expect(activeTitle()).toBe(first);
    // Вверх с первой строки уходит в конец списка
    press('ArrowUp');
    expect(activeTitle()).toBe(items().at(-1).querySelector('.cp-item-title').textContent);
  });

  it('Enter выполняет выбранную команду и закрывает палитру', async () => {
    const run = vi.fn();
    openCommandPalette({ run });
    type('Проверить авторизацию');
    press('Enter');
    expect(isPaletteOpen()).toBe(false);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('check-auth'));
  });

  it('Esc закрывает палитру и не даёт событию уйти дальше', () => {
    openCommandPalette({});
    press('Escape');
    expect(isPaletteOpen()).toBe(false);
    expect(overlay()).toBeNull();
  });

  it('Home и End прыгают в начало и конец списка', () => {
    openCommandPalette({});
    press('End');
    expect(activeTitle()).toBe(items().at(-1).querySelector('.cp-item-title').textContent);
    press('Home');
    expect(activeTitle()).toBe(items()[0].querySelector('.cp-item-title').textContent);
  });
});

describe('мышь', () => {
  it('клик по команде выполняет её', async () => {
    const run = vi.fn();
    openCommandPalette({ run });
    type('ауразак');
    items()[0].click();
    expect(isPaletteOpen()).toBe(false);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
  });

  it('клик мимо окна закрывает палитру', () => {
    openCommandPalette({});
    overlay().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isPaletteOpen()).toBe(false);
  });

  it('наведение мыши переносит выбор на наведённую строку', () => {
    openCommandPalette({});
    const target = items()[2];
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(activeTitle()).toBe(target.querySelector('.cp-item-title').textContent);
  });

  it('клик во окне не закрывает палитру', () => {
    openCommandPalette({});
    document.querySelector('.cp-dialog').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isPaletteOpen()).toBe(true);
  });
});

describe('после закрытия', () => {
  it('клавиши больше не перехватываются', () => {
    const run = vi.fn();
    openCommandPalette({ run });
    closeCommandPalette();
    press('Enter');
    expect(run).not.toHaveBeenCalled();
  });

  it('onClose вызывается при закрытии', () => {
    const onClose = vi.fn();
    openCommandPalette({ onClose });
    closeCommandPalette();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('isPaletteOpen отражает состояние', () => {
    expect(isPaletteOpen()).toBe(false);
    openCommandPalette({});
    expect(isPaletteOpen()).toBe(true);
    closeCommandPalette();
    expect(isPaletteOpen()).toBe(false);
  });
});
