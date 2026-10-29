import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeScriptReport } from '../js/modules/automation/scriptReport.js';
import {
  groupScriptReports,
  openScriptStatistics,
  scriptStatisticsHtml
} from '../js/modules/automation/scriptReportView.js';

const char = { charId: 'a', nick: 'Альфа' };

describe('подробные отчёты скриптов', () => {
  it('промокод: награда только из подтверждённого ответа, пропуск и неясный исход не выдаются за новый успех', () => {
    const report = makeScriptReport('promo', [
      { ...char, code: 'CODE', status: 'success', rewards: [{ name: 'Метеорит', qty: 3 }] },
      { ...char, code: 'OLD', status: 'already_used', skipped: true },
      { ...char, code: 'MAYBE', status: 'unknown', uncertain: true, clicked: false }
    ]);
    expect(report.rows[0].details.join(' ')).toContain('Метеорит ×3');
    expect(report.rows[1].details.join(' ')).toContain('повторно не вводился');
    expect(report.rows[1].details.join(' ')).toContain('неизвестен');
    expect(report.rows[2].details.join(' ')).toContain('не подтверждён');
    expect(report.rows[2].tone).toBe('warn');
  });

  it('передача: только записи истории подтверждены; пробный выбор и неясный исход отдельно', () => {
    const rows = makeScriptReport('transfer', [
      {
        ...char,
        status: 'partial',
        server: 'Фенрир',
        recipient: 'Бета',
        done: [{ name: 'Руна', qty: 2 }],
        missing: [{ name: 'Камень', qty: 1 }]
      },
      { ...char, status: 'unknown', uncertain: true, items: [{ name: 'Камень', qty: 1 }] },
      { ...char, status: 'dry_run', dryRun: true, items: [{ name: 'Сундук', qty: 1 }] }
    ]).rows;
    expect(rows[0].context).toContain('Бета');
    expect(rows[0].details.join(' ')).toContain('Записано в истории передачи: Руна ×2');
    expect(rows[0].details.join(' ')).toContain('не подтверждает получение');
    expect(rows[0].details.join(' ')).toContain('Не найдено в истории передачи: Камень');
    expect(rows[1].details.join(' ')).toContain('результат не подтверждён');
    expect(rows[2].details.join(' ')).toContain('не передано');
  });

  it('покупка на общем аккаунте отображается каждому участнику как один общий результат и не сохраняет логин', () => {
    const report = makeScriptReport('shop', [
      {
        ...char,
        siteKey: 'acc:secret',
        account: 'secret-login',
        item: 'Сундук',
        status: 'unknown',
        bought: 1,
        spent: 10,
        requested: 2,
        members: ['Альфа', 'Бета'],
        memberChars: [
          { id: 'a', nick: 'Альфа' },
          { id: 'b', nick: 'Бета' }
        ]
      }
    ]);
    expect(report.rows.map(row => row.charId)).toEqual(['a', 'b']);
    expect(report.rows.every(row => row.details.join(' ').includes('не отдельная покупка'))).toBe(true);
    expect(report.rows[0].details.join(' ')).toContain('Подтверждено покупок: 1');
    expect(report.rows[0].details.join(' ')).toContain('не подтверждён');
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('не сохраняет случайные адреса и секреты из текста ответа сайта', () => {
    const report = makeScriptReport('promo', [
      {
        ...char,
        code: 'CODE1234',
        status: 'unknown',
        detail: 'user@example.com token=secret https://example.com/path?secret=123'
      }
    ]);
    const text = JSON.stringify(report);
    expect(text).not.toContain('user@example.com');
    expect(text).not.toContain('secret=123');
    expect(text).not.toContain('token=secret');
  });

  it('сундуки: найденный, открытый и непроверенный — разные состояния', () => {
    const report = makeScriptReport('caravan', [
      {
        ...char,
        status: 'unknown',
        found: 2,
        chests: [
          { cartId: '1', state: 'opened', items: ['Руна'] },
          { cartId: '2', state: 'sent', items: ['Камень'] },
          { cartId: '3', state: 'found', items: [] }
        ]
      }
    ]);
    const text = report.rows[0].details.join(' ');
    expect(text).toContain('Сундук №1: ✅ открыт');
    expect(text).toContain('Сундук №2: ❓ нажато, итог не проверен');
    expect(text).toContain('Сундук №3: 📦 найден');
  });
});

describe('окно статистики', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="modal-root"></div>';
  });
  it('показывает время по Москве независимо от часового пояса компьютера', () => {
    const report = {
      ...makeScriptReport('promo', [{ ...char, code: 'AAA', status: 'success' }]),
      at: '2026-10-28T08:15:00Z'
    };
    expect(scriptStatisticsHtml([report])).toContain('28.10.2026 11:15');
  });
  it('группирует по id, а не совпадающим никам, ищет и экранирует все данные', () => {
    const reports = [
      {
        title: '<img src=x>',
        rows: [
          {
            charId: 'a',
            nick: '<img src=x onerror=alert(1)>',
            action: '<script>x</script>',
            status: 'ok',
            details: ['<svg onload=alert(1)>']
          },
          { charId: 'b', nick: '<img src=x onerror=alert(1)>', action: 'передача', status: 'ok', details: [] }
        ]
      }
    ];
    expect(groupScriptReports(reports)).toHaveLength(2);
    expect(groupScriptReports(reports, 'передача')).toHaveLength(1);
    const div = document.createElement('div');
    div.innerHTML = scriptStatisticsHtml(reports);
    expect(div.querySelector('img,script,svg')).toBeNull();
    expect(div.textContent).toContain('<script>x</script>');
    const ov = openScriptStatistics(reports);
    ov.body.querySelector('[data-sr-search]').value = 'передача';
    ov.body.querySelector('[data-sr-search]').dispatchEvent(new Event('input', { bubbles: true }));
    expect(ov.body.querySelectorAll('.sr-group')).toHaveLength(1);
    ov.foot.querySelector('[data-sr-close]').click();
    expect(ov.el.isConnected).toBe(false);
  });
});

describe('журнал задач', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
    document.body.innerHTML = '<div id="modal-root"></div>';
  });
  it('промежуточный отчёт сохраняется ещё до finish и после перезагрузки доступен через кнопку логов', async () => {
    const { startTask } = await import('../js/core/taskLog.js');
    const task = startTask('Передача');
    task.setScriptReport(
      makeScriptReport('transfer', [{ ...char, status: 'success', done: [{ name: 'Руна', qty: 1 }] }])
    );
    const saved = JSON.parse(localStorage.getItem('tf_task_journal_v1'));
    expect(saved[0].status).toBe('running');
    expect(saved[0].scriptReport.rows[0].details.join(' ')).toContain('Руна');
    vi.resetModules();
    const { mountLogHub } = await import('../js/core/logHub.js');
    await import('../js/core/taskLog.js');
    const root = document.createElement('div');
    document.body.append(root);
    mountLogHub(root);
    root.querySelector('[data-lh-statistics]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(document.querySelector('.tf-dialog').textContent).toContain('Статистика по персонажам');
    expect(document.querySelector('.tf-dialog').textContent).toContain('Альфа');
    expect(document.querySelector('.tf-dialog').textContent).toContain('Руна');
  });
});
