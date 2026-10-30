// @ts-check
import {
  cloudActivity,
  cloudActivityPersisted,
  clearCloudActivity,
  describeCloudActivity,
  subscribeCloudActivity
} from '../cloudEventLog.js';
import { confirmModal } from '../../../core/ui.js';

/** @param {{doc?:Document, confirm?:(message:string)=>boolean|Promise<boolean>}} [options] */
export function bindCloudActivityPanel(options = {}) {
  const doc = options.doc || document;
  const panel = doc.getElementById('cloud-activity-panel');
  const list = doc.getElementById('cloud-activity-list');
  const status = doc.getElementById('cloud-activity-status');
  const clear = /** @type {HTMLButtonElement|null} */ (doc.getElementById('cloud-activity-clear'));
  if (!panel || !list || !status || !clear || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  const askConfirmation =
    options.confirm ||
    (message => confirmModal({ title: 'Очистить журнал', text: message, okText: 'Очистить', danger: true }));
  function render() {
    const events = cloudActivity();
    list.replaceChildren();
    for (const event of events) {
      const row = doc.createElement('li');
      row.textContent = describeCloudActivity(event);
      list.appendChild(row);
    }
    status.textContent = !cloudActivityPersisted()
      ? 'Локальное хранилище журнала недоступно; показаны только события текущего запуска.'
      : events.length
        ? `Последних событий: ${events.length}.`
        : 'Записей пока нет.';
    clear.disabled = events.length === 0;
  }
  subscribeCloudActivity(render);
  clear.addEventListener('click', async () => {
    clear.disabled = true;
    try {
      if (
        await askConfirmation('Очистить местный журнал синхронизации? Данные, файлы облака и настройки не изменятся.')
      )
        clearCloudActivity();
    } finally {
      render();
    }
  });
  render();
}
