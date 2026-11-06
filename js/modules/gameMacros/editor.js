import { mountCompositionEditor } from './compositionEditor.js';
import { compileComposition } from './composition.js';
import { openOverlay } from '../marathons/overlay.js';
import { state } from '../../core/state.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { showModal } from '../../core/ui.js';
import { chord, steps, partyMembers, backgroundCompatible } from './model.js';
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
  mirror: 'Повтор клавиатуры — вкл / выкл',
  composite: 'Составная команда: блоки и запись',
  resize: 'Размер игровой области (без Ctrl+F9)',
  pause: 'Пауза / продолжить'
};

export const actionHelp = {
  next: 'Переключает на следующее распознанное окно выбранной пати. В игру ничего не отправляет.',
  previous: 'Переключает на предыдущее окно пати.',
  leader: 'Открывает окно ПЛ, назначенного в настройках пати. Лидерство внутри игры не меняет.',
  sequence:
    'Отправляет выбранным участникам клавиши и паузы по порядку. Например: SHIFT+1, затем wait 100, затем F7 — каждый шаг с новой строки.',
  layout: 'Возвращает окна в сохранённые позиции и размеры. Сначала сохраните профиль размещения в основном разделе.',
  click: 'Один левый клик по вашей экранной точке. Нужны калибровка, разрешение клика и предпросмотр в текущем сеансе.',
  follow:
    'Shift+1, затем правая кнопка по портрету и левая по пункту Follow. Требует две сохранённые точки и предпросмотр.',
  f6f1: 'Сначала отправляет F6 всем, кроме ПЛ. Затем F1 всей пати, включая ПЛ.',
  optimize: 'Применяет размеры из раздела F11. Остальным участникам также отправляет Ctrl+F9.',
  launch: 'Запускает выбранную пати через обычную очередь запуска Твинофермы.',
  mirror:
    'Переключатель непрерывного повтора клавиатуры: только из распознанного активного игрового окна во все остальные распознанные клиенты. Мышь не копируется. Shift/Ctrl/Alt — экспериментальные оконные сообщения. Ввод в других приложениях не передаётся. Текст в игровом чате тоже повторяется: не вводите пароли в игре при включённом режиме. Alt+Tab/Alt+F4/Win и назначенные горячие команды исключены. Аварийное выключение Ctrl+Alt+Pause работает независимо от настройки хоткеев. Совместимость PW не подтверждена.',
  composite:
    'Блоки с собственными получателями, независимыми паузами и совместным планированием. Можно вставлять существующие команды, точки, профили, запуск пати. Запись доступна только внутри выделенной области редактора.',
  resize: 'Только изменение ширины и высоты игровой области выбранных окон. Нажатия Ctrl+F9 сюда не включены.',
  pause: 'Останавливает остаток команды и запрещает новые запуски до повторного нажатия.'
};
export function insertKeyToken(input, token) {
  if (input.name === 'hotkey') {
    const parts = input.value.toUpperCase().split('+'),
      mods = new Set(parts.filter(p => ['CTRL', 'ALT', 'SHIFT'].includes(p)));
    let key = parts.find(p => p && !['CTRL', 'ALT', 'SHIFT'].includes(p)) || '';
    if (['CTRL', 'ALT', 'SHIFT'].includes(token)) {
      if (mods.has(token)) mods.delete(token);
      else mods.add(token);
    } else key = token;
    input.value = [...['CTRL', 'ALT', 'SHIFT'].filter(p => mods.has(p)), key].join('+');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const start = input.selectionStart ?? input.value.length,
    end = input.selectionEnd ?? start;
  const lineStart = input.value.lastIndexOf('\n', start - 1) + 1;
  const nextBreak = input.value.indexOf('\n', start),
    lineEnd = nextBreak < 0 ? input.value.length : nextBreak;
  const line = input.value.slice(lineStart, lineEnd).trim();
  if (token === 'newline') input.setRangeText('\n', lineEnd, lineEnd, 'end');
  else if (token === 'wait 100') {
    if (!line || /^wait\s/i.test(line)) input.setRangeText('wait 100', lineStart, lineEnd, 'end');
    else input.setRangeText('\nwait 100', lineEnd, lineEnd, 'end');
  } else if (start !== end) input.setRangeText(token, start, end, 'end');
  else if (/^wait\s/i.test(line))
    input.setRangeText(
      '\n' + (['CTRL', 'ALT', 'SHIFT'].includes(token) ? token + '+' : token),
      lineEnd,
      lineEnd,
      'end'
    );
  else {
    const parts = line.toUpperCase().split('+'),
      mods = new Set(parts.filter(p => ['CTRL', 'ALT', 'SHIFT'].includes(p)));
    let key = parts.find(p => p && !['CTRL', 'ALT', 'SHIFT'].includes(p)) || '';
    if (['CTRL', 'ALT', 'SHIFT'].includes(token)) {
      if (mods.has(token)) mods.delete(token);
      else mods.add(token);
    } else key = token;
    input.setRangeText(
      [...['CTRL', 'ALT', 'SHIFT'].filter(p => mods.has(p)), key].join('+'),
      lineStart,
      lineEnd,
      'end'
    );
  }
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function openCommandEditor(c, save, row = null) {
  let builder;
  showModal({
    onClose: () => builder?.dispose(),
    title: row ? 'Изменить команду' : 'Создать команду',
    wide: true,
    content: `<div class="gm-dialog"><form data-gm-form><input type="hidden" name="id"><label>Название <input class="input" name="name" maxlength="80" required></label><div class="gm-action-picker"><fieldset class="gm-action-choices"><legend>Что делает команда</legend>${Object.entries(
      commandLabels
    )
      .filter(([key]) => row || !['follow', 'f6f1', 'optimize'].includes(key))
      .map(
        ([key, value]) =>
          `<label class="gm-choice"><input type="radio" name="action" value="${key}"><span>${esc(value)}</span></label>`
      )
      .join(
        ''
      )}</fieldset><aside data-gm-action-help aria-live="polite"></aside></div><label>Сочетание для запуска <input class="input" name="hotkey" placeholder="CTRL+ALT+F8"></label><label>Доставка клавиш<select name="delivery"><option value="foreground">Обычная — с переключением окна (ускорена)</option><option value="background">Без переключения — оконные сообщения (эксперимент)</option></select><small>Фон: клавиши и сочетания в последовательности либо F6→F1; Shift/Ctrl/Alt также экспериментальны. Игра может игнорировать сообщения. Нет автоперехода к переключению окон, результат в игре не подтверждается. Не используйте для расходных действий без проверки.</small></label><label data-gm-scope-field>Область команды <select name="scope"><option value="party">Управляющая пати</option><option value="managed">Все распознанные запущенные окна</option></select><small>«Управляющая пати» — участники пати, выбранной в основном разделе. «Все распознанные окна» — все проверенные клиенты, даже из других пати; это нужно, например, для общего реса. Неизвестное окно блокирует общий запуск, а не выбирается наугад.</small></label><fieldset class="gm-choice-grid" data-gm-targets><legend>Кому отправлять</legend>${[
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
wait 200</textarea></label><p class="muted" data-gm-sequence-field>Кнопки клавиш меняют текущий шаг; «↵ Новая строка» добавляет следующий. Пример ассиста: SHIFT+1, wait 100, F7 — каждый шаг на новой строке. Проверьте игровые привязки; назначенный ПЛ не обязательно первый в игровом списке. Не более 20 шагов; бесконечных циклов и скриптов нет. Координатный клик — отдельное действие с калибровкой и разрешением расходов.</p><div data-gm-composition hidden><div data-composition-editor></div><label><input type="checkbox" name="compositeConsent"> Разрешаю клики и возможный расход ресурсов в составной команде; сначала выполню предпросмотр</label></div><label data-gm-launch-field hidden>Пати для этой команды<select class="input" name="partyId"><option value="">Текущая управляющая пати</option>${state.parties.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><div data-gm-resize-field hidden><label>Ширина<input class="input" name="width" type="number" min="160" max="8000" value="2560"></label><label>Высота<input class="input" name="height" type="number" min="160" max="8000" value="1400"></label></div><label data-gm-profile-field hidden>Профиль<select class="input" name="profileId"><option value="">Выбранный в основном разделе</option>${c.profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><div data-gm-pointer-buttons hidden><label>Кнопка мыши<select name="button">${[
      ['left', 'Левая'],
      ['right', 'Правая'],
      ['middle', 'Средняя'],
      ['x1', 'Боковая 1'],
      ['x2', 'Боковая 2']
    ]
      .map(([v, l]) => `<option value="${v}">${l}</option>`)
      .join(
        ''
      )}</select></label><label>Количество<select name="count"><option value="1">Один клик</option><option value="2">Двойной клик</option></select></label></div></form><p data-gm-form-error role="alert" hidden></p></div>`,
    submitText: 'Сохранить команду',
    cancelText: 'Отмена',
    onSubmit: async data => {
      try {
        const value = Object.fromEntries(data);
        if (!String(value.name || '').trim()) throw new Error('Введите название команды.');
        if (value.hotkey && !chord(value.hotkey)) throw new Error('Пример сочетания: CTRL+ALT+F8.');
        if (value.action === 'sequence') steps(value.sequence);
        if (
          value.action === 'resize' &&
          ![value.width, value.height].every(n => Number.isInteger(Number(n)) && Number(n) >= 160 && Number(n) <= 8000)
        )
          throw new Error('Размеры: целые числа 160–8000.');
        if (
          !['mirror', 'composite', 'click', 'layout', 'resize'].includes(value.action) &&
          value.delivery === 'background' &&
          !backgroundCompatible(value)
        )
          throw new Error(
            'Фоновый режим: только последовательность клавиш или F6→F1. Клики, следование, оптимизация и переключение требуют обычного режима.'
          );
        value.sequence = value.action === 'sequence' ? value.sequence : 'F8';
        if (value.action === 'leader') value.target = 'leader';
        if (['f6f1', 'optimize', 'launch', 'pause', 'mirror'].includes(value.action)) value.target = 'all';
        if (['optimize', 'launch'].includes(value.action)) value.scope = 'party';
        if (value.scope === 'managed') value.target = 'all';
        if (value.action === 'mirror') {
          value.scope = 'managed';
          value.delivery = 'background';
        }
        value.charIds = data.getAll('charIds');
        value.pointIds = data.getAll('pointIds');
        value.resourceAllowed =
          value.action === 'composite' ? data.has('compositeConsent') : data.has('resourceAllowed');
        if (value.action === 'composite') value.blocks = builder.read();
        value.count = Number(value.count) || 1;
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
        if (value.action === 'composite') compileComposition(entry, { ...c, commands });
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
    delivery: 'foreground',
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
  form.querySelector('[name="compositeConsent"]').checked = row?.resourceAllowed === true;
  builder = mountCompositionEditor(form.querySelector('[data-composition-editor]'), c, row, {
    cursor: async () => (await import('./runtime.js')).recorderCursor(),
    newPoint: partyId =>
      new Promise(resolve => {
        const overlay = openOverlay({ title: 'Новая именованная точка', onClose: resolve });
        overlay.body.innerHTML = `<label>Название<input class="input" data-new-name maxlength="80"></label><label>Участник управляющей пати<select class="input" data-new-character>${partyMembers(
          state,
          partyId
        )
          .map(char => `<option value="${esc(char.id)}">${esc(char.nick)}</option>`)
          .join(
            ''
          )}</select></label><p>Переместите нативный маркер в нужное место игры. Сохранение не кликает в игру.</p><p data-new-error role="alert"></p>`;
        overlay.foot.innerHTML =
          '<button class="btn primary" data-new-save>Задать точку</button><button class="btn" data-new-cancel>Отмена</button>';
        overlay.foot.querySelector('[data-new-cancel]').onclick = () => overlay.close();
        overlay.foot.querySelector('[data-new-save]').onclick = async () => {
          const button = overlay.foot.querySelector('[data-new-save]');
          button.disabled = true;
          const previous = state.settings.gameMacros;
          try {
            const runtime = await import('./runtime.js');
            await runtime.pickPoint(
              overlay.body.querySelector('[data-new-character]').value,
              overlay.body.querySelector('[data-new-name]').value,
              null,
              partyId
            );
            await (await import('../../core/storage.js')).persist();
            c.points = runtime.config().points;
            overlay.close();
          } catch (error) {
            state.settings.gameMacros = previous;
            overlay.body.querySelector('[data-new-error]').textContent = error.message;
          } finally {
            button.disabled = false;
          }
        };
      })
  });
  form.querySelectorAll('[name="charIds"]').forEach(input => {
    input.checked = !!row?.charIds.includes(input.value);
  });
  form.querySelectorAll('[name="pointIds"]').forEach(input => {
    input.checked = !!row?.pointIds.includes(input.value);
  });
  for (const name of ['hotkey', 'sequence']) {
    const input = form.elements.namedItem(name),
      bar = document.createElement('div');
    bar.className = 'gm-key-tools';
    const tokens =
      name === 'hotkey'
        ? ['SHIFT', 'CTRL', 'ALT', 'F1', 'F7', 'F8']
        : ['SHIFT', 'CTRL', 'ALT', 'F1', 'F7', 'F8', 'wait 100', 'newline'];
    for (const token of tokens) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ghost';
      button.textContent = { SHIFT: 'Shift', CTRL: 'Ctrl', ALT: 'Alt', newline: '↵ Новая строка' }[token] || token;
      button.onclick = () => insertKeyToken(input, token);
      bar.append(button);
    }
    input.after(bar);
  }
  const sync = () => {
    const action = form.elements.namedItem('action').value,
      scope = form.elements.namedItem('scope').value,
      target = form.elements.namedItem('target').value;
    form.querySelector('[data-gm-composition]').hidden = action !== 'composite';
    form.querySelector('[data-gm-resize-field]').hidden = action !== 'resize';
    form.querySelector('[data-gm-launch-field]').hidden = action !== 'launch';
    form.querySelector('[data-gm-profile-field]').hidden = action !== 'layout';
    form.querySelector('[data-gm-pointer-buttons]').hidden = action !== 'click';
    form.querySelector('[name="delivery"]').closest('label').hidden = ['composite', 'mirror'].includes(action);
    form.querySelector('[data-gm-action-help]').textContent = actionHelp[action] || '';
    const fixed =
      ['leader', 'f6f1', 'optimize', 'launch', 'pause', 'mirror', 'composite'].includes(action) || scope === 'managed';
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
    form.querySelector('[data-gm-scope-field]').hidden = [
      'launch',
      'pause',
      'optimize',
      'mirror',
      'composite'
    ].includes(action);
    form.querySelector('[data-gm-subset]').hidden = fixed || target !== 'subset';
  };
  sync();
  form.addEventListener('change', sync);
  form.onsubmit = event => {
    event.preventDefault();
    document.querySelector('#modal-root .modal-footer .primary')?.click();
  };
}
