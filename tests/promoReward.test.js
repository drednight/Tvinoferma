import { expect, it } from 'vitest';
import { promoRewardHtml, promoRewardName } from '../js/modules/automation/promoReward.js';
const render = text => {
  const el = document.createElement('ul');
  el.innerHTML = promoRewardHtml(text);
  return el.firstElementChild;
};
it('matches the item without the quantity but preserves the complete displayed text', () => {
  for (const text of [
    'Приказ феникса (30 шт.)',
    'Приказ феникса (1 шт)',
    'Приказ феникса (1 000 шт.)',
    'Приказ феникса ×30'
  ]) {
    expect(promoRewardName(text)).toBe('Приказ феникса');
    const li = render(text);
    expect(li.querySelector('img').getAttribute('src')).toContain('phoenix-order.webp');
    expect(li.textContent).toBe(text);
    expect(li.classList.contains('promo-reward-row--icon')).toBe(true);
  }
});
it('keeps category suffixes, levels, and quotes rather than guessing item types', () => {
  for (const category of ['доспех', 'оружие', 'реликвия']) {
    const text = `Самоцвет грёз (${category}) (30 шт.)`;
    expect(promoRewardName(text)).toBe(`Самоцвет грёз (${category})`);
    expect(render(text).querySelector('img')).not.toBeNull();
  }
  expect(render('Небесная пилюля 1-го уровня (5 шт.)').querySelector('img')).not.toBeNull();
  expect(render('Вино «Медная печать» (10 шт.)').querySelector('img')).not.toBeNull();
});
it('leaves the ordinary list marker when no exact icon exists, and escapes untrusted markup', () => {
  for (const text of ['Неизвестный предмет (30 шт.)', 'Приказ феникса (другой тип)', '<img src=x onerror=alert(1)>']) {
    const li = render(text);
    expect(li.querySelector('img')).toBeNull();
    expect(li.classList.contains('promo-reward-row--icon')).toBe(false);
    expect(li.textContent).toBe(text);
  }
});
it('renders structured activation rewards with their bound marker intact', () => {
  const el = document.createElement('ul');
  el.innerHTML = promoRewardHtml('Метеорит ×100', true, 'Метеорит');
  expect(el.querySelector('img').getAttribute('src')).toContain('meteorite.webp');
  expect(el.textContent).toBe('Метеорит ×100 (привязанный)');
  expect(el.querySelector('img').getAttribute('aria-hidden')).toBe('true');
});
