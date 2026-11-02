// Variant B promoted from the demo. Only presentation/selection: real runners,
// confirmations, per-account deduplication and uncertain-write rules stay intact.
import { state } from '../../core/state.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { partiesOf } from '../parties/membership.js';
import { openCharacterPicker, classIconHtml, stripeCls } from './characterPicker.js';

const contexts = new WeakMap();
export function layoutScriptWorkspace(dlg, selection) {
  let ctx = contexts.get(dlg);
  if (!ctx) {
    ctx = { id: crypto.randomUUID(), mode: 'manual', party: '', ids: new Set(), picker: null };
    contexts.set(dlg, ctx);
    const close = dlg.close;
    dlg.close = () => {
      ctx.picker?.close();
      close();
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
    const target = document.createElement('section');
    target.className = 'script-target';
    target.setAttribute('aria-label', 'Кого обрабатывать');
    target.innerHTML = `<b>Кого обрабатывать</b><label><input type="radio" name="${ctx.id}" value="all" ${ctx.mode === 'all' ? 'checked' : ''}> Все персонажи</label><label><input type="radio" name="${ctx.id}" value="party" ${ctx.mode === 'party' ? 'checked' : ''}> По пати…</label><label><input type="radio" name="${ctx.id}" value="manual" ${ctx.mode === 'manual' ? 'checked' : ''}> Выбрать вручную</label><select class="input" data-script-party aria-label="Выбор пати" ${ctx.mode === 'party' ? '' : 'hidden'}><option value="">Выберите пати…</option>${state.parties.map(p => `<option value="${esc(p.id)}" ${ctx.party === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><button type="button" class="btn secondary" data-script-picker>Выбрать вручную (${ctx.ids.size})</button><small>Выбрано: ${ctx.ids.size}. Общие аккаунты обрабатываются по правилам скрипта.</small>`;
    const apply = () => {
      const ids =
        ctx.mode === 'all'
          ? state.characters.map(c => c.id)
          : ctx.mode === 'party'
            ? state.characters.filter(c => partiesOf(c, state.parties).some(p => p.id === ctx.party)).map(c => c.id)
            : [...ctx.ids];
      selection.apply(ids);
    };
    target.addEventListener('change', e => {
      if (e.target.matches('input[type=radio]')) {
        ctx.mode = e.target.value;
        if (ctx.mode === 'party') ctx.party = '';
        apply();
      }
      if (e.target.matches('[data-script-party]')) {
        ctx.party = e.target.value;
        apply();
      }
    });
    target.querySelector('[data-script-picker]').onclick = e => {
      ctx.picker = openCharacterPicker({
        characters: state.characters.map(c => ({
          ...c,
          cls: c.className,
          party: partiesOf(c, state.parties)
            .map(p => p.name)
            .join(', ')
        })),
        selected: ctx.ids,
        parent: dlg.el,
        returnFocus: e.currentTarget,
        onClose: ids => {
          ctx.picker = null;
          if (ids && dlg.el.isConnected) {
            ctx.ids = ids;
            ctx.mode = 'manual';
            apply();
          }
        }
      });
    };
    side.append(target);
    for (const child of children) {
      const isCharacters = child.querySelector('#promo-list,#caravan-list');
      if (isCharacters) {
        child.hidden = true;
        child.classList.add('script-original-selection');
        main.append(child);
      } else if (
        child.querySelector('#promo-code,#shop-items') ||
        child.matches('.sd-note,.tr-servers,.tr-top,.tr-ack-box')
      )
        side.append(child);
      else main.append(child);
    }
    // Old selectors remain in the DOM for the real controllers, not as a second UX.
    body.querySelector('#shop-party')?.setAttribute('hidden', '');
    if (body.querySelector('#promo-list,#caravan-list')) {
      const plan = document.createElement('section');
      plan.className = 'script-plan';
      plan.innerHTML =
        '<h4>План запуска</h4>' +
        (ctx.ids.size
          ? state.characters
              .filter(c => ctx.ids.has(c.id))
              .map(
                c =>
                  `<div class="promo-item ${stripeCls(c)}">${classIconHtml({ ...c, cls: c.className })}<b>${esc(c.nick)}</b><small>${esc(
                    partiesOf(c, state.parties)
                      .map(p => p.name)
                      .join(', ')
                  )}</small></div>`
              )
              .join('')
          : '<p class="muted">Выберите персонажей слева. Никакие действия ещё не запущены.</p>');
      main.append(plan);
    }
  } else {
    const summary = document.createElement('p');
    summary.textContent = `Выбрано для запуска: ${ctx.ids.size}. Параметры зафиксированы; повтор — только по кнопке и по подтверждённым результатам.`;
    side.append(summary);
    side.insertAdjacentHTML(
      'beforeend',
      '<p class="muted">«Стоп» прерывает работу. Уже отправленный запрос мог выполниться — неподтверждённые действия не повторяются автоматически.</p>'
    );
    main.append(...children);
  }
  dlg.body.replaceChildren(body);
}
