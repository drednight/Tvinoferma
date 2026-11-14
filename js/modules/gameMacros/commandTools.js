import { showModal, toast } from '../../core/ui.js';
import { state } from '../../core/state.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { reviewCommand, reviewHtml } from './review.js';
import { exportCommands, importCommandPlan } from './transfer.js';
export function openCommandReview(command, c) {
  showModal({
    title: `План: ${command.name}`,
    wide: true,
    content: reviewHtml(reviewCommand(command, c, state)),
    submitText: null,
    cancelText: 'Закрыть'
  });
}
export function openCommandTransfer(getConfig, save) {
  showModal({
    title: 'Команды: экспорт и импорт',
    wide: true,
    submitText: null,
    cancelText: 'Закрыть',
    content: `<div class="gm-dialog gm-command-transfer"><h4>Экспорт</h4><p>Только команды, без паролей, настроек входа, результатов тестов и черновиков.</p><label><input type="checkbox" data-export-points> Включить координаты и профили окон (могут раскрывать названия и локальные ID)</label><button class="btn" data-export-commands>Скачать команды JSON</button><h4>Импорт с предпросмотром</h4><p>Не запускает ввод. Совпадение названия не заменяет команду без выбранного режима. После импорта команды заблокированы до проверки и сохранения в редакторе.</p><input type="file" accept=".json,application/json" data-import-file aria-label="Файл команд"><label>Режим<select data-import-mode><option value="copy">Добавить копии (безопасно)</option><option value="replace">Заменить команды с совпадающими названиями</option></select></label><button class="btn" data-import-preview>Показать изменения</button><div data-import-report role="status"></div><label><input type="checkbox" data-import-ack> Я проверил изменения, получателей и предупреждения</label><button class="btn primary" data-import-apply disabled>Импортировать без запуска</button></div>`
  });
  const root = document.querySelector('.gm-command-transfer'),
    report = root?.querySelector('[data-import-report]'),
    apply = root?.querySelector('[data-import-apply]');
  if (!root) return;
  let pending = null,
    source = '',
    baseline = '',
    epoch = 0;
  root.querySelector('[data-export-commands]').onclick = () => {
    const blob = new Blob([exportCommands(getConfig(), root.querySelector('[data-export-points]').checked)], {
        type: 'application/json'
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = 'tvinoferma-commands.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  const invalidate = () => {
    epoch++;
    pending = null;
    apply.disabled = true;
    root.querySelector('[data-import-ack]').checked = false;
    report.textContent = 'Изменён файл или режим: повторите предпросмотр.';
  };
  root.querySelector('[data-import-file]').onchange = invalidate;
  root.querySelector('[data-import-mode]').onchange = invalidate;
  root.querySelector('[data-import-preview]').onclick = async () => {
    try {
      const requestEpoch = ++epoch;
      const file = root.querySelector('[data-import-file]').files?.[0];
      if (!file || file.size > 512000) throw new Error('Выберите JSON-файл меньше 500 КБ.');
      source = await file.text();
      if (requestEpoch !== epoch) return;
      baseline = exportCommands(getConfig(), true);
      pending = importCommandPlan(source, getConfig(), root.querySelector('[data-import-mode]').value);
      root.querySelector('[data-import-ack]').checked = false;
      apply.disabled = true;
      report.innerHTML = pending.changes
        .map(
          change =>
            `<article><b>${esc(change.mode)}: ${esc(change.name)}</b><ul>${change.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></article>`
        )
        .join('');
    } catch (error) {
      pending = null;
      apply.disabled = true;
      report.textContent = error.message;
    }
  };
  root.querySelector('[data-import-ack]').onchange = e => {
    apply.disabled = !pending || !e.target.checked;
  };
  apply.onclick = async () => {
    if (!pending || !root.querySelector('[data-import-ack]').checked) return;
    apply.disabled = true;
    try {
      // Rebuild against current data so a stale preview cannot silently overwrite concurrent edits.
      if (exportCommands(getConfig(), true) !== baseline)
        throw new Error('Команды или координаты изменились. Повторите предпросмотр.');
      const current = importCommandPlan(source, getConfig(), root.querySelector('[data-import-mode]').value);
      if (JSON.stringify(current.changes) !== JSON.stringify(pending.changes))
        throw new Error('Команды изменились. Повторите предпросмотр.');
      await save(current.patch);
      pending = null;
      report.textContent = 'Импортировано. Перед запуском проверьте и сохраните каждую команду в редакторе.';
    } catch (error) {
      report.textContent = error.message;
      toast(error.message, 'error');
    }
  };
}

export function openExecutionDiagnostics(history) {
  const text = JSON.stringify(
    { schema: 1, meaning: 'Technical evidence only; game actions require manual confirmation.', runs: history },
    null,
    2
  );
  showModal({
    title: 'Диагностика по запускам',
    wide: true,
    submitText: null,
    cancelText: 'Закрыть',
    content: `<div class="gm-dialog"><p>Для каждого запуска: runId, этап, Windows/API-результат и причина остановки. Первые и последние события сохраняются; пропуски отмечены. Игровое действие автоматически не определяется.</p><div class="gm-journal-actions"><button class="btn" data-trace-copy>Копировать диагностику</button><button class="btn ghost" data-trace-export>Скачать JSON</button></div><p data-trace-status role="status"></p><textarea class="input" rows="16" readonly aria-label="Структурированная диагностика">${esc(text)}</textarea></div>`
  });
  if (!document.querySelector('[data-trace-copy]')) return;
  document.querySelector('[data-trace-copy]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      document.querySelector('[data-trace-status]').textContent = 'Диагностика скопирована.';
    } catch {
      document.querySelector('textarea[aria-label="Структурированная диагностика"]').select();
      document.querySelector('[data-trace-status]').textContent = 'Нажмите Ctrl+C для ручного копирования.';
    }
  };
  document.querySelector('[data-trace-export]').onclick = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
      a = document.createElement('a');
    a.href = url;
    a.download = 'tvinoferma-execution-diagnostics.json';
    a.click();
    URL.revokeObjectURL(url);
  };
}
