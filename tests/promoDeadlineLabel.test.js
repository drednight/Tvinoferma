import { expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promoDeadlineLabel } from '../js/modules/automation/promoDeadlineLabel.js';
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-02T12:00:00Z')));
afterEach(() => vi.restoreAllMocks());
it('extracts only the formatted date/time, never the sentence or promo PIN', () => {
  expect(
    promoDeadlineLabel({ expiresText: 'промокод PWMIZAR2026HB, который можно активировать до 23:59 мск 4 октября.' })
  ).toBe('23:59 мск 04.10.2026');
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
  expect(promoDeadlineLabel({ expiresText: 'Промокод до 23:59 4 октября' })).toBe('23:59 04.10.2026');
  for (const text of ['Просто новость', '<img onerror=x>', 'Несколько кодов и условий — проверьте новость'])
    expect(promoDeadlineLabel({ expiresText: text })).toBe('не указан — проверьте новость');
  expect(promoDeadlineLabel({ expiresText: 'Промокод до 31.02.2026' })).toContain('не распознан');
  expect(promoDeadlineLabel({ expiresText: 'Промокод до 24:80 мск 04.10.2026' })).toContain('не распознан');
});

it('counts inclusive Moscow days and expires only at a confirmed deadline', async () => {
  const { promoDeadlineState } = await import('../js/modules/automation/promoDeadlineLabel.js');
  const now = Date.parse('2026-11-02T21:30:00Z'); // 3 November Moscow
  expect(promoDeadlineState({ expiresOn: '2026-11-05' }, now).days).toBe(3);
  expect(promoDeadlineState({ expiresOn: '2026-11-03' }, now).days).toBe(1);
  expect(promoDeadlineState({ expiresOn: '2026-11-02' }, now).expired).toBe(true);
  expect(promoDeadlineState({ expiresText: 'до 01:00 мск 3 ноября 2026' }, now).expired).toBe(false);
  expect(promoDeadlineState({ expiresText: 'до 00:20 мск 3 ноября 2026' }, now).text).toBe('Срок промокода истек');
  expect(promoDeadlineState({ expiresText: 'до 4 октября' }, now)).toMatchObject({ expired: true, days: 0 });
});

it('uses the current year except a clear December/January boundary, and honors explicit years', async () => {
  const { promoDeadlineState } = await import('../js/modules/automation/promoDeadlineLabel.js');
  const november = Date.parse('2026-11-02T12:00:00Z');
  for (const date of ['25.10', '04.10']) {
    expect(promoDeadlineLabel({ expiresText: `до ${date}` }, november)).toBe(`${date}.2026`);
    expect(promoDeadlineState({ expiresText: `до ${date}` }, november)).toMatchObject({
      expired: true,
      tone: 'danger'
    });
  }
  expect(promoDeadlineLabel({ expiresText: 'до 05.01' }, november)).toBe('05.01.2027');
  expect(promoDeadlineLabel({ expiresText: 'до 25.12' }, Date.parse('2027-01-02T12:00:00Z'))).toBe('25.12.2026');
  expect(promoDeadlineLabel({ expiresText: 'до 05.01.2026' }, november)).toBe('05.01.2026');
  expect(promoDeadlineState({ expiresOn: '2026-11-02' }, november)).toMatchObject({
    days: 1,
    tone: 'warning',
    text: 'Скоро истечет, осталось: 1 день'
  });
  expect(promoDeadlineState({ expiresOn: '2026-11-04' }, november)).toMatchObject({ days: 3, tone: 'warning' });
  expect(promoDeadlineState({ expiresOn: '2026-11-05' }, november)).toMatchObject({ days: 4, tone: 'success' });
});
