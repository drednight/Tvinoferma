import { openOverlay } from '../marathons/overlay.js';
import { copyJournal } from './journal.js';
import { safeDiagnostic } from './trace.js';
const KEY = 'tvinoferma.background-journal.v1';
const fields = new Set([
  'schema',
  'action',
  'key',
  'method',
  'runId',
  'commandId',
  'stage',
  'status',
  'phase',
  'pid',
  'startedAt',
  'hwnd',
  'at',
  'ok',
  'error',
  'errorCode',
  'inputSent',
  'foregroundChanged',
  'refused',
  'visible',
  'minimized',
  'hung',
  'identityChecked',
  'integrityAllowed',
  'appElevated',
  'targetElevated',
  'selectedKeyHeld',
  'modifierHeld',
  'asynchronous',
  'skipped',
  'elapsedMs',
  'elapsedUs',
  'holdMs',
  'vk',
  'scan',
  'message',
  'lparam',
  'wparam',
  'before',
  'after',
  'originalForeground',
  'blockedBy',
  'count',
  'attempt',
  'issueCount',
  'n',
  'omitted',
  'sessionId',
  'recipients',
  'ageMs',
  'repeats',
  'up',
  'mouse',
  'events',
  'messages',
  'steps',
  'details',
  'reason'
]);
function clean(value, depth = 0) {
  if (depth > 8) return '[depth limit]';
  if (typeof value === 'string') return safeDiagnostic(value);
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(v => clean(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => fields.has(k))
        .map(([k, v]) => [k, clean(v, depth + 1)])
    );
  return null;
}
let records = [],
  storageError = '',
  loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(rows)) records = rows.map(row => clean(row));
  } catch {
    storageError = 'Не удалось прочитать сохранённый журнал. Исходная запись не перезаписана.';
  }
}
export function backgroundJournalEntries() {
  load();
  return structuredClone(records);
}
export function appendBackgroundJournal(stage, details = {}) {
  load();
  records.push(clean({ at: new Date().toISOString(), stage, details }));
  if (!storageError)
    try {
      localStorage.setItem(KEY, JSON.stringify(records));
    } catch {
      storageError =
        'Хранилище заполнено или недоступно. Новые записи есть только в памяти: скачайте журнал до закрытия приложения.';
    }
  window.dispatchEvent(new Event('tf-background-journal'));
}
export function backgroundJournalText() {
  load();
  return JSON.stringify(
    {
      schema: 1,
      createdAt: new Date().toISOString(),
      status: storageError || 'Сохранено локально; Windows delivery ≠ game effect',
      records
    },
    null,
    2
  );
}
export function openBackgroundJournal() {
  load();
  const ov = openOverlay({
    title: 'Журнал только фонового ввода',
    wide: true,
    onClose: () => window.removeEventListener('tf-background-journal', render)
  });
  ov.body.innerHTML =
    '<p>Фоновые команды, диагностические пробы и повтор. Обычные команды сюда не добавляются. Журнал сохраняется локально между запусками; сбор начался с этой версии — старые события восстановить нельзя. Пароли, URL и cookies не записываются. Перед отправкой просмотрите файл: время, клавиши и PID могут раскрывать сведения.</p><p data-journal-status role="status"></p><textarea class="input" rows="18" readonly aria-label="Весь журнал фонового ввода"></textarea>';
  const render = () => {
    ov.body.querySelector('textarea').value = backgroundJournalText();
    ov.body.querySelector('[data-journal-status]').textContent =
      storageError ||
      `Записей: ${records.length}. Сохранены локально. Принятие Windows не подтверждает действие в игре.`;
  };
  ov.foot.innerHTML =
    '<button class="btn" data-copy>Копировать всё</button><button class="btn" data-download>Скачать JSON</button><button class="btn ghost" data-clear>Очистить…</button><button class="btn" data-close>Закрыть</button>';
  ov.foot.querySelector('[data-copy]').onclick = () =>
    copyJournal([backgroundJournalText()], ov.body, ov.body.querySelector('[data-journal-status]'));
  ov.foot.querySelector('[data-download]').onclick = () => {
    const url = URL.createObjectURL(new Blob([backgroundJournalText()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tvinoferma-background-journal.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  ov.foot.querySelector('[data-clear]').onclick = async () => {
    const { confirmModal } = await import('../../core/ui.js');
    if (
      !(await confirmModal({
        title: 'Очистить журнал фонового ввода?',
        text: 'Сначала скачайте нужные результаты. Очистка удалит сохранённые и текущие записи.',
        okText: 'Очистить',
        danger: true
      }))
    )
      return;
    try {
      localStorage.removeItem(KEY);
      records = [];
      storageError = '';
      render();
    } catch {
      storageError = 'Очистка хранилища не подтверждена.';
      render();
    }
  };
  ov.foot.querySelector('[data-close]').onclick = () => ov.close();
  window.addEventListener('tf-background-journal', render);
  render();
  return ov;
}
