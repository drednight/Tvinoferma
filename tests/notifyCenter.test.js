// tests/notifyCenter.test.js
// Свои уведомления внутри приложения (js/core/notifyCenter.js).
//
// Замена всплывающему окну Windows, которое живёт несколько секунд: карточка стоит,
// пока её не закроют, иначе напоминание приходится запоминать по обрывку.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
showInApp, clearInApp, dismissInApp, inAppItems, bindNotifyCenter, onNotifyCenter
} from '../js/core/notifyCenter.js';

const box = () => document.getElementById('notify-center');
const cards = () => [...box().querySelectorAll('.nc-card')];

beforeEach(() => {
  document.body.innerHTML = '<div id="notify-center"></div>';
  clearInApp();
  bindNotifyCenter();
});

describe('карточки уведомлений', () => {
  it('появляются в порядке: новые сверху', () => {
    showInApp({ title: 'Первое', body: 'раз' });
    showInApp({ title: 'Второе', body: 'два' });
    expect(inAppItems().map(i => i.title)).toEqual(['Второе', 'Первое']);
    expect(cards()[0].textContent).toContain('Второе');
  });

  it('карточка не исчезает сама — в этом весь смысл', async () => {
    showInApp({ title: 'Не уходит' });
    // Ждём больше типичного времени жизни тоста Windows; карточка должна остаться
    await new Promise((r) => setTimeout(r, 60));
    expect(cards()).toHaveLength(1);
  });

it('крестик закрывает нужную карточку', () => {
    showInApp({ title: 'Первое' });
    const id = inAppItems()[0].id;
    showInApp({ title: 'Второе' });
    box().querySelector(`[data-nc-id="${id}"] [data-nc-action="dismiss"]`).click();
    expect(inAppItems().map(i => i.title)).toEqual(['Второе']);
  });

  it('закрытие карточки по её id работает и из кода', () => {
    // Этим же пользуется обработчик карточки: сначала действие, потом закрытие
    showInApp({ title: 'Уходит' });
    const id = inAppItems()[0].id;
    dismissInApp(id);
    expect(inAppItems()).toHaveLength(0);
  });

  it('клик по карточке выполняет действие и закрывает её', () => {
    let clicked = 0;
    showInApp({ title: 'Открыть', onClick: () => { clicked++; } });
    box().querySelector('.nc-card').click();
    expect(clicked).toBe(1);
    expect(inAppItems()).toHaveLength(0);
  });

  it('одно и то же не копится: таймер проверяет каждые 30 секунд', () => {
    // Без `once` стопка наливалась бы одинаковыми карточками, пока человек не закроет первую
    for (let i = 0; i < 5; i++) showInApp({ title: 'Напоминание', body: 'текст', once: true });
    expect(inAppItems()).toHaveLength(1);
  });

  it('разные уведомления не склеиваются', () => {
    showInApp({ title: 'А', once: true });
    showInApp({ title: 'Б', once: true });
    expect(inAppItems()).toHaveLength(2);
  });

  it('список ограничен: больше десяти карточек на экране не держим', () => {
    for (let i = 0; i < 14; i++) showInApp({ title: `Уведомление ${i}` });
    expect(inAppItems().length).toBeLessThanOrEqual(10);
  });

  it('счётчик «ещё N» появляется, когда карточек больше видных', () => {
    for (let i = 0; i < 7; i++) showInApp({ title: `У ${i}` });
    expect(box().querySelector('.nc-more')).toBeTruthy();
  });

  it('«свернуть все» очищает стопку', () => {
    for (let i = 0; i < 7; i++) showInApp({ title: `У ${i}` });
    box().querySelector('.nc-more').click();
    expect(inAppItems()).toHaveLength(0);
  });

  it('заголовок не пропускает HTML', () => {
    showInApp({ title: '<img src=x onerror=1>' });
    expect(box().querySelector('img')).toBeNull();
    expect(box().textContent).toContain('<img');
  });

  it('многострочный текст не растягивает карточку за экран', () => {
    const css = readFileSync('css/core/notify.css', 'utf8');
    expect(css).toMatch(/\.nc-text\s*\{[\s\S]*?max-height:/);
  });

  it('подписка на изменения вызывается', () => {
    let calls = 0;
    const off = onNotifyCenter(() => { calls++; });
    showInApp({ title: 'Раз' });
    expect(calls).toBe(1);
    off();
    showInApp({ title: 'Два' });
    expect(calls).toBe(1);
  });
});
