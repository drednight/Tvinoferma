import { state } from '../../core/state.js';
import { charactersInPartyOrdered } from '../parties/membership.js';
import { loadRosters } from '../automation/transferStore.js';
import { loadShopState } from '../automation/shopStore.js';
import { scriptWidgetReports, openTaskStatistics, onTaskChange } from '../../core/taskLog.js';
import { actionWidgetData } from './actionWidgetData.js';

/** Local summaries are never permission to execute a script. Existing dialogs retain confirmation. */
export function mountActionWidget(panel, action, editing) {
  const controls = document.createElement('div'),
    party = document.createElement('select'),
    refresh = document.createElement('button'),
    content = document.createElement('div');
  party.className = 'input';
  party.setAttribute('aria-label', 'Пати в сводке');
  for (const [value, label] of [['', 'Все персонажи'], ...state.parties.map(p => [p.id, p.name])]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    party.append(option);
  }
  refresh.type = 'button';
  refresh.className = 'btn ghost';
  refresh.textContent = '↻ Обновить карточку';
  refresh.title = 'Перечитать сохранённые данные, без запросов на сайт';
  controls.className = 'rt-widget-controls';
  content.className = 'rt-widget-facts';
  content.setAttribute('aria-live', 'polite');
  controls.append(party, refresh);
  panel.append(controls, content);
  let expanded = false,
    promoSources;
  const render = () => {
    const characters = party.value ? charactersInPartyOrdered(state.characters, party.value) : state.characters;
    const data = actionWidgetData(action, {
      characters,
      marathons: state.marathons,
      rosters: loadRosters(),
      shop: loadShopState(),
      reports: action === 'promo' ? [] : scriptWidgetReports(),
      checking: state.ui.authCheck,
      promos: promoSources ? promoSources.coverage(promoSources.codes(), characters, promoSources.log()) : null
    });
    const summary = document.createElement('strong'),
      note = document.createElement('small'),
      list = document.createElement('ul');
    summary.textContent = data.summary || 'Нет сохранённых данных';
    note.textContent = data.note;
    for (const row of expanded ? data.rows : data.rows.slice(0, 5)) {
      const li = document.createElement('li'),
        name = document.createElement('b'),
        detail = document.createElement('span');
      name.textContent = row.name || 'Без имени';
      detail.textContent = row.detail;
      li.append(name, detail);
      list.append(li);
    }
    content.replaceChildren(summary, note, list);
    if (action === 'promo' && !promoSources) {
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'btn ghost';
      reveal.textContent = 'Показать сводку промокодов';
      reveal.disabled = editing;
      reveal.onclick = async () => {
        reveal.disabled = true;
        try {
          const discovery = await import('../automation/promoDiscovery.js'),
            logs = await import('../automation/promoLog.js');
          if (!panel.isConnected) return;
          promoSources = { coverage: discovery.promoCoverage, codes: discovery.discoveredPromos, log: logs.loadLog };
          render();
        } catch {
          reveal.disabled = false;
          reveal.textContent = 'Сводка недоступна — открыть диалог ниже';
        }
      };
      content.append(reveal);
    }
    if (!data.rows.length && action !== 'promo') {
      const empty = document.createElement('p');
      empty.textContent = characters.length
        ? 'Данных пока нет. Откройте сценарий ниже для проверки.'
        : 'В выбранной пати нет персонажей.';
      content.append(empty);
    }
    if (data.rows.length > 5) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn ghost';
      more.textContent = expanded ? 'Свернуть' : `Показать все (${data.rows.length})`;
      more.disabled = editing;
      more.onclick = () => {
        expanded = !expanded;
        render();
      };
      content.append(more);
    }
    if (data.report) {
      const report = document.createElement('p'),
        button = document.createElement('button');
      const statuses = {
        running: data.report.paused ? 'На паузе' : 'Выполняется',
        done: 'Завершён',
        warn: 'Завершён с замечаниями',
        error: 'Ошибка'
      };
      report.textContent = `Последний сценарий: ${data.report.cancelled ? 'Остановлен' : statuses[data.report.status] || 'Неизвестное состояние'}${data.report.dryRun ? ' · пробный запуск' : ''} · строк по выбранным персонажам: ${data.report.rows.length}`;
      button.type = 'button';
      button.className = 'btn ghost';
      button.textContent = 'Подробные итоги';
      button.disabled = editing;
      button.onclick = () => openTaskStatistics(data.report.id);
      content.append(report, button);
    }
  };
  party.disabled = refresh.disabled = editing;
  party.onchange = () => {
    expanded = false;
    render();
  };
  refresh.onclick = render;
  render();
  // One subscription per mounted card; release when its dashboard DOM is replaced.
  let observer;
  const update = () => {
    if (panel.isConnected) render();
    else dispose();
  };
  const unsubscribe = onTaskChange(update);
  const events = ['tf-persisted', 'tf-transfer-log'];
  const dispose = () => {
    unsubscribe();
    observer?.disconnect();
    for (const event of events) window.removeEventListener(event, update);
  };
  for (const event of events) window.addEventListener(event, update);
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (!panel.isConnected) {
        dispose();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  return {
    dispose,
    selectedCharacters: () => (party.value ? charactersInPartyOrdered(state.characters, party.value) : state.characters)
  };
}
