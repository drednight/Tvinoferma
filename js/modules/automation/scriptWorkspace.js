// Variant B promoted from the demo. Only presentation/selection: real runners,
// confirmations, per-account deduplication and uncertain-write rules stay intact.
import { renderDock } from '../../core/taskLog.js';
import { state } from '../../core/state.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { partiesOf } from '../parties/membership.js';
import { openCharacterPicker, classIconHtml, stripeCls } from './characterPicker.js';

const contexts = new WeakMap();
export function layoutScriptWorkspace(dlg, selection, { running = false } = {}) {
  let ctx = contexts.get(dlg);
  if (!ctx) {
    ctx = { id: crypto.randomUUID(), mode: 'manual', party: '', ids: new Set(), picker: null };
    contexts.set(dlg, ctx);
    const close = dlg.close;
    dlg.close = () => {
      ctx.picker?.close();
      close();
      renderDock();
    };
  }
  if (dlg.body.querySelector(':scope > .sp-body')) return;
  const children = [...dlg.body.children];
  const body = document.createElement('div');
  body.className = 'sp-body';
  const side = document.createElement('aside');
  side.className = 'sp-side';
  const main = document.createElement('div');
  main.className = 'sp-main';
  body.append(side, main);
  dlg.el.querySelector('.modal-container').classList.add('sp-container');
  if (selection) {
    ctx.ids = new Set(selection.selected);
    ctx.selection = selection;
    const target = document.createElement('section');
    target.className = 'script-target sp-field';
    target.setAttribute('aria-label', 'Кого запускать');
    const choices = [
      ['logged', '🟢 Только с входом', `${state.characters.filter(c => c.isLoggedIn === true).length} персонажей`],
      ['all', '👥 Все', `${state.characters.length} персонажей`],
      ['party', '🛡 По пати…', `${state.parties.length} пати на выбор`],
      ['manual', '🖐 Выбрать вручную', 'открыть выбор персонажей']
    ];
    target.innerHTML = `<label>Кого запускать</label><div class="sp-radios">${choices.map(([value, title, hint]) => `<label class="sp-radio"><input type="radio" name="${ctx.id}" value="${value}" ${ctx.mode === value ? 'checked' : ''}><span>${title}</span><small>${hint}</small></label>`).join('')}</div><select class="input" data-script-party aria-label="Выбор пати" ${ctx.mode === 'party' ? '' : 'hidden'}><option value="">Выберите пати…</option>${state.parties.map(p => `<option value="${esc(p.id)}" ${ctx.party === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><div class="sp-manual-summary" ${ctx.mode === 'manual' ? '' : 'hidden'}><span>Выбрано: <b>${ctx.ids.size}</b></span><button type="button" class="btn small ghost" data-script-picker>Изменить (${ctx.ids.size})</button></div>`;
    const apply = () => {
      const ids =
        ctx.mode === 'logged'
          ? state.characters.filter(c => c.isLoggedIn === true).map(c => c.id)
          : ctx.mode === 'all'
            ? state.characters.map(c => c.id)
            : ctx.mode === 'party'
              ? state.characters.filter(c => partiesOf(c, state.parties).some(p => p.id === ctx.party)).map(c => c.id)
              : [...ctx.ids];
      selection.apply(ids, ctx.mode);
    };
    target.addEventListener('change', e => {
      if (e.target.matches('input[type=radio]')) {
        if (e.target.value === 'manual') {
          openPicker(e);
          return;
        }
        ctx.mode = e.target.value;
        if (ctx.mode === 'party') ctx.party = '';
        apply();
      }
      if (e.target.matches('[data-script-party]')) {
        ctx.party = e.target.value;
        apply();
      }
    });
    const openPicker = e => {
      ctx.picker = openCharacterPicker({
        characters: state.characters.map(c => ({
          ...c,
          cls: c.class || c.className,
          parties: partiesOf(c, state.parties).map(p => p.name),
          party: partiesOf(c, state.parties)
            .map(p => p.name)
            .join(', ')
        })),
        selected: ctx.ids,
        parent: dlg.el,
        returnFocus: e.target?.matches('input') ? e.target : target.querySelector('[data-script-picker]'),
        onClose: ids => {
          ctx.picker = null;
          if (ids && dlg.el.isConnected) {
            ctx.ids = ids;
            ctx.mode = 'manual';
            apply();
          } else {
            target.querySelectorAll('input[type=radio]').forEach(r => {
              r.checked = r.value === ctx.mode;
            });
          }
        }
      });
    };
    target.querySelector('[data-script-picker]').onclick = openPicker;
    side.append(target);
    for (const child of children) {
      const isCharacters = child.querySelector('#promo-list,#caravan-list');
      if (isCharacters) {
        child.hidden = true;
        child.classList.add('script-original-selection');
        main.append(child);
      } else if (child.querySelector('#promo-code')) {
        const field = child.querySelector('.field');
        field.className = 'sp-field';
        const label = document.createElement('label');
        label.htmlFor = 'promo-code';
        label.textContent = 'Промокоды';
        field.prepend(label);
        field.querySelector('.promo-hint')?.remove();
        side.prepend(field);
      } else if (child.matches('.sd-note')) {
        const explanation = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Что сделает скрипт';
        explanation.append(summary, child);
        side.append(explanation);
      } else if (
        child.querySelector('#promo-code,#shop-items') ||
        child.matches('.sd-note,.tr-servers,.tr-top,.tr-ack-box')
      )
        side.append(child);
      else main.append(child);
    }
    // Old selectors remain in the DOM for the real controllers, not as a second UX.
    body.querySelector('#shop-party')?.setAttribute('hidden', '');
    if (selection.plan) {
      const skip = document.createElement('label');
      skip.className = 'sp-check';
      skip.innerHTML = '<input type="checkbox" checked disabled> Пропускать уже введённые (по журналу)';
      const summary = document.createElement('div');
      summary.className = 'sp-summary';
      summary.dataset.scriptSummary = '';
      side.append(skip, summary);
      main.insertAdjacentHTML(
        'beforeend',
        '<div class="sp-progress"><div class="sp-progress-top"><span class="sp-status">Готов к запуску</span><b data-script-plan-count></b></div><div class="sd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span style="width:0%"></span></div></div><div data-script-plan></div>'
      );
    } else if (body.querySelector('#promo-list,#caravan-list')) {
      const plan = document.createElement('section');
      plan.className = 'script-plan';
      plan.innerHTML =
        '<h4>План запуска</h4>' +
        (selection.preview
          ? selection.preview(ctx.ids)
          : ctx.ids.size
            ? state.characters
                .filter(c => ctx.ids.has(c.id))
                .map(
                  c =>
                    `<div class="script-plan-row promo-item ${stripeCls(c)}">${classIconHtml({ ...c, cls: c.class || c.className })}<b>${esc(c.nick)}</b><small>${esc(
                      partiesOf(c, state.parties)
                        .map(p => p.name)
                        .join(', ')
                    )}</small></div>`
                )
                .join('')
            : '<p class="muted">Выберите персонажей слева. Никакие действия ещё не запущены.</p>');
      main.append(plan);
    }
    ctx.settings = side;
  } else {
    if (ctx.settings) {
      const settings = document.createElement('div');
      settings.className = 'sp-frozen-settings';
      settings.inert = true;
      settings.append(...ctx.settings.children);
      side.append(settings);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn ghost';
      edit.textContent = 'Изменить настройки';
      edit.disabled = running;
      edit.onclick = () => ctx.selection?.apply([...ctx.ids]);
      side.append(edit);
      ctx.settings = settings;
    }
    if (running) {
      side.classList.add('is-locked');
    }
    main.append(...children);
  }
  dlg.body.replaceChildren(body);
  refreshScriptPlan(dlg);
  renderDock();
}

export function refreshScriptPlan(dlg) {
  const ctx = contexts.get(dlg),
    target = dlg.body.querySelector('[data-script-plan]');
  if (!target || !ctx?.selection?.plan) return;
  const plan = ctx.selection.plan();
  target.innerHTML = plan.html;
  const summary = dlg.body.querySelector('[data-script-summary]');
  if (summary)
    summary.innerHTML = `<b>${plan.todo}</b><span>вводов у <b>${plan.characters}</b> персонажей</span><small>ещё ${plan.skipped} пропустим (уже введены)</small>`;
  const count = dlg.body.querySelector('[data-script-plan-count]');
  if (count) count.textContent = `план: ${plan.total}`;
}
