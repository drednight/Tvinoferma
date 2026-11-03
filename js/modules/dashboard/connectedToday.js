// Opt-in view of the real Today screen. No fake characters or launcher model.
import { mskDate } from '../../core/msk.js';
import { openPlannerDay, openPlannerEntryForm } from './plannerView.js';
import { connectedTodayState } from './todayRuntime.js';
import { state } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { setEntryStatusForDate } from './planner.js';
import { toast } from '../../core/ui.js';
import { renderReferenceToday, bindReferenceToday } from './referenceTodayView.js';
const sessions = new WeakMap();
export function renderConnectedToday(root, deps, render) {
  if (root.dataset.referenceToday !== 'true') return false;
  let session = sessions.get(root);
  if (!session) {
    const model = {
      production: true,
      day: { date: mskDate(), chosenDay: 0, favoriteParty: '', marathon: {}, marathonTasks: [] },
      calendarEvents: [],
      characters: [],
      parties: [],
      activeWindows: [],
      scenarios: {}
    };
    const dialog = document.createElement('dialog');
    dialog.className = 'rt-reference rt-connected-dialog';
    dialog.innerHTML =
      '<button type="button" data-connected-dialog-close>Закрыть</button><h2></h2><div data-connected-dialog-body></div>';
    root.after(dialog);
    dialog.querySelector('button').onclick = () => dialog.close();
    const body = dialog.querySelector('[data-connected-dialog-body]');
    bindReferenceToday({
      root,
      dialog,
      getState: () => model,
      render,
      toast,
      planner: {
        todo: async (id, date, status) => {
          const entry = state.plannerEntries.find(e => e.id === id);
          if (entry && setEntryStatusForDate(entry, date, status)) {
            await persist();
            render();
          }
        },
        day: date => openPlannerDay(date, { render, run: deps.run }),
        add: date => openPlannerEntryForm(date, { render, run: deps.run })
      },
      modal: (title, content) => {
        dialog.querySelector('h2').textContent = title;
        body.innerHTML = content;
        if (!dialog.open) dialog.showModal();
      }
    });
    root.addEventListener('click', e => {
      const day = e.target.closest('[data-day]');
      if (day) {
        model.day.chosenDay = Number(day.dataset.day);
        render();
      }
      const source = e.target.closest('[data-go-source]');
      if (source) {
        if (source.dataset.goSource === 'marathons') {
          const active = connectedTodayState(model).day.marathon;
          if (active?.id) deps.run?.('open-marathon', active.id);
        } else if (source.dataset.goSource === 'parties') deps.run?.('open-party', model.day.favoriteParty);
      }
    });
    root.addEventListener('change', e => {
      if (e.target.matches('[data-party-select]')) {
        model.day.favoriteParty = e.target.value;
        render();
      }
    });
    session = { model, dialog };
    sessions.set(root, session);
  }
  session.model.day.date = mskDate();
  root.innerHTML =
    '<div class="today-layout-actions"><button class="btn ghost" data-today-reference-back>К прежнему виду</button></div>' +
    renderReferenceToday(session.model);
  root.querySelector('[data-today-reference-back]').onclick = () => {
    root.dataset.referenceToday = 'false';
    render();
  };
  return true;
}
