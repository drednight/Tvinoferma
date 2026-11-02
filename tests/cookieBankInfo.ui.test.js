import { expect, it, vi } from 'vitest';
import { initCookieBankInfo } from '../js/settings/cookieBankInfo.js';
it('starts collapsed, lazily reads anonymous metadata and never invents a session expiry or displays secrets', async () => {
  document.body.innerHTML =
    '<details id="cookie-bank-info"><summary>Банк</summary><button id="cookie-bank-refresh"></button><div id="cookie-bank-expiry"></div></details>';
  const characters = () => ['a', 'b', 'c', 'd'].map(id => ({ id, nick: `Игрок ${id}` }));
  const readStatus = vi.fn(async () => [
    {
      charId: 'a',
      cookies: 2,
      savedAt: 1780000000,
      cookieMetadata: [
        {
          kind: 'persistent',
          site: 'pwonline.ru',
          expiresAt: 1781000294,
          name: 'DO_NOT_DISPLAY_COOKIE_NAME',
          value: 'DO_NOT_DISPLAY_VALUE'
        },
        { kind: 'session', expiresAt: null }
      ],
      secret: 'DO_NOT_DISPLAY_COOKIE'
    },
    { charId: 'b', cookies: 1, sessionCookies: 1 },
    { charId: 'c', error: 'DO_NOT_DISPLAY_NATIVE_ERROR' }
  ]);
  initCookieBankInfo({ characters, readStatus });
  expect(document.getElementById('cookie-bank-info').open).toBe(false);
  expect(readStatus).not.toHaveBeenCalled();
  document.getElementById('cookie-bank-info').open = true;
  document.getElementById('cookie-bank-info').dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(document.body.textContent).toContain('Игрок a →'));
  expect(readStatus).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('2026');
  expect([...document.querySelectorAll('th')].map(el => el.textContent)).toEqual([
    'Куки',
    'Тип',
    'Срок истечения',
    'Сайт'
  ]);
  expect(document.body.textContent).toContain('pwonline.ru');
  expect(document.body.textContent).toContain('Сохранены в банк:');
  expect(document.body.textContent).toContain('срок истёк');
  expect(document.body.textContent).toContain('Не задан сайтом — точной даты нет');
  expect(document.body.textContent).toContain('сессионных: 1 · постоянных: 1');
  expect(document.body.textContent).toContain('Подробные сроки недоступны');
  expect(document.body.textContent).toContain('Игрок c → не удалось прочитать банк');
  expect(document.body.textContent).toContain('Игрок d → нет сохранённых куки');
  expect(document.body.innerHTML).not.toContain('DO_NOT_DISPLAY');
  document.getElementById('cookie-bank-refresh').click();
  expect(readStatus).toHaveBeenCalledTimes(2);
});
it('does not show raw native errors and allows an explicit retry', async () => {
  document.body.innerHTML = '<button id="cookie-bank-refresh"></button><div id="cookie-bank-expiry"></div>';
  const readStatus = vi.fn().mockRejectedValue(new Error('PRIVATE_ERROR'));
  initCookieBankInfo({ characters: () => [], readStatus });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Windows'));
  expect(document.body.textContent).not.toContain('PRIVATE_ERROR');
  expect(document.querySelector('button').disabled).toBe(false);
});

it('temporarily hides the bank for everyone and does not bind native metadata reads in settings', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  expect(doc.getElementById('cookie-bank-info').hidden).toBe(true);
  const settings = readFileSync(new URL('../js/settings/settings.js', import.meta.url), 'utf8');
  expect(settings).not.toContain('initCookieBankInfo');
});
