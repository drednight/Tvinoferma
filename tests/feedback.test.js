// tests/feedback.test.js
// Раздел «Предложения»: ссылки на формы GitHub и черновик отчёта об ошибке с диагностикой.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { bugReportUrl } from '../js/settings/feedback.js';

const html = readFileSync('index.html', 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');
const section = doc.getElementById('settings-feedback');

describe('разметка раздела «Предложения»', () => {
  it('есть кнопка отчёта об ошибке, ссылка на форму идеи и список заявок', () => {
    expect(section.querySelector('#feedback-bug-btn')).not.toBeNull();
    const hrefs = [...section.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(hrefs.some(h => h.includes('feature_request.yml'))).toBe(true);
    expect(hrefs.some(h => h.endsWith('/issues'))).toBe(true);
  });

  it('раздел связи не содержит интеграции Telegram', () => {
    expect(section.querySelector('#feedback-telegram-row')).toBeNull();
    expect(section.querySelector('#feedback-telegram-link')).toBeNull();
    expect(section.querySelector('.telegram-panel')).toBeNull();
    expect(section.textContent.toLowerCase()).not.toContain('telegram');
  });
});

describe('черновик отчёта об ошибке', () => {
  it('версия и диагностика попадают в параметры формы, кириллица кодируется', () => {
    const url = bugReportUrl({ version: '2.2.0', logs: 'Диагностика парсеров\nВерсия: 2.2.0' });
    expect(url.startsWith('https://github.com/drednight/Tvinoferma/issues/new?')).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('template')).toBe('bug_report.yml');
    expect(params.get('version')).toBe('2.2.0');
    expect(params.get('logs')).toContain('Диагностика парсеров');
  });

  it('пустая версия и «—» не попадают в URL', () => {
    expect(bugReportUrl({ version: '—', logs: 'x' })).not.toContain('version=');
    expect(bugReportUrl({ logs: 'x' })).not.toContain('version=');
  });

  it('очень длинная диагностика обрезается: у URL есть практический предел', () => {
    const url = bugReportUrl({ logs: 'x'.repeat(5000) });
    expect(url.length).toBeLessThan(4000);
    const logs = new URL(url).searchParams.get('logs');
    expect(logs.endsWith('…')).toBe(true);
    expect(logs.length).toBeLessThanOrEqual(3002);
  });
});
