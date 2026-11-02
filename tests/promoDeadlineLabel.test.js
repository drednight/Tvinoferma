import { expect, it } from 'vitest';
import { promoDeadlineLabel } from '../js/modules/automation/promoDeadlineLabel.js';
it('extracts only the formatted date/time, never the sentence or promo PIN', () => {
  expect(
    promoDeadlineLabel({ expiresText: 'промокод PWMIZAR2026HB, который можно активировать до 23:59 мск 4 октября.' })
  ).toBe('23:59 мск 04.10 (год в новости не указан)');
  expect(promoDeadlineLabel({ expiresText: 'Промокод до 4 октября 2026 года в 23:59 МСК' })).toBe(
    '23:59 мск 04.10.2026'
  );
  expect(promoDeadlineLabel({ expiresOn: '2026-10-04' })).toBe('04.10.2026');
  expect(promoDeadlineLabel({ expiresText: 'Промокод до 23:59 МСК 4 октября', expiresOn: '2026-10-04' })).toBe(
    '23:59 мск 04.10.2026'
  );
  expect(promoDeadlineLabel({ expiresText: 'Промокод до 04.10.2026' })).toBe('04.10.2026');
});
it('does not invent dates/years/timezones or display arbitrary source text', () => {
  expect(promoDeadlineLabel({ expiresText: 'Промокод до 23:59 4 октября' })).toBe(
    '23:59 04.10 (год в новости не указан)'
  );
  for (const text of ['Просто новость', '<img onerror=x>', 'Несколько кодов и условий — проверьте новость'])
    expect(promoDeadlineLabel({ expiresText: text })).toBe('не указан — проверьте новость');
  expect(promoDeadlineLabel({ expiresText: 'Промокод до 31.02.2026' })).toContain('не распознан');
  expect(promoDeadlineLabel({ expiresText: 'Промокод до 24:80 мск 04.10.2026' })).toContain('не распознан');
});
