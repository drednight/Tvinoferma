// Источник для общего журнала КОПИИ приложения. Только память этой вкладки.
import { registerLogSource, openLogHub } from '../app/replica/js/core/logHub.js';
import { openOverlay } from '../app/replica/js/modules/marathons/overlay.js';
import { DEMO_PROVIDERS } from './workflow.js';

const SOURCE = 'cloud-sync-demo';

/** Демо-записи помечены как примеры и не попадают в журнал настоящего приложения. */
export function createDemoCloudLogSource() {
  let entries = [];
  let nextId = 0;
  const subscribers = new Set();
  const notify = () => subscribers.forEach(fn => fn());
  const getEntries = () => entries.map(item => structuredClone(item.event));
  const subscribe = fn => {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  };
  const clear = () => {
    entries = [];
    notify();
  };

  registerLogSource({
    id: SOURCE,
    title: 'Синхронизация · пример',
    icon: '☁️',
    list: () =>
      entries.map(({ key, event }) => ({
        key,
        at: event.at,
        title: event.action === 'upload' ? 'Пример: отправка на диск' : 'Пример: обновление с диска',
        status: 'ok',
        summary:
          event.action === 'upload'
            ? 'Условная версия, настоящей отправки не было'
            : `Выбрано изменений: ${event.changes.length}`,
        who: DEMO_PROVIDERS[event.provider]
      })),
    open(item) {
      const row = entries.find(entry => entry.key === item.key);
      if (!row) return;
      const { event } = row;
      const overlay = openOverlay({
        title: event.action === 'upload' ? 'Пример отправки на диск' : 'Пример обновления с диска'
      });
      const intro = document.createElement('p');
      intro.textContent = `${DEMO_PROVIDERS[event.provider]} · Вымышленные данные; настоящих изменений и передачи не было.`;
      overlay.body.appendChild(intro);
      if (event.changes.length) {
        const heading = document.createElement('strong');
        heading.textContent = 'Выбранные изменения';
        overlay.body.appendChild(heading);
        const list = document.createElement('ul');
        for (const change of event.changes) {
          const line = document.createElement('li');
          line.textContent = `${change.section} · ${change.title} — ${change.field}`;
          list.appendChild(line);
        }
        overlay.body.appendChild(list);
      }
      overlay.foot.innerHTML = '<span></span><button type="button" class="btn primary" data-close>Закрыть</button>';
      overlay.foot.querySelector('[data-close]').onclick = () => overlay.close();
    },
    subscribe,
    clear,
    clearConfirm: 'Очистить только вымышленные записи синхронизации в этом примере?'
  });

  return {
    add(event) {
      if (!event || !['upload', 'update'].includes(event.action) || !Object.hasOwn(DEMO_PROVIDERS, event.provider)) {
        throw new Error('Неизвестная запись демо-журнала');
      }
      entries.unshift({ key: `demo-sync-${++nextId}`, event: structuredClone(event) });
      if (entries.length > 100) entries.length = 100;
      notify();
    },
    clear,
    getEntries,
    subscribe,
    open: () => openLogHub({ source: SOURCE, title: '☁️ Синхронизация · пример' })
  };
}
