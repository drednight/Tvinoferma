import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import html from '../index.html?raw';
import { mountMskClock, mskClockHtml } from '../js/modules/servers/mskClock.js';

// Часы по Москве над плашкой «Статус серверов»: ЧЧ:ММ:СС, тикают раз в секунду.
describe('часы МСК', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('показывают московское время в формате ЧЧ:ММ:СС', () => {
    const el = document.createElement('div');
    // 17:20:05 UTC = 20:20:05 по Москве
    const stop = mountMskClock(el, { now: () => new Date('2026-06-10T17:20:05Z') });
    expect(el.querySelector('.msk-clock-time').textContent).toBe('20:20:05');
    expect(el.querySelector('.msk-clock-zone').textContent).toBe('UTC+3');
    stop();
  });

  it('меняют только цифры раз в секунду, не перерисовывая разметку; остановка гасит таймер', () => {
    vi.setSystemTime(new Date('2026-06-10T17:20:05.000Z'));
    const el = document.createElement('div');
    const stop = mountMskClock(el);
    const sec = el.querySelector('[data-part="s"]');
    expect(sec.textContent).toBe('05');
    vi.advanceTimersByTime(1100);
    expect(el.querySelector('[data-part="s"]')).toBe(sec);   // тот же узел
    expect(sec.textContent).toBe('06');
    stop();
    vi.advanceTimersByTime(5000);
    expect(sec.textContent).toBe('06');
  });

  it('без элемента ничего не делает', () => {
    expect(() => mountMskClock(null)()).not.toThrow();
    expect(mskClockHtml(new Date('не дата'))).toContain('--');
  });

  it('стоят в боковой панели прямо над плашкой «Статус серверов»', () => {
    const clock = html.indexOf('id="msk-clock"');
    const status = html.indexOf('id="server-status"');
    expect(clock).toBeGreaterThan(0);
    expect(clock).toBeLessThan(status);
    expect(html.slice(clock, status)).not.toContain('<button');
  });
});
