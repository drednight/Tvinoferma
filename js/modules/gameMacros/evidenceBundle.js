import { normalizeTrials } from './trialRecords.js';
import { showModal } from '../../core/ui.js';
import { escapeHtml as esc } from '../../core/utils.js';
export function exportTrialBundle(trials, selected, { includeNotes = false, includeIdentifiers = false } = {}) {
  const rows = normalizeTrials(trials).filter(row => selected.includes(row.id));
  if (!rows.length) throw new Error('Выберите хотя бы один тест.');
  const recipients = new Map();
  const records = rows.map((row, index) => {
    if (!recipients.has(row.charId)) recipients.set(row.charId, `recipient-${recipients.size + 1}`);
    const trace = row.technical.trace ? structuredClone(row.technical.trace) : null;
    if (trace && !includeIdentifiers) {
      trace.runId = `run-${index + 1}`;
      for (const event of trace.events) {
        delete event.details.pid;
        delete event.details.hwnd;
      }
    }
    return {
      ...row,
      id: `test-${index + 1}`,
      charId: includeIdentifiers ? row.charId : recipients.get(row.charId),
      partyId: includeIdentifiers ? row.partyId : undefined,
      notes: includeNotes ? row.notes : undefined,
      technical: {
        ...row.technical,
        runId: includeIdentifiers ? row.technical.runId : row.technical.runId ? `run-${index + 1}` : '',
        trace
      }
    };
  });
  return JSON.stringify(
    {
      kind: 'tvinoferma-trial-evidence',
      schema: 1,
      createdAt: new Date().toISOString(),
      limitations:
        'Only selected trials. Windows delivery is not game acceptance. Review text before sharing; this is not guaranteed anonymization.',
      records
    },
    null,
    2
  );
}
export function openBundlePreview(trials, selected, options) {
  const text = exportTrialBundle(trials, selected, options);
  const modal = showModal({
    title: 'Предпросмотр пакета диагностики',
    wide: true,
    submitText: null,
    cancelText: 'Закрыть',
    content: `<div class="gm-dialog"><p>Только выбранные тесты. Нет учётных данных, настроек входа и остальных команд. Время, клавиши и текст диагностики могут раскрывать сведения — просмотрите весь файл перед передачей. Это не гарантия анонимности.</p><textarea rows="16" class="input" readonly aria-label="Пакет выбранных тестов">${esc(text)}</textarea><button class="btn primary" data-bundle-download>Скачать выбранный пакет JSON</button></div>`
  });
  modal?.querySelector('[data-bundle-download]').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
      link = document.createElement('a');
    link.href = url;
    link.download = 'tvinoferma-selected-trials.json';
    link.click();
    URL.revokeObjectURL(url);
  });
}
