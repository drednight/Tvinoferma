// Единственная точка запуска копии: сначала защита, затем вымышленные данные и только потом UI.
import { DEMO_RUNES, makeDemoAppData, ensureDemoMarathon, isDemoMarathonActive, demoTodayEvents } from './fixtures.js';

if (!window.__DEMO_GUARD_READY__) {
  document.body.innerHTML = `<p role="alert">Демо остановлено: не удалось изолировать хранилище и нативные функции.</p>`;
} else {
  window.__DEMO_RUNES__ = DEMO_RUNES;
  localStorage.setItem('tvinoferma_state_v1', JSON.stringify(makeDemoAppData()));
  const { state } = await import('./replica/js/core/state.js');
  const { boot } = await import('./replica/js/main.js');
  const { persist } = await import('./replica/js/core/storage.js');
  const { renderGuildToday } = await import('./replica/js/modules/guild/page.js');
  const { renderMarathons } = await import('./replica/js/modules/marathons/page.js');
  const { marathonTotals } = await import('./replica/js/modules/marathons/model.js');
  const { mskDate } = await import('./replica/js/core/msk.js');
  const { toast } = await import('./replica/js/core/ui.js');
  // В отдельном источнике общего журнала видны только вымышленные действия этой вкладки.
  const { createDemoCloudLogSource } = await import('../cloud-sync/logSource.js');
  const demoCloudLog = createDemoCloudLogSource();

  await boot();
  // Native manual secrets transfer is never simulated with real contact values.
  document
    .querySelectorAll('#cloud-private-panel input, #cloud-private-panel button, #cloud-private-panel select')
    .forEach(control => {
      control.disabled = true;
    });

  const { mountCloudSyncDemo } = await import('../cloud-sync/view.js');
  mountCloudSyncDemo(document.getElementById('demo-cloud-sync'), {
    onLog: demoCloudLog.add,
    onReset: demoCloudLog.clear,
    openLog: demoCloudLog.open,
    getLogs: demoCloudLog.getEntries,
    subscribeLogs: demoCloudLog.subscribe
  });
  // Примеры и результаты запуска записываются только в изолированный журнал копии.
  const { startTask } = await import('./replica/js/core/taskLog.js');
  const { makeScriptReport } = await import('./replica/js/modules/automation/scriptReport.js');
  const saveDemoReport = report => {
    const task = startTask(report.title, { dock: false });
    task.setScriptReport(report);
    task.finish('Демонстрационный результат: на сайт ничего не отправлялось.', 'done');
  };
  window.addEventListener('tf-demo:script-report', event => saveDemoReport(event.detail));
  const first = state.characters[0];
  const second = state.characters[1];
  const sample = makeScriptReport('transfer', [
    {
      charId: first.id,
      nick: first.nick,
      status: 'success',
      server: 'Сервер 1 (пример)',
      recipient: first.nick,
      done: [{ name: 'Камень светлого духа', qty: 2 }]
    },
    {
      charId: second.id,
      nick: second.nick,
      status: 'unknown',
      uncertain: true,
      server: 'Сервер 1 (пример)',
      recipient: second.nick,
      items: [{ name: 'Подарок акции', qty: 1 }]
    }
  ]);
  sample.title = 'Демо · Пример передачи';
  saveDemoReport(sample);
  // В настоящем приложении «проверяется» — временное состояние, не поле на диске.
  state.ui.authCheck.c5 = 'checking';
  let savedPoll = state.settings.guild.poll;
  let parkedMarathons = null;
  const sections = new Set(['today', 'characters', 'parties', 'marathons', 'runes', 'finance', 'tools', 'settings']);
  const post = data => {
    if (parent !== window) parent.postMessage(data, location.origin);
  };
  const notice = message => {
    toast(message, 'info');
    post({ type: 'tf-demo:notice', message });
  };

  function sendSnapshot() {
    const today = mskDate();
    const marathon = state.marathons.find(m => isDemoMarathonActive(m, today));
    const days = marathon
      ? Math.max(
          0,
          Math.round((Date.parse(`${marathon.endDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
        )
      : 0;
    const month = today.slice(0, 7);
    const bank = state.finance.operations
      .filter(op => op.currency === 'coins' && op.date.startsWith(month))
      .reduce((total, op) => total + (op.kind === 'in' ? op.amount : -op.amount), 0);
    post({
      type: 'tf-demo:snapshot',
      snapshot: {
        characters: state.characters.map(c => ({
          id: c.id,
          nick: c.nick,
          className: c.class,
          party: c.mainPartyId,
          isLoggedIn: c.isLoggedIn,
          checking: state.ui.authCheck?.[c.id] === 'checking',
          coins: c.ancientCoins
        })),
        parties: state.parties.map(p => ({ id: p.id, name: p.name })),
        events: demoTodayEvents(state, today),
        marathon: marathon ? { title: marathon.title, days, percent: marathonTotals(marathon).percent } : null,
        bank,
        clanEnabled: !!state.settings.guild.enabled,
        pollEnabled: !!state.settings.guild.poll,
        clanResponses: Object.fromEntries((state.settings.guild.events || []).map(event => [event.id, event.response])),
        poll: state.settings.guild.poll
      }
    });
  }

  window.addEventListener('tf-persisted', sendSnapshot);
  document.addEventListener(
    'click',
    event => {
      const tab = event.target.closest?.('.tab[data-tab]');
      if (tab && sections.has(tab.dataset.tab)) {
        document.getElementById('demo-section-heading').textContent =
          tab.querySelector('strong')?.textContent || tab.dataset.tab;
        post({ type: 'tf-demo:navigated', section: tab.dataset.tab });
      }
      const btn = event.target.closest?.('[data-guild]');
      if (btn) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (btn.dataset.guild === 'respond') {
          const item = state.settings.guild.events.find(e => e.id === btn.dataset.event);
          if (item) item.response = btn.dataset.response === 'yes' ? 'yes' : 'no';
          void persist().then(() => renderGuildToday());
          notice('Ответ сохранён только в демо, на сайт ничего не отправлено.');
        } else notice('В демо действия с сайтом клана только имитируются.');
        return;
      }
      const script = event.target.closest?.('[data-script-action]');
      if (!script) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = script.dataset.scriptAction;
      if (['promo', 'transfer', 'shop', 'caravan'].includes(id)) {
        import('../lab-data.js')
          .then(({ setLabRoster }) => {
            setLabRoster(
              state.characters.map(c => ({ ...c, checking: state.ui.authCheck?.[c.id] === 'checking' })),
              state.parties
            );
            if (id === 'promo') return import('../tools-modals.js').then(m => m.openSplit());
            return import('../scenarios.js').then(m => m.openScenario(id));
          })
          .catch(() => notice('Не удалось открыть окно инструмента в демо.'));
      } else notice('Проверка в демо имитируется: запросы к сайту не отправляются.');
    },
    true
  );

  document.addEventListener(
    'submit',
    event => {
      const form = event.target.closest?.('[data-guild-poll]');
      if (!form) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const selected = [...form.querySelectorAll('input:checked')].map(input => input.value);
      if (!selected.length) {
        notice('Выберите вариант ответа в демо.');
        return;
      }
      const poll = state.settings.guild.poll;
      if (!poll) return;
      poll.options.forEach(option => {
        option.selected = selected.includes(option.id);
      });
      savedPoll = poll;
      void persist().then(() => renderGuildToday());
      notice('Демо-голос сохранён только здесь, на сайт ничего не отправлено.');
    },
    true
  );

  window.addEventListener('message', async event => {
    if (event.source !== window.parent || event.origin !== location.origin || !event.data) return;
    const { type } = event.data;
    if (type === 'tf-demo:navigate' && sections.has(event.data.section)) {
      document.querySelector(`.tab[data-tab="${event.data.section}"]`)?.click();
    } else if (type === 'tf-demo:scenarios') {
      const { clanEnabled, pollEnabled, marathonActive, poll, clanResponses } = event.data;
      state.settings.guild.enabled = !!clanEnabled;
      if (poll) savedPoll = JSON.parse(JSON.stringify(poll));
      state.settings.guild.poll = pollEnabled ? savedPoll : null;
      if (clanResponses)
        state.settings.guild.events.forEach(ev => {
          if (ev.id in clanResponses) ev.response = clanResponses[ev.id];
        });
      if (!marathonActive && parkedMarathons === null) {
        parkedMarathons = state.marathons;
        state.marathons = [];
      } else if (marathonActive && parkedMarathons !== null) {
        state.marathons = parkedMarathons;
        parkedMarathons = null;
      }
      if (marathonActive) ensureDemoMarathon(state.marathons, state.characters);
      await persist();
      renderGuildToday();
      if (document.querySelector('.page[data-section="marathons"].active')) renderMarathons();
      sendSnapshot();
    } else if (type === 'tf-demo:reset') {
      // После перезагрузки guard снова создаст пустое изолированное хранилище.
      location.reload();
    }
  });

  sendSnapshot();
  post({ type: 'tf-demo:ready' });
  // Прямые ссылки для просмотра отдельных идей в разделе синхронизации.
  const show = new URLSearchParams(location.search).get('show');
  if (show === 'statistics' || show === 'cloud-sync') {
    document.querySelector('.tab[data-tab="settings"]')?.click();
    document.querySelector('a[href="#settings-sync"]')?.click();
  }
  if (show === 'statistics') {
    document.querySelector('#log-hub-panel > summary')?.click();
    const { openTaskStatistics } = await import('./replica/js/core/taskLog.js');
    openTaskStatistics();
  }
}
