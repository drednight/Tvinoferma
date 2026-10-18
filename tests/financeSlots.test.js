// tests/financeSlots.test.js
// Плитки «Банка»: заполненная должна быть ровно такой же, как пустая.
//
// Проверяются правила CSS, а не сама вёрстка: jsdom не считает высоты, и плитка, выросшая
// от длинного названия, в тестах выглядела бы как обычная. Без этих правил стенд вёрстки
// на реальном CSS показывает 14 проблем, с ними — ноль.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('css/modules/finance.css', 'utf8');

/** Правило для селектора — по одному, вместе со всем телом блока. */
const rule = (selector) => {
  const m = css.match(new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{([^}]*)\\}`, 'm'));
  return m ? m[2] : '';
};

describe('плитки банка одинакового размера', () => {
  it('размер плитки задаёт aspect-ratio, а не содержимое', () => {
    expect(rule('\\.slot')).toContain('aspect-ratio: 1');
  });

  it('содержимое плитки обрезается и не распирает её', () => {
    expect(rule('\\.slot')).toContain('overflow: hidden');
  });

  it('название ограничено двумя строками', () => {
    const name = rule('\\.slot-name');
    expect(name).toContain('-webkit-line-clamp: 2');
    expect(name).toContain('overflow: hidden');
  });

  it('текст не мельче 11px: правило проекта', () => {
    // 0.7rem при корне 16px = 11.2px. Мельче — не читается, и стенд это считает ошибкой
    const sizes = [...rule('\\.slot\\.is-filled').matchAll(/font-size:\s*([\d.]+)rem/g)].map(m => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const rem of sizes) expect(rem * 16, `шрифт ${rem}rem`).toBeGreaterThanOrEqual(11);
  });

  it('у названия есть место: отступ справа и снизу под количество', () => {
    // Без отступов длинное название налезало бы на «×7»
    const padding = rule('\\.slot\\.is-filled').match(/padding:\s*([^;]+);/);
    expect(padding).toBeTruthy();
    const parts = padding[1].trim().split(/\s+/);
    expect(parts.length, `padding: ${padding[1]}`).toBe(4);
    const px = (v) => Number(String(v).replace(/[a-z]+$/, ''));
    expect(px(parts[1]), `отступ справа под количество (${padding[1]})`).toBeGreaterThan(0);
    expect(px(parts[2]), `отступ снизу под количество (${padding[1]})`).toBeGreaterThan(0);
  });
});