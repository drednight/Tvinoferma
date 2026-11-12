import { keyboardButton } from './keyboardPicker.js';
import { readDraft, writeDraft, clearDraft } from './drafts.js';
import { commandFingerprint } from './fingerprint.js';
import { reviewCommand, reviewHtml } from './review.js';
import { BACKGROUND_METHODS, validateActivityCommand } from './background.js';
import { mountCompositionEditor } from './compositionEditor.js';
import { compileComposition } from './composition.js';
import { unifiedCommand, materializeUnifiedCommand } from './unified.js';
import { state } from '../../core/state.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { showModal } from '../../core/ui.js';
import { chord, steps, partyMembers, backgroundCompatible, commandVisible } from './model.js';
export const commandLabels = {
  next: 'Следующее окно',
  previous: 'Предыдущее окно',
  leader: 'Перейти к ПЛ',
  sequence: 'Последовательность клавиш',
  layout: 'Применить профиль окон',
  click: 'Клик по откалиброванной точке',
  follow: 'Следование: клавиши и клики по точкам',
  f6f1: 'Два прохода: F6 кроме ПЛ → F1 всем',
  optimize: 'Размеры клиентов + Ctrl+F9 остальным',
  launch: 'Штатный запуск пати',
  mirror: 'Повтор клавиатуры — вкл / выкл',
  'mouse-mirror': 'Повтор мыши — вкл / выкл',
  composite: 'Команда из шагов',
  resize: 'Размер игровой области',
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
    'Настраиваемые клавиши, затем ЛКМ/ПКМ по двум сохранённым точкам. Старые команды сохраняют Shift+1 → ПКМ → ЛКМ. Нужны разрешение и предпросмотр.',
  f6f1: 'Сначала отправляет F6 всем, кроме ПЛ. Затем F1 всей пати, включая ПЛ.',
  optimize: 'Применяет размеры из раздела F11. Остальным участникам также отправляет Ctrl+F9.',
  launch: 'Запускает выбранную пати через обычную очередь запуска Твинофермы.',
  mirror:
    'Переключатель непрерывного повтора клавиатуры: только из распознанного активного игрового окна во все остальные распознанные клиенты. Мышь не копируется. Shift/Ctrl/Alt — экспериментальные оконные сообщения. Ввод в других приложениях не передаётся. Текст в игровом чате тоже повторяется: не вводите пароли в игре при включённом режиме. Alt+Tab/Alt+F4/Win и назначенные горячие команды исключены. Аварийное выключение Ctrl+Alt+Pause работает независимо от настройки хоткеев. Совместимость PW не подтверждена.',
  'mouse-mirror':
    'Независимый переключатель кнопок мыши из активной игры в остальные распознанные окна. Абсолютные экранные координаты, без масштабирования. Если точка вне получателя, повтор останавливается. Возможен расход ресурсов. Совместимость PW не подтверждена. Ctrl+Alt+Pause выключает оба режима.',
  composite:
    'Все конечные действия собираются из редактируемых шагов. Параметры справа, действия слева; получатели и порядок обхода задаются для блока.',
  resize: 'Изменяет ширину и высоту игровой области выбранных окон. Клавиши в игру не отправляются.',
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
  const unified = !row || row.action !== 'pause';
  if (row && unified) row = unifiedCommand(row, c);
  let builder,
    captureDraft = () => true,
    saved = false,
    allowClose = false,
    initialSnapshot = '',
    editorForm,
    captureNow = () => null;
  const draftId = row?.id || 'new',
    baseFingerprint = row ? commandFingerprint(row) : 'new';
  const beforeUnload = event => {
    if (editorForm?.isConnected && !saved && JSON.stringify(captureNow()) !== initialSnapshot) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  const createdModal = showModal({
    beforeClose: () => {
      if (saved || allowClose || !editorForm?.isConnected || JSON.stringify(captureNow()) === initialSnapshot)
        return true;
      captureDraft();
      const warning = editorForm.querySelector('[data-draft-close-warning]');
      if (warning) {
        warning.hidden = false;
        warning.scrollIntoView?.({ block: 'nearest' });
      }
      return false;
    },
    onClose: () => {
      builder?.dispose();
      window.removeEventListener('beforeunload', beforeUnload);
    },
    title: row ? 'Изменить команду' : 'Создать команду',
    wide: true,
    content: `<div class="gm-dialog"><form data-gm-form><input type="hidden" name="id"><label>Название <input class="input" name="name" maxlength="80" required></label><div class="gm-action-picker" ${unified ? 'hidden' : ''}><fieldset class="gm-action-choices"><legend>Что делает команда</legend>${Object.entries(
      commandLabels
    )
      .filter(([key]) => unified || key === 'pause')
      .map(
        ([key, value]) =>
          `<label class="gm-choice" ${commandVisible({ action: key }) ? '' : 'hidden'}><input type="radio" name="action" value="${key}" ${!unified && key === 'pause' ? 'checked' : ''}><span>${esc(value)}</span></label>`
      )
      .join(
        ''
      )}</fieldset><aside data-gm-action-help aria-live="polite"></aside></div><label>Клавиша или сочетание для запуска (необязательно) <input class="input" name="hotkey" placeholder="F8 или CTRL+ALT+F8"><small>Можно одну клавишу. Назначение глобальное: обычные буквы могут мешать набору текста; предпочтительнее F-клавиши. Занятая Windows клавиша может не зарегистрироваться — смотрите журнал.</small></label><label>Доставка клавиш<select name="delivery"><option value="foreground">Обычная — с переключением окна (ускорена)</option><option value="background">Без переключения — оконные сообщения (эксперимент)</option></select><small>Фон: клавиши и сочетания в последовательности либо F6→F1; Shift/Ctrl/Alt также экспериментальны. Игра может игнорировать сообщения. Нет автоперехода к переключению окон, результат в игре не подтверждается. Не используйте для расходных действий без проверки.</small></label><fieldset data-gm-background-method><legend>Проверка фоновой доставки клавиш</legend><label>Способ<select name="backgroundMethod">${Object.entries(
      BACKGROUND_METHODS
    )
      .map(([v, l]) => `<option value="${v}">${esc(l)}</option>`)
      .join(
        ''
      )}</select></label><label><input type="checkbox" name="hybridConsent"> Разрешаю глобальные Ctrl/Alt/Shift в гибридном режиме из активного ПЛ. Они могут вызвать меню, смену раскладки или другие действия у ПЛ, даже если он не получатель. Все игровые действия проверены и безопасны.</label><small>Гибрид из ПЛ: только отдельная последовательность, до 8 шагов на каждого получателя выбранной пати. Запуск только из активного окна назначенного ПЛ, без Блокнота; фокус не переключается. Без резерва на другие окна, мыши и повтора. ПЛ-получатель получает полное сочетание SendInput, остальные — адресную клавишу с глобальными модификаторами. Фиксировано: gap 50 мс, hold 30 мс, timeout 100 мс, между командами 300 мс. Alt может открыть меню ПЛ; Alt+Shift/Ctrl+Shift — переключить раскладку. Не касайтесь ввода во время команды.</small><small>Уведомления активности + клавиша: отдельная последовательность, например SHIFT+1 и F2 с новой строки, при необходимости wait 200. Модификаторы передаются оконными сообщениями; обработка Shift/Ctrl/Alt игрой пока не подтверждена. Ручной B-тест не открыл инвентарь в двух клиентах PW. Новые способы тоже требуют ручной проверки. Не для мыши, повтора, F6→F1 и составных команд. Если получатели не определились, отправка останавливается без расширения области. Окна должны быть не свёрнуты, удерживаемые клавиши и мышь отпущены. Нет SetFocus/SetForegroundWindow и автоперехода к активации; сам клиент может сменить фокус. При ошибке дальнейшая отправка прекращается. Кнопка ниже создаёт только три прежних варианта, без уведомлений активности.</small></fieldset><fieldset data-gm-timing><legend>Переключение и завершение</legend><label data-gm-return>После команды<select name="returnTo"><option value="leader">Вернуться к ПЛ выбранной пати</option><option value="last">Остаться на последнем окне</option></select></label><label>Задержка после активации, мс<input name="switchMs" type="number" min="0" max="500" value="30"></label><label>Удержание клавиши, мс<input name="holdMs" type="number" min="10" max="200" value="30"></label><small>Уменьшайте только после проверки в игре. Фокус проверяется независимо от задержки. В составной команде возврат выполняется один раз в самом конце к ПЛ явно выбранной пати, а не к ПЛ последнего блока. По умолчанию составная команда остаётся на последнем окне.</small></fieldset><label data-gm-scope-field>Область команды <select name="scope"><option value="party">Управляющая пати</option><option value="managed">Все распознанные запущенные окна</option></select><small>«Управляющая пати» — участники пати, выбранной в основном разделе. «Все распознанные окна» — все проверенные клиенты, даже из других пати; это нужно, например, для общего реса. Нераспознанные окна не получают команду. При ошибке определения выбранных окон отправка останавливается.</small></label><fieldset class="gm-choice-grid" data-gm-targets><legend>Кому отправлять</legend>${[
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
    }</fieldset><label data-gm-click-field>Точка для клика <select name="pointId"><option value="">Не выбрана</option>${c.points.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.width}×${p.height} · UI ${esc(p.uiScale)}</option>`).join('')}</select></label><fieldset data-gm-variants-field><legend>Дополнительные профили точки для других размеров/DPI</legend><p class="muted">Для реса во всех окнах разного размера откалибруйте одну и ту же кнопку в каждом формате. Автоматического масштабирования нет. Для каждого окна должен подойти ровно один профиль.</p>${c.points.map(p => `<label><input type="checkbox" name="pointIds" value="${esc(p.id)}">${esc(p.name)} · ${p.width}×${p.height} · DPI ${p.dpi}</label>`).join('')}</fieldset><label data-gm-follow-field>Пункт меню Follow <select name="menuPointId"><option value="">Не выбран</option>${c.points.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.width}×${p.height}</option>`).join('')}</select></label><fieldset data-gm-follow-field><legend>Действия следования в каждом окне</legend><label>Клавиши перед кликами (можно оставить пустым)<textarea class="input" name="followSequence" rows="3">SHIFT+1</textarea></label><p class="muted">Один шаг на строку: SHIFT+1, F2 или wait 200. После клавиш — клик по основной точке, затем по пункту меню. Точки задаются в координатах игровой области с калибровкой DPI/UI; сначала выполните предпросмотр без кликов.</p><label>Клик по основной точке<select class="input" name="followButton"><option value="right">ПКМ</option><option value="left">ЛКМ</option></select></label><label>Клик по пункту меню<select class="input" name="followMenuButton"><option value="left">ЛКМ</option><option value="right">ПКМ</option></select></label><p class="muted">Проверьте, что клавиши и точки выбирают назначенного ПЛ. Внутриигровое лидерство программа не меняет. Для разных действий у отдельных персонажей используйте блоки составной команды с поднаборами.</p></fieldset><label class="gm-consent" data-gm-click-field><input type="checkbox" name="resourceAllowed"> Разрешаю координатный клик, в том числе возможный расход игровых ресурсов; сверил масштаб и расположение UI с профилем</label><label data-gm-sequence-field>Последовательность (один шаг на строку)<textarea class="input" name="sequence" rows="4">F8
wait 200</textarea></label><p class="muted" data-gm-sequence-field>Кнопки клавиш меняют текущий шаг; «↵ Новая строка» добавляет следующий. Пример ассиста: SHIFT+1, wait 100, F7 — каждый шаг на новой строке. Проверьте игровые привязки; назначенный ПЛ не обязательно первый в игровом списке. Не более 20 шагов; бесконечных циклов и скриптов нет. Координатный клик — отдельное действие с калибровкой и разрешением расходов.</p><p data-gm-sequence-field><button type="button" class="btn ghost" data-gm-to-composition>＋ Добавить готовую команду в последовательность</button><small>Откроет составную последовательность. Текущие клавиши и паузы будут сохранены первым блоком; затем добавьте сохранённую команду.</small></p><div data-gm-composition hidden><div data-composition-editor></div><label><input type="checkbox" name="compositeConsent"> Разрешаю клики и возможный расход ресурсов в составной команде; сначала выполню предпросмотр</label></div><label data-gm-launch-field hidden>Пати для этой команды<select class="input" name="partyId"><option value="">Текущая управляющая пати</option>${state.parties.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><div data-gm-resize-field hidden><label>Ширина<input class="input" name="width" type="number" min="160" max="8000" value="2560"></label><label>Высота<input class="input" name="height" type="number" min="160" max="8000" value="1400"></label></div><label data-gm-profile-field hidden>Профиль<select class="input" name="profileId"><option value="">Выбранный в основном разделе</option>${c.profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><div data-gm-pointer-buttons hidden><label>Кнопка мыши<select name="button">${[
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
        value.hybridConsent = data.has('hybridConsent');
        if (data.get('commandInputMode') === 'hybrid-party') {
          const blocks = builder.read();
          const block = blocks[0];
          if (
            blocks.length !== 1 ||
            block.parallel ||
            block.repeat !== 1 ||
            block.steps.some(s => !['keys', 'wait'].includes(s.type))
          )
            throw new Error('Гибрид из ПЛ: нужен один блок выбранной пати, только клавиши и паузы, без повторов.');
          Object.assign(value, {
            action: 'sequence',
            delivery: 'background',
            backgroundMethod: 'hybrid-party',
            scope: 'party',
            target: block.target,
            partyId: block.scope === 'party' ? block.partyId : '',
            charIds: block.charIds,
            sequence: block.steps.map(s => (s.type === 'wait' ? `wait ${s.ms}` : s.value)).join('\n')
          });
        }
        value.strictTargets = row?.strictTargets === true;
        value.needsConfiguration = false;
        if (value.action === 'follow' && String(value.followSequence || '').trim()) steps(value.followSequence);
        if (!String(value.name || '').trim()) throw new Error('Введите название команды.');
        if (
          !Number.isInteger(Number(value.switchMs)) ||
          Number(value.switchMs) < 0 ||
          Number(value.switchMs) > 500 ||
          !Number.isInteger(Number(value.holdMs)) ||
          Number(value.holdMs) < 10 ||
          Number(value.holdMs) > 200
        )
          throw new Error('Задержка переключения: 0–500 мс; удержание клавиши: 10–200 мс. Только целые числа.');
        if (value.hotkey && !chord(value.hotkey)) throw new Error('Пример сочетания: CTRL+ALT+F8.');
        if (value.action === 'sequence') steps(value.sequence);
        if (value.action !== 'composite') validateActivityCommand(value);
        if (
          value.action === 'resize' &&
          ![value.width, value.height].every(n => Number.isInteger(Number(n)) && Number(n) >= 160 && Number(n) <= 8000)
        )
          throw new Error('Размеры: целые числа 160–8000.');
        if (
          !['mirror', 'mouse-mirror', 'composite', 'click', 'layout', 'resize'].includes(value.action) &&
          value.delivery === 'background' &&
          !backgroundCompatible(value)
        )
          throw new Error(
            'Фоновый режим: только последовательность клавиш или F6→F1. Клики, следование, оптимизация и переключение требуют обычного режима.'
          );
        value.sequence = value.action === 'sequence' ? value.sequence : 'F8';
        if (value.action === 'leader') value.target = 'leader';
        if (['f6f1', 'optimize', 'launch', 'pause', 'mirror', 'mouse-mirror'].includes(value.action))
          value.target = 'all';
        if (['optimize', 'launch'].includes(value.action)) value.scope = 'party';
        if (value.scope === 'managed') value.target = 'all';
        if (value.action === 'mirror') {
          value.scope = 'managed';
          value.delivery = 'background';
        }
        if (data.get('commandInputMode') !== 'hybrid-party') value.charIds = data.getAll('charIds');
        value.pointIds = data.getAll('pointIds');
        value.resourceAllowed =
          value.action === 'composite' ? data.has('compositeConsent') : data.has('resourceAllowed');
        if (value.action === 'composite') {
          value.blocks = builder.read().map(block => {
            const result = block.backgroundMethod === 'hybrid-party' ? { ...block, backgroundMethod: 'post' } : block;
            return data.get('commandInputMode') === 'standard' ? { ...result, delivery: 'foreground' } : result;
          });
          value.target = 'all';
          value.charIds = [];
        }
        value.count = Number(value.count) || 1;
        if (value.target === 'subset' && !value.charIds.length) throw new Error('Отметьте участников команды.');
        if (['click', 'follow'].includes(value.action) && (!value.pointId || !value.resourceAllowed))
          throw new Error('Выберите точку и разрешите координатное действие.');
        if (value.action === 'follow' && !value.menuPointId) throw new Error('Выберите точку пункта Follow.');
        if (!row && c.commands.length >= 64) throw new Error('Не более 64 команд.');
        const entry = materializeUnifiedCommand({
          ...value,
          ...(value.action === 'composite' ? { delivery: 'foreground', backgroundMethod: 'post' } : {}),
          id: row?.id || crypto.randomUUID()
        });
        validateActivityCommand(entry);
        const commands = [...c.commands.filter(item => item.id !== entry.id), entry];
        const keys = commands.filter(item => item.hotkey).map(item => chord(item.hotkey));
        if (new Set(keys).size !== keys.length || keys.includes('CTRL+ALT+PAUSE'))
          throw new Error('Сочетание занято другой командой или остановкой.');
        if (entry.action === 'composite') compileComposition(entry, { ...c, commands });
        await save({ commands });
        saved = true;
        clearDraft(draftId);
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
  if (!createdModal) return;
  const form = createdModal.querySelector('[data-gm-form]');
  if (!form) return;
  const initial = row || {
    name: '',
    action: 'composite',
    target: 'all',
    hotkey: '',
    scope: 'party',
    returnTo: 'last',
    switchMs: 30,
    holdMs: 30,
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
  form.elements.namedItem('followSequence').value = row?.followSequence ?? 'SHIFT+1';
  form.elements.namedItem('followButton').value = row?.followButton || 'right';
  form.elements.namedItem('followMenuButton').value = row?.followMenuButton || 'left';
  builder = mountCompositionEditor(form.querySelector('[data-composition-editor]'), c, row);
  form.addEventListener('gm-template-picked', event => {
    const name = form.elements.namedItem('name');
    if (!row && !name.value.trim()) {
      name.value = event.detail.name;
      name.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  form.querySelectorAll('[name="charIds"]').forEach(input => {
    input.checked = !!row?.charIds?.includes(input.value);
  });
  form.querySelectorAll('[name="pointIds"]').forEach(input => {
    input.checked = !!row?.pointIds?.includes(input.value);
  });
  for (const name of ['hotkey', 'sequence', 'followSequence']) {
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
    bar.append(
      keyboardButton(input, token => {
        if (name === 'hotkey') input.value = token;
        else {
          const start = input.value.lastIndexOf('\n', (input.selectionStart ?? input.value.length) - 1) + 1;
          const next = input.value.indexOf('\n', input.selectionStart ?? input.value.length);
          input.setRangeText(token, start, next < 0 ? input.value.length : next, 'end');
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })
    );
    input.after(bar);
  }
  form.querySelector('[data-gm-to-composition]').onclick = () => {
    const errorBox = document.querySelector('[data-gm-form-error]');
    try {
      const keys = steps(form.elements.namedItem('sequence').value);
      const block = {
        name: 'Текущая последовательность',
        scope: form.elements.namedItem('scope').value,
        target: form.elements.namedItem('target').value,
        partyId: row?.partyId || c.partyId,
        charIds: [...form.querySelectorAll('[name="charIds"]:checked')].map(input => input.value),
        delivery: form.elements.namedItem('delivery').value,
        backgroundMethod: form.elements.namedItem('backgroundMethod').value,
        steps: keys.map(step => (step.wait ? { type: 'wait', ms: step.wait } : { type: 'keys', value: step.key }))
      };
      builder.setBlocks([block]);
      const radio = form.querySelector('[name="action"][value="composite"]');
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || 'Не удалось преобразовать последовательность.';
    }
  };
  const sync = () => {
    const action = form.elements.namedItem('action').value,
      scope = form.elements.namedItem('scope').value,
      target = form.elements.namedItem('target').value;
    form.querySelector('[data-gm-background-method]').hidden =
      form.elements.namedItem('delivery').value !== 'background' || !['sequence', 'f6f1'].includes(action);
    form.querySelector('[data-gm-composition]').hidden = action !== 'composite';
    form.querySelector('[data-gm-resize-field]').hidden = action !== 'resize';
    form.querySelector('[data-gm-launch-field]').hidden = action !== 'launch';
    form.querySelector('[data-gm-return]').hidden = ['next', 'previous', 'leader'].includes(action);
    form.querySelector('[data-gm-timing]').hidden =
      ['mirror', 'mouse-mirror', 'pause', 'launch'].includes(action) ||
      form.elements.namedItem('commandInputMode')?.value === 'hybrid-party';
    form.querySelector('[data-gm-profile-field]').hidden = action !== 'layout';
    form.querySelector('[data-gm-pointer-buttons]').hidden = action !== 'click';
    form.querySelector('[name="delivery"]').closest('label').hidden = ['composite', 'mirror', 'mouse-mirror'].includes(
      action
    );
    form.querySelector('[data-gm-action-help]').textContent = actionHelp[action] || '';
    const fixed =
      ['leader', 'f6f1', 'optimize', 'launch', 'pause', 'mirror', 'mouse-mirror', 'composite'].includes(action) ||
      scope === 'managed';
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
      'mouse-mirror',
      'composite'
    ].includes(action);
    form.querySelector('[data-gm-subset]').hidden = fixed || target !== 'subset';
  };
  sync();
  if (unified) {
    const intro = document.createElement('div');
    intro.className = 'gm-editor-intro';
    intro.innerHTML = '<span>1 · Название</span><span>2 · Действия</span><span>3 · Сохранить</span>';
    form.prepend(intro);
    const basics = document.createElement('div');
    basics.className = 'gm-editor-basics';
    intro.after(basics);
    for (const name of ['name', 'hotkey']) basics.append(form.elements.namedItem(name).closest('label'));
    const mode = document.createElement('label');
    mode.className = 'gm-command-mode';
    const legacyBackground =
      row?.backgroundMethod !== 'hybrid-party' && row?.blocks?.some(block => block.delivery === 'background');
    mode.innerHTML = `<span>Режим команды</span><select name="commandInputMode"><option value="standard">Активный — с переключением окон</option><option value="hybrid-party" ${row?.backgroundMethod === 'hybrid-party' ? 'selected' : ''}>Фоновый (гибридный) — из активного ПЛ</option>${legacyBackground ? '<option value="legacy" selected>Прежняя фоновая доставка (сохранённая команда)</option>' : ''}</select><small>Активный режим переключает окна. Гибридный не переключает окна, но требует активного ПЛ выбранной пати, выключенного повтора и явного согласия ниже. Только один блок клавиш и пауз, до 8 шагов для выбранных получателей. Из общего выбора используются только участники выбранной пати; ограничения группы сохраняются.</small>`;
    basics.append(mode);
    const hybridConsentLabel = form.elements.namedItem('hybridConsent').closest('label');
    hybridConsentLabel.classList.add('gm-hybrid-consent');
    basics.append(hybridConsentLabel);
    const refreshHybridConsent = () => {
      const selectedMode = mode.querySelector('select').value;
      hybridConsentLabel.hidden = selectedMode !== 'hybrid-party';
      form.querySelector('[data-composition-editor]').dataset.commandMode = selectedMode;
      sync();
    };
    mode.addEventListener('change', refreshHybridConsent);
    refreshHybridConsent();
    const advanced = document.createElement('section');
    advanced.className = 'gm-editor-advanced';
    advanced.innerHTML = '<h4>Выполнение команды</h4><p>Время переключения и поведение после завершения.</p>';
    for (const selector of ['[data-gm-timing]', '[data-gm-launch-field]']) {
      const field = form.querySelector(selector);
      if (field) advanced.append(field);
    }
    form.append(advanced);
    const refreshConsent = () => {
      form.querySelector('[name="compositeConsent"]').closest('label').hidden =
        !row?.resourceAllowed &&
        !form.querySelector('[data-step-type="point"],[data-step-type="screen"],[data-step-type="command"]');
    };
    form.addEventListener('click', refreshConsent);
    form.addEventListener('change', refreshConsent);
    refreshConsent();
  }
  form.addEventListener('change', event => {
    if (event.target.name === 'action' && !row)
      form.elements.namedItem('returnTo').value = ['sequence', 'follow', 'click', 'f6f1', 'optimize'].includes(
        event.target.value
      )
        ? 'leader'
        : 'last';
    sync();
  });
  editorForm = form;
  const status = document.createElement('p');
  status.className = 'gm-draft-status';
  status.setAttribute('role', 'status');
  form.prepend(status);
  const restore = readDraft(draftId);
  const capture = () => ({
    fields: [...new FormData(form).entries()],
    blocks: builder.snapshot()
  });
  captureNow = capture;
  captureDraft = () => {
    const value = capture();
    if (!saved) {
      const ok = writeDraft(draftId, value.fields, value.blocks, baseFingerprint);
      status.textContent = ok
        ? 'Черновик сохранён на этом устройстве.'
        : 'Не удалось сохранить черновик; не закрывайте окно до сохранения команды.';
    }
    return value;
  };
  initialSnapshot = JSON.stringify(capture());
  if (restore) {
    const banner = document.createElement('div');
    banner.className = 'gm-draft-banner';
    banner.innerHTML = `<p>${restore.baseFingerprint === baseFingerprint ? 'Есть несохранённый черновик.' : 'Есть черновик другой версии команды; проверьте изменения перед сохранением.'}</p><button type="button" class="btn" data-draft-restore>Восстановить черновик</button><button type="button" class="btn ghost" data-draft-discard>Удалить черновик</button>`;
    form.prepend(banner);
    banner.querySelector('[data-draft-restore]').onclick = () => {
      for (const input of form.querySelectorAll('input[type="checkbox"]')) input.checked = false;
      for (const [name, value] of restore.fields) {
        const inputs = [...form.querySelectorAll('[name]')].filter(input => input.name === name);
        for (const input of inputs) {
          if (input.type === 'radio' || input.type === 'checkbox')
            input.checked = restore.fields.some(([field, selected]) => field === name && selected === input.value);
          else input.value = value;
        }
      }
      builder.restoreBlocks(restore.blocks);
      banner.remove();
      sync();
      form.querySelector('[name="commandInputMode"]')?.dispatchEvent(new Event('change', { bubbles: true }));
      refreshChecks();
      captureDraft();
    };
    banner.querySelector('[data-draft-discard]').onclick = () => {
      clearDraft(draftId);
      banner.remove();
    };
  }
  const closeWarning = document.createElement('div');
  closeWarning.className = 'gm-draft-warning';
  closeWarning.dataset.draftCloseWarning = '';
  closeWarning.hidden = true;
  closeWarning.innerHTML =
    '<p>Есть несохранённые изменения. Можно продолжить редактирование или закрыть окно. Черновик остаётся на этом устройстве, если сохранение выше успешно.</p><button type="button" class="btn" data-draft-continue>Продолжить редактирование</button><button type="button" class="btn ghost" data-draft-close>Закрыть без сохранения команды</button>';
  form.prepend(closeWarning);
  closeWarning.querySelector('[data-draft-continue]').onclick = () => {
    closeWarning.hidden = true;
  };
  closeWarning.querySelector('[data-draft-close]').onclick = async () => {
    allowClose = true;
    (await import('../../core/ui.js')).closeModal();
  };
  const checks = document.createElement('details');
  checks.className = 'gm-editor-checks';
  checks.innerHTML = '<summary>Проверка и полный план — без запуска</summary><div data-editor-review></div>';
  form.append(checks);
  const refreshChecks = () => {
    const values = Object.fromEntries(new FormData(form));
    const draft = {
      ...row,
      ...values,
      id: row?.id || 'editor-new',
      action: values.action,
      blocks: builder.snapshot(),
      resourceAllowed: form.querySelector('[name="compositeConsent"]').checked,
      delivery: values.action === 'composite' ? 'foreground' : values.delivery,
      needsConfiguration: false
    };
    const hybrid = values.commandInputMode === 'hybrid-party';
    const blocks = draft.blocks;
    if (hybrid && blocks.length === 1) {
      const block = blocks[0];
      Object.assign(draft, {
        action: 'sequence',
        scope: 'party',
        partyId: block.scope === 'party' ? block.partyId : '',
        target: block.target,
        charIds: block.charIds,
        delivery: 'background',
        backgroundMethod: 'hybrid-party',
        hybridConsent: form.elements.namedItem('hybridConsent').checked,
        sequence: block.steps.map(step => (step.type === 'wait' ? `wait ${step.ms}` : step.value || '')).join('\n')
      });
    } else if (values.commandInputMode === 'standard' && draft.action === 'composite') {
      draft.blocks = blocks.map(block => ({ ...block, delivery: 'foreground' }));
    }
    const report = reviewCommand(draft, c, state);
    if (
      hybrid &&
      (blocks.length !== 1 ||
        blocks[0].parallel ||
        blocks[0].repeat !== 1 ||
        blocks[0].steps.some(step => !['keys', 'wait'].includes(step.type)))
    )
      report.issues.push({
        severity: 'error',
        field: 'blocks',
        message: 'Гибрид: один блок клавиш и пауз, без повторов и параллельности.'
      });
    checks.querySelector('[data-editor-review]').innerHTML = reviewHtml(report);
    for (const node of form.querySelectorAll('[data-field-check]')) node.remove();
    for (const node of form.querySelectorAll('[aria-invalid]')) node.removeAttribute('aria-invalid');
    for (const issue of report.issues.filter(item => item.severity === 'error')) {
      let input = issue.field === 'name' || issue.field === 'hotkey' ? form.elements.namedItem(issue.field) : null;
      const match = issue.field.match(/^block:(\d+):(target|partyId)$/);
      if (match) input = form.querySelector(`[data-block="${match[1]}"] [data-field="${match[2]}"]`);
      const step = issue.field.match(/^block:(\d+):step:(\d+)$/);
      if (step) input = form.querySelector(`[data-block="${step[1]}"] [data-step="${step[2]}"]`);
      if (input) {
        const text = document.createElement('small');
        text.dataset.fieldCheck = '';
        text.className = 'gm-review-error';
        text.textContent = issue.message;
        input.setAttribute('aria-invalid', 'true');
        input.after(text);
      }
    }
  };
  let pending = false;
  const changed = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (form.isConnected && !saved) {
        refreshChecks();
        if (JSON.stringify(capture()) !== initialSnapshot) captureDraft();
      }
    });
  };
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  form.addEventListener('click', changed);
  window.addEventListener('beforeunload', beforeUnload);
  refreshChecks();
  form.onsubmit = event => {
    event.preventDefault();
    document.querySelector('#modal-root .modal-footer .primary')?.click();
  };
}
