import { expect, it, vi } from 'vitest';
import { initCookieBankInfo } from '../js/settings/cookieBankInfo.js';
it('shows only character and expiry metadata, including session-only and unavailable rows, never cookie secrets', async () => {
  document.body.innerHTML = '<button id="cookie-bank-refresh"></button><div id="cookie-bank-expiry"></div>';
  const characters = () => ['a', 'b', 'c', 'd'].map(id => ({ id, nick: `Игрок ${id}` }));
  const readStatus = vi.fn(async () => [
    { charId: 'a', cookies: 2, expiresAt: 1781000294, sessionCookies: 1, secret: 'DO_NOT_DISPLAY_COOKIE' },
    { charId: 'b', cookies: 1, expiresAt: null, sessionCookies: 1 },
    { charId: 'c', error: 'DO_NOT_DISPLAY_NATIVE_ERROR' }
  ]);
  initCookieBankInfo({ characters, readStatus });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Игрок a →'));
  expect(document.body.textContent).toContain('2026');
  expect(document.body.textContent).toContain('срок истёк');
  expect(document.body.textContent).toContain('сессионные куки');
  expect(document.body.textContent).toContain('Игрок c → не удалось прочитать банк');
  expect(document.body.textContent).toContain('Игрок d → нет сохранённых куки');
  expect(document.body.textContent).not.toContain('DO_NOT_DISPLAY');
  document.getElementById('cookie-bank-refresh').click();
  expect(readStatus).toHaveBeenCalledTimes(2);
});
