// Демо-отчёты: только вымышленные операции. В отдельной копии приложения
// событие попадает в изолированный журнал; в самостоятельной лаборатории остаётся в памяти окна.
import { makeScriptReport } from '../js/modules/automation/scriptReport.js';
import { openScriptStatistics } from '../js/modules/automation/scriptReportView.js';

export function demoReport(kind, rows, dryRun = false) {
  const report = makeScriptReport(kind, rows, { dryRun });
  report.title = `Демо · ${report.title}`;
  report.at = new Date().toISOString();
  window.dispatchEvent(new CustomEvent('tf-demo:script-report', { detail: report }));
  return report;
}

export function openDemoReport(reports) {
  return openScriptStatistics(reports, {
    title: '📋 Таблица действий · демо',
    note: 'Вымышленные данные. Это имитация: на сайт ничего не отправлялось и монеты не тратились.'
  });
}
