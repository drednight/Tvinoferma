// @ts-check
import {
  cloudDiagnosticReport,
  projectCloudDiagnosticResult,
  cloudStep,
  clearCloudDiagnostics,
  subscribeCloudDiagnostics
} from '../cloudDiagnostics.js';
import { subscribeCloudActivity } from '../cloudEventLog.js';

/** @param {{doc?:Document,desktop:boolean,check?:()=>Promise<any>,copy?:(text:string)=>Promise<void>}} options */
export function bindCloudDiagnosticsPanel(options) {
  const doc = options.doc || document;
  const panel = doc.getElementById('cloud-diagnostics-panel');
  const check = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-diagnostics-check'));
  const copy = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-diagnostics-copy'));
  const report = /** @type {HTMLTextAreaElement|null} */ (doc.getElementById('cloud-diagnostics-report'));
  const status = doc.getElementById('cloud-diagnostics-status');
  if (!panel || !check || !copy || !report || !status || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  let busy = false,
    stopped = false,
    result = null;
  const render = () => {
    report.value = cloudDiagnosticReport({ desktop: options.desktop, result });
  };
  const update = () => {
    check.disabled = busy || stopped || !options.desktop || !options.check;
  };
  const reset = () => {
    stopped = true;
    result = null;
    clearCloudDiagnostics();
    render();
    update();
  };
  subscribeCloudActivity(render);
  subscribeCloudDiagnostics(render);
  panel.addEventListener('toggle', render);
  // Clipboard fallback selects the SAME sanitized report, never source objects.
  copy.addEventListener('click', async () => {
    render();
    try {
      await (options.copy || (text => doc.defaultView.navigator.clipboard.writeText(text)))(report.value);
      status.textContent = 'Безопасный отчёт скопирован. Можно отправить его в чат.';
    } catch {
      report.focus();
      report.select();
      status.textContent = 'Автокопирование недоступно. Отчёт выделен: нажмите Ctrl+C.';
    }
  });
  check.addEventListener('click', async () => {
    if (busy || stopped || !options.desktop || !options.check) return;
    busy = true;
    update();
    status.textContent = 'Проверяем подключённые диски без отправки файлов…';
    try {
      const next = await cloudStep('diagnostic_check', null, options.check);
      if (stopped) return;
      if (!next) {
        status.textContent = 'Сейчас выполняется другое действие. Дождитесь его завершения и повторите проверку.';
        return;
      }
      result = projectCloudDiagnosticResult(next);
      const partial =
        result.results.some(row => !['checked', 'empty', 'credential_missing'].includes(row.status)) ||
        result.pending.some(row => !['sent_verified', 'not_found', 'checked', 'empty'].includes(row.status));
      status.textContent = next.diagnosticFailed
        ? 'Проверка остановлена. Этап и код ошибки — в отчёте.'
        : partial
          ? 'Проверка завершена не полностью: есть недоступный диск или неподтверждённая отправка. Причины — в отчёте.'
          : 'Проверка завершена. Результаты каждого диска и прежние ошибки сохранения — в отчёте.';
    } catch {
      status.textContent = 'Проверка остановлена. Этап и безопасный код ошибки — в отчёте.';
    } finally {
      busy = false;
      render();
      update();
    }
  });
  doc.defaultView?.addEventListener('tf-factory-reset-started', reset);
  status.textContent = options.desktop
    ? 'Сначала повторите ошибочное действие, затем скопируйте отчёт. Этапы хранятся только до закрытия приложения.'
    : 'Реальная проверка доступна в настольном приложении Windows. Здесь можно посмотреть формат отчёта.';
  render();
  update();
  return { render };
}
