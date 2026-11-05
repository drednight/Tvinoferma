import { state } from '../../core/state.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { showModal } from '../../core/ui.js';
import { chord, steps, partyMembers } from './model.js';
export const commandLabels = {
  next: 'Следующее окно',
  previous: 'Предыдущее окно',
  leader: 'Перейти к ПЛ',
  sequence: 'Последовательность клавиш',
  layout: 'Применить профиль окон',
  click: 'Клик по откалиброванной точке',
  follow: 'Следование: Shift+1 → ПКМ → Follow',
  f6f1: 'Два прохода: F6 кроме ПЛ → F1 всем',
  optimize: 'Размеры клиентов + Ctrl+F9 остальным',
  launch: 'Штатный запуск пати',
  pause: 'Пауза / продолжить'
};

export function openCommandEditor(c, save, row = null) {
  showModal({
    title: row ? 'Изменить команду' : 'Создать команду',
    wide: true,
    content: `<div class="gm-dialog"><form data-gm-form><input type="hidden" name="id"><label>Название <input class="input" name="name" maxlength="80" required></label><fieldset class="gm-choice-grid gm-action-choices"><legend>Что делает команда</legend>${Object.entries(
      commandLabels
    )
      .map(
        ([key, value], index) =>
          `<label class="gm-choice"><input type="radio" name="action" value="${key}" ${index === 0 ? 'checked' : ''}><span>${esc(value)}</span></label>`
      )
      .join(
        ''
      )}</fieldset><label>Хоткей <input class="input" name="hotkey" placeholder="CTRL+ALT+F8"></label><label data-gm-scope-field>Область команды <select name="scope"><option value="party">Управляющая пати</option><option value="managed">Все распознанные запущенные окна</option></select></label><fieldset class="gm-choice-grid" data-gm-targets><legend>Кому отправлять</legend>${[
      ['all', 'Вся пати'],
      ['leader', 'Только ПЛ'],
      ['others', 'Кроме ПЛ'],
      ['subset', 'Выбрать участников']
    ]
      .map(
        ([key, value], index) =>
          `<label class="gm-choice"><input type="radio" name="target" value="${key}" ${index === 0 ? 'checked' : ''}><span>${value}</span></label>`
      )
      .join('')}</fieldset><fieldset data-gm-subset><legend>Поднабор получателей</legend>${
      partyMembers(state, c.partyId)
        .map(char => `<label><input type="checkbox" name="charIds" value="${esc(char.id)}"> ${esc(char.nick)}</label>`)
        .join('') || '<p class="muted">Сначала выберите пати.</p>'
    }</fieldset><label data-gm-click-field>Точка для клика <select name="pointId"><option value="">Не выбрана</option>${c.points.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.width}×${p.height} · UI ${esc(p.uiScale)}</option>`).join('')}</select></label><fieldset data-gm-variants-field><legend>Дополнительные профили точки для других размеров/DPI</legend><p class="muted">Для реса во всех окнах разного размера откалибруйте одну и ту же кнопку в каждом формате. Автоматического масштабирования нет. Для каждого окна должен подойти ровно один профиль.</p>${c.points.map(p => `<label><input type="checkbox" name="pointIds" value="${esc(p.id)}">${esc(p.name)} · ${p.width}×${p.height} · DPI ${p.dpi}</label>`).join('')}</fieldset><label data-gm-follow-field>Пункт меню Follow <select name="menuPointId"><option value="">Не выбран</option>${c.points.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.width}×${p.height}</option>`).join('')}</select></label><p class="muted" data-gm-follow-field>Основная точка — портрет для ПКМ. Убедитесь, что Shift+1 и этот портрет выбирают именно назначенного ПЛ в игре. Внутриигровое лидерство программа не меняет.</p><label class="gm-consent" data-gm-click-field><input type="checkbox" name="resourceAllowed"> Разрешаю координатный клик, в том числе возможный расход игровых ресурсов; сверил масштаб и расположение UI с профилем</label><label data-gm-sequence-field>Последовательность (один шаг на строку)<textarea class="input" name="sequence" rows="4">F8
wait 200</textarea></label><p class="muted" data-gm-sequence-field>Пример ассиста: SHIFT+1, wait 100, F7 — каждый шаг на новой строке. Проверьте игровые привязки; назначенный ПЛ не обязательно первый в игровом списке. Не более 20 шагов; бесконечных циклов и скриптов нет. Координатный клик — отдельное действие с калибровкой и разрешением расходов.</p></form><p data-gm-form-error role="alert" hidden></p></div>`,
    submitText: 'Сохранить команду',
    cancelText: 'Отмена',
    onSubmit: async data => {
      try {
        const value = Object.fromEntries(data);
        if (!String(value.name || '').trim()) throw new Error('Введите название команды.');
        if (value.hotkey && !chord(value.hotkey)) throw new Error('Пример сочетания: CTRL+ALT+F8.');
        if (value.action === 'sequence') steps(value.sequence);
        value.sequence = value.action === 'sequence' ? value.sequence : 'F8';
        if (value.action === 'leader') value.target = 'leader';
        if (['f6f1', 'optimize', 'launch', 'pause'].includes(value.action)) value.target = 'all';
        if (['optimize', 'launch'].includes(value.action)) value.scope = 'party';
        if (value.scope === 'managed') value.target = 'all';
        value.charIds = data.getAll('charIds');
        value.pointIds = data.getAll('pointIds');
        value.resourceAllowed = data.has('resourceAllowed');
        if (value.target === 'subset' && !value.charIds.length) throw new Error('Отметьте участников команды.');
        if (['click', 'follow'].includes(value.action) && (!value.pointId || !value.resourceAllowed))
          throw new Error('Выберите точку и разрешите координатное действие.');
        if (value.action === 'follow' && !value.menuPointId) throw new Error('Выберите точку пункта Follow.');
        if (!row && c.commands.length >= 64) throw new Error('Не более 64 команд.');
        const entry = { ...value, id: row?.id || crypto.randomUUID() };
        const commands = [...c.commands.filter(item => item.id !== entry.id), entry];
        const keys = commands.filter(item => item.hotkey).map(item => chord(item.hotkey));
        if (new Set(keys).size !== keys.length || keys.includes('CTRL+ALT+PAUSE'))
          throw new Error('Сочетание занято другой командой или остановкой.');
        await save({ commands });
      } catch (error) {
        const box = document.querySelector('[data-gm-form-error]');
        if (box) {
          box.hidden = false;
          box.textContent = error.message || 'Не удалось сохранить команду.';
        }
        return false;
      }
    }
  });
  const form = document.querySelector('#modal-root [data-gm-form]');
  if (!form) return;
  const initial = row || {
    name: '',
    action: 'sequence',
    target: 'all',
    hotkey: '',
    scope: 'party',
    sequence: 'F8',
    pointId: '',
    menuPointId: '',
    resourceAllowed: false
  };
  for (const [key, value] of Object.entries(initial)) {
    const input = form.elements.namedItem(key);
    if (!input || ['charIds', 'pointIds'].includes(key)) continue;
    if (input.type === 'checkbox') input.checked = value === true;
    else input.value = value;
  }
  form.querySelectorAll('[name="charIds"]').forEach(input => {
    input.checked = !!row?.charIds.includes(input.value);
  });
  form.querySelectorAll('[name="pointIds"]').forEach(input => {
    input.checked = !!row?.pointIds.includes(input.value);
  });
  const sync = () => {
    const action = form.elements.namedItem('action').value,
      scope = form.elements.namedItem('scope').value,
      target = form.elements.namedItem('target').value;
    const fixed = ['leader', 'f6f1', 'optimize', 'launch', 'pause'].includes(action) || scope === 'managed';
    form.querySelectorAll('[data-gm-click-field]').forEach(el => {
      el.hidden = !['click', 'follow'].includes(action);
    });
    form.querySelectorAll('[data-gm-sequence-field]').forEach(el => {
      el.hidden = action !== 'sequence';
    });
    form.querySelectorAll('[data-gm-follow-field]').forEach(el => {
      el.hidden = action !== 'follow';
    });
    form.querySelector('[data-gm-targets]').hidden = fixed;
    form.querySelector('[data-gm-variants-field]').hidden = action !== 'click';
    form.querySelector('[data-gm-scope-field]').hidden = ['launch', 'pause', 'optimize'].includes(action);
    form.querySelector('[data-gm-subset]').hidden = fixed || target !== 'subset';
  };
  sync();
  form.addEventListener('change', sync);
  form.onsubmit = event => {
    event.preventDefault();
    document.querySelector('#modal-root .modal-footer .primary')?.click();
  };
}
