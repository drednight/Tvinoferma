import { keyboardButton } from './keyboardPicker.js';
import { quickKeysHtml, applyQuickModifier } from './quickKeys.js';
import { isActivityMethod } from './background.js';
import { BACKGROUND_METHODS } from './background.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import { partyMembers, commandVisible } from './model.js';
import { STEP_LABELS, normalizeComposition } from './composition.js';
import { commandBlocks } from './unified.js';
export function mountCompositionEditor(host, c, row) {
  let blocks = row?.blocks?.length
    ? structuredClone(row.blocks).map(block => ({ charIds: [], ...block }))
    : [newBlock()];
  const selected = new Map();
  const collapsed = new Set();
  const undo = [];
  const canAdd = (b, count = 1) => {
    if (blocks[b].steps.length + count <= 64 && blocks.reduce((n, block) => n + block.steps.length, 0) + count <= 128)
      return true;
    host.querySelector('[data-compose-error]').textContent = 'Лимит: 64 действия в блоке и 128 в команде.';
    return false;
  };
  const remember = () => {
    undo.push(structuredClone(blocks));
    if (undo.length > 20) undo.shift();
  };
  const summary = step => {
    switch (step.type) {
      case 'keys':
        return step.value || 'Выберите клавишу';
      case 'repeat':
        return `${step.device === 'mouse' ? 'Мышь' : 'Клавиатура'} · ${{ on: 'включить', off: 'выключить', toggle: 'переключить' }[step.mode] || 'выберите действие'}`;
      case 'wait':
        return `${step.ms || 0} мс`;
      case 'point':
        return c.points.find(p => p.id === step.pointId)?.name || 'Выберите точку';
      case 'command':
        return c.commands.find(cmd => cmd.id === step.commandId)?.name || 'Выберите команду';
      case 'screen':
        return `${step.x}, ${step.y} · ${step.count === 2 ? 'двойной клик' : 'клик'}`;
      case 'launch':
        return state.parties.find(p => p.id === step.partyId)?.name || 'Выберите пати';
      case 'focus':
        return { next: 'Следующее', previous: 'Предыдущее', leader: 'ПЛ' }[step.direction] || 'ПЛ';
      default:
        return STEP_LABELS[step.type];
    }
  };
  function newBlock(index = 1) {
    return {
      name: `Блок ${index}`,
      parallel: false,
      repeat: 1,
      leaderSplit: false,
      scope: 'managed',
      partyId: '',
      target: 'all',
      charIds: [],
      delivery: 'foreground',
      backgroundMethod: 'activity-notify',
      steps: []
    };
  }
  const option = (v, label, chosen, hidden = false) =>
    `<option ${hidden ? 'hidden' : ''} value="${esc(v)}" ${v === chosen ? 'selected' : ''}>${esc(label)}</option>`;
  const select = (field, values, value) =>
    `<select class="input" data-field="${field}">${values.map(([v, l]) => option(v, l, value, field === 'commandId' && c.commands.some(cmd => cmd.id === v && !commandVisible(cmd)))).join('')}</select>`;
  const input = (field, value, type = 'text') =>
    `<input class="input" data-field="${field}" type="${type}" value="${esc(value ?? '')}">`;
  const recipients = block => {
    if (host.dataset.commandMode !== 'hybrid-party')
      return block.scope === 'managed' ? state.characters : partyMembers(state, block.partyId || c.partyId);
    const members = partyMembers(state, block.scope === 'party' ? block.partyId || c.partyId : c.partyId);
    // Keep previously selected outsiders visible so they can be unchecked without data loss.
    return [
      ...members,
      ...state.characters.filter(char => block.charIds.includes(char.id) && !members.some(m => m.id === char.id))
    ];
  };
  const parties = () => [['', 'Текущая управляющая пати'], ...state.parties.map(p => [p.id, p.name])];
  function fields(step) {
    switch (step.type) {
      case 'keys':
        return `<label>Клавиша ${input('value', step.value)}${quickKeysHtml()}</label><small>Например SHIFT+1, CTRL+F2 или F8. Сочетание задаётся здесь, без отдельного окна ввода.</small>`;
      case 'wait':
        return `<label>Задержка, мс ${input('ms', step.ms, 'number')}${host.dataset.commandMode === 'hybrid-party' ? '<small>Для гибрида: от 50 до 3000 мс.</small>' : ''}</label>`;
      case 'command':
        return `<label>Команда ${select(
          'commandId',
          [
            ['', 'Выберите команду'],
            ...c.commands
              .filter(cmd => cmd.id !== row?.id && !['mirror', 'mouse-mirror', 'pause'].includes(cmd.action))
              .map(cmd => [cmd.id, cmd.name])
          ],
          step.commandId
        )}</label><small>Ссылка: изменения исходной команды применяются здесь. Рекурсивные ссылки запрещены; повторения задаются для блока.</small>`;
      case 'point':
        return `${clickSource(step)}<label>Точка ${select('pointId', [['', 'Выбрать точку'], ...c.points.map(p => [p.id, p.name])], step.pointId)}</label>${step.pointIds?.length ? '<small>Для этого сохранённого действия также используются ранее выбранные дополнительные точки. Чтобы убрать их, удалите действие и добавьте его заново.</small>' : ''}${mouse(step)}`;
      case 'screen':
        return `${clickSource(step)}<label>Экран X ${input('x', step.x, 'number')}</label><label>Экран Y ${input('y', step.y, 'number')}</label>${mouse(step)}`;
      case 'repeat':
        return `<label>Повтор ${select(
          'device',
          [
            ['keyboard', 'Клавиатура'],
            ['mouse', 'Мышь']
          ],
          step.device
        )}</label><label>Действие ${select(
          'mode',
          [
            ['on', 'Включить'],
            ['off', 'Выключить'],
            ['toggle', 'Переключить']
          ],
          step.mode
        )}</label><small>Это явное управление режимом: он остаётся включённым после команды до выключения пользователем или защитной остановки. Не использует эксперимент активности.</small>`;
      case 'profile':
        return `<label>Профиль ${select('profileId', [['', 'Выбрать профиль'], ...c.profiles.map(p => [p.id, p.name])], step.profileId)}</label>`;
      case 'resize':
        return `<label>Ширина ${input('width', step.width, 'number')}</label><label>Высота ${input('height', step.height, 'number')}</label>`;
      case 'launch':
        return `<label>Пати ${select('partyId', [['', 'Выбрать пати'], ...state.parties.map(p => [p.id, p.name])], step.partyId)}</label>`;
      case 'focus':
        return select(
          'direction',
          [
            ['next', 'Следующее окно'],
            ['previous', 'Предыдущее окно'],
            ['leader', 'ПЛ']
          ],
          step.direction
        );
      default:
        return '<small>Ожидает команды «Пауза / продолжить». Остановка отменяет весь план.</small>';
    }
  }
  function clickSource(step) {
    return `<label>Координаты<select class="input" data-click-source><option value="screen" ${step.type === 'screen' ? 'selected' : ''}>Свои — экранные X/Y</option><option value="point" ${step.type === 'point' ? 'selected' : ''}>Сохранённый шаблон точки</option></select></label>`;
  }
  function mouse(step) {
    return `<label>Кнопка ${select(
      'button',
      [
        ['left', 'Левая'],
        ['right', 'Правая'],
        ['middle', 'Средняя'],
        ['x1', 'Боковая 1'],
        ['x2', 'Боковая 2']
      ],
      step.button
    )}</label><label>Модификаторы ${select(
      'modifiers',
      [
        ['', 'Без'],
        ['CTRL', 'Ctrl'],
        ['SHIFT', 'Shift'],
        ['ALT', 'Alt'],
        ['CTRL+SHIFT', 'Ctrl+Shift'],
        ['CTRL+ALT', 'Ctrl+Alt'],
        ['ALT+SHIFT', 'Alt+Shift'],
        ['CTRL+ALT+SHIFT', 'Ctrl+Alt+Shift']
      ],
      ['CTRL', 'ALT', 'SHIFT'].filter(v => step.modifiers?.includes(v)).join('+')
    )}</label><label>Клики ${select(
      'count',
      [
        [1, 'Один'],
        [2, 'Двойной']
      ],
      Number(step.count)
    )}</label>`;
  }
  function blank(type) {
    return (
      {
        keys: { type, value: '' },
        wait: { type, ms: 100 },
        command: { type, commandId: '' },
        point: { type, pointId: '', button: 'left', count: 1 },
        screen: { type, x: 0, y: 0, button: 'left', count: 1 },
        resize: { type, width: 2560, height: 1400 },
        repeat: { type, device: 'keyboard', mode: 'on' },
        focus: { type, direction: 'leader' }
      }[type] || { type, partyId: '', profileId: '' }
    );
  }
  function draw() {
    host.innerHTML = `<div class="gm-compose-title"><h4>Что выполнить</h4><button type="button" class="btn ghost small" data-undo ${undo.length ? '' : 'disabled'}>↶ Отменить изменение</button></div><p>Добавьте действия и расположите их в нужном порядке. Команда выполняется на выбранных запущенных персонажах.</p><p class="gm-safety-note" data-hybrid-plan-warning hidden></p>${blocks
      .map(
        (block, b) =>
          `<section class="gm-compose-block" data-block="${b}"><header><button type="button" class="btn ghost small" data-block-collapse aria-expanded="${!collapsed.has(b)}" title="Свернуть или раскрыть блок">${collapsed.has(b) ? '▸' : '▾'}</button><label>Название ${input('name', block.name)}</label><button class="btn ghost" type="button" data-block-up ${b === 0 ? 'disabled' : ''}>↑</button><button class="btn danger" type="button" data-block-delete>Удалить блок</button></header><p class="gm-compose-summary">${blocks.length > 1 ? `${esc(block.name)} · ` : ''}${block.steps.length} действий × ${block.repeat ?? 1} · <span data-gm-standard-scope>${block.scope === 'managed' ? 'Все распознанные окна' : esc(state.parties.find(p => p.id === (block.partyId || c.partyId))?.name || 'Текущая пати')}</span><span data-gm-hybrid-scope>Гибрид: ${esc(state.parties.find(p => p.id === (block.scope === 'party' ? block.partyId || c.partyId : c.partyId))?.name || 'текущая пати')}</span><span data-gm-legacy-delivery> · ${block.delivery === 'background' ? 'В фоне' : 'С активацией'}</span></p><div ${collapsed.has(b) ? 'hidden' : ''}><label><input type="checkbox" data-field="parallel" ${block.parallel ? 'checked' : ''} ${b === 0 ? 'disabled' : ''}> Одновременно с предыдущим</label><div class="gm-compose-fields"><label>Область ${select(
            'scope',
            [
              ['party', 'Пати'],
              ['managed', 'Все распознанные окна']
            ],
            block.scope
          )}</label><label>Пати ${select('partyId', parties(), block.partyId)}</label><label>Кому ${select(
            'target',
            [
              ['all', 'Всем'],
              ['leader', 'ПЛ'],
              ['others', 'Кроме ПЛ'],
              ['subset', 'Отмеченным']
            ],
            block.target
          )}</label><label>Доставка ${select(
            'delivery',
            [
              ['foreground', 'С активацией'],
              ['background', 'В фоне (эксперимент)']
            ],
            block.delivery
          )}</label>${
            block.delivery === 'background'
              ? `<label>Способ для клавиш ${select(
                  'backgroundMethod',
                  [
                    ['activity-notify', BACKGROUND_METHODS['activity-notify']],
                    ...((block.backgroundMethod || 'post') !== 'activity-notify'
                      ? [
                          [
                            block.backgroundMethod || 'post',
                            `${BACKGROUND_METHODS[block.backgroundMethod || 'post'] || block.backgroundMethod} · сохранённый прежний способ`
                          ]
                        ]
                      : [])
                  ],
                  block.backgroundMethod || 'post'
                )}</label><small class="gm-block-background-note" data-gm-legacy-delivery>${(block.backgroundMethod || 'post') === 'activity-notify' ? 'Метод E: только клавиши и паузы, без циклов и параллельности. Паузы — 50–3000 мс. В игре сочетания с Shift могут выполняться без модификатора.' : 'Сохранён прежний способ доставки; его работа в игре не гарантируется.'} Сначала проверьте безопасное действие. Автоматического переключения на другой способ нет.</small>`
              : ''
          }</div>${
            block.target === 'subset'
              ? `<fieldset class="gm-block-subset"><legend>Участники</legend><label>Быстро отметить класс<select data-recipient-class><option value="">Выберите класс</option>${[
                  ...new Set(
                    recipients(block)
                      .map(char => char.class)
                      .filter(Boolean)
                  )
                ]
                  .map(cls => `<option value="${esc(cls)}">${esc(cls)}</option>`)
                  .join(
                    ''
                  )}</select></label><small>Класс отмечает текущих персонажей, а не будущие окна. Для разных клавиш добавьте отдельную группу с другими получателями.</small>${recipients(
                  block
                )
                  .map(
                    char =>
                      `<label><input type="checkbox" data-character="${esc(char.id)}" ${block.charIds.includes(char.id) ? 'checked' : ''}>${esc(char.nick)}${host.dataset.commandMode === 'hybrid-party' && !partyMembers(state, block.scope === 'party' ? block.partyId || c.partyId : c.partyId).some(member => member.id === char.id) ? ' · вне выбранной пати — снимите отметку' : ''}</label>`
                  )
                  .join('')}</fieldset>`
              : ''
          }${block.scope === 'managed' && ['leader', 'others'].includes(block.target) ? '<small class="gm-block-leader-note">ПЛ берётся из настроек выбранной пати; остальные распознанные окна остаются вне ПЛ.</small>' : ''}<label class="gm-slider-switch gm-per-window-switch"><span>Выполнить все шаги в одном окне, затем перейти к следующему</span><input type="checkbox" role="switch" data-field="perWindow" ${block.perWindow ? 'checked' : ''} ${block.delivery === 'background' && isActivityMethod(block.backgroundMethod) ? 'disabled' : ''}><i aria-hidden="true"></i></label><label class="gm-loop-setting">Повторить блок ${input('repeat', block.repeat ?? 1, 'number')} раз <small>1–100; Стоп прерывает цикл. Все повторы проверяются до запуска.</small></label><div class="gm-compose-workbench"><aside class="gm-action-library" aria-label="Добавить действие"><strong>Добавить действие</strong>${[
            ['keys', '⌨', 'Клавиша'],
            ['wait', '◷', 'Задержка'],
            ['screen', '↗', 'Клик']
          ]
            .map(
              ([type, icon, label]) =>
                `<button type="button" class="btn ghost small" data-add-type="${type}">${icon} ${label}</button>`
            )
            .join(
              ''
            )}<details class="gm-template-library gm-quick-templates"><summary>Готовые примеры для пати</summary><p>Добавляют группу действий, не запускают команду и не назначают горячую клавишу. Проверьте привязки в игре и назначьте ПЛ.</p><div class="gm-template-grid"><button type="button" data-preset="assist"><b>Ассист</b><small>Shift+1 → F2 · кроме ПЛ</small></button><button type="button" data-preset="buff"><b>Баф</b><small>9 · кроме ПЛ</small></button><button type="button" data-preset="debuff"><b>Раздебаф</b><small>1 · кроме ПЛ</small></button><button type="button" data-preset="assist-buff"><b>Ассист + баф</b><small>Shift+1 → F2 → 9 · кроме ПЛ</small></button><button type="button" data-preset="buff-debuff"><b>Баф + раздебаф</b><small>9 → 1 · кроме ПЛ</small></button><button type="button" data-preset="party-f1"><b>Общая клавиша</b><small>F1 · всей пати</small></button></div></details><div class="gm-more-library"><div class="gm-extra-actions"><strong>Окна и управление</strong>${[
            ['focus', '▣', 'Окно'],
            ['launch', '▶', 'Пати'],
            ['pause', 'Ⅱ', 'Ожидание'],
            ['repeat', '⇄', 'Повтор ввода'],
            ['resize', '▱', 'Размер окна'],
            ['profile', '▦', 'Профиль окон']
          ]
            .map(
              ([type, icon, label]) =>
                `<button type="button" class="btn ghost small" data-add-type="${type}">${icon} ${label}</button>`
            )
            .join(
              ''
            )}</div><details class="gm-template-library"><summary>Примеры из обычных шагов</summary><button type="button" class="btn ghost small" data-template="f6f1">F6 → F1, два прохода</button><button type="button" class="btn ghost small" data-template="follow">Следование</button><button type="button" class="btn ghost small" data-template="optimize">Размеры + Ctrl+F9</button></details><details><summary>Добавить шаги моей команды</summary>${c.commands
            .filter(cmd => cmd.id !== row?.id && cmd.action !== 'pause')
            .map(
              cmd =>
                `<button type="button" class="btn ghost small" data-unpack-command="${esc(cmd.id)}">${esc(cmd.name)}</button>`
            )
            .join(
              ''
            )}<small>Копия редактируемых блоков, не эксклюзивная команда и не зависимость от её будущих изменений.</small></details></div></aside><ol class="gm-compose-steps">${block.steps.length ? '' : '<li class="gm-empty-plan"><b>С чего начнём?</b><p>Добавьте клавишу, задержку или клик. Затем настройте действие в появившейся карточке.</p></li>'}${block.steps.map((step, i) => `<li class="gm-action-row ${i === (selected.get(b) || 0) ? 'is-selected' : ''}" data-step="${i}" data-step-type="${esc(step.type)}" ><div class="gm-step-heading"><button type="button" class="gm-step-select" data-step-select aria-expanded="${i === (selected.get(b) || 0)}"><span class="gm-step-number">${i + 1}</span><span class="gm-step-kind">${esc(STEP_LABELS[step.type])}</span><strong data-step-summary>${esc(summary(step))}</strong></button><div class="gm-step-actions"><button type="button" class="btn ghost small" data-step-up title="Переместить шаг вверх" aria-label="Переместить шаг вверх" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn ghost small" data-step-down title="Переместить шаг вниз" aria-label="Переместить шаг вниз" ${i === block.steps.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="btn ghost small" data-step-copy title="Дублировать шаг" aria-label="Дублировать шаг">⧉</button><button type="button" class="btn danger small" data-step-delete title="Удалить шаг" aria-label="Удалить шаг">×</button></div></div><div class="gm-compose-fields gm-step-editor" ${i === (selected.get(b) || 0) ? '' : 'hidden'}>${fields(step)}</div></li>`).join('')}</ol></div></div></section>`
      )
      .join(
        ''
      )}<div class="gm-add-group"><button type="button" class="btn" data-block-add ${blocks.length >= 8 ? 'disabled' : ''}>＋ Добавить группу</button></div><p data-compose-error role="alert"></p>`;
    host.querySelectorAll('.gm-compose-block').forEach(section => {
      const b = Number(section.dataset.block),
        block = blocks[b],
        workbench = section.querySelector('.gm-compose-workbench');
      const advanced = document.createElement('section');
      advanced.className = 'gm-block-advanced';
      advanced.innerHTML =
        '<h5>Настройки группы</h5><p class="muted">Кому и как выполнять действия этой группы.</p><div class="gm-compose-fields"></div>';
      const body = advanced.querySelector('div');
      for (const field of [
        'scope',
        'partyId',
        'target',
        'parallel',
        'leaderSplit',
        'perWindow',
        'repeat',
        'delivery',
        'backgroundMethod'
      ]) {
        const element = section.querySelector(`[data-field="${field}"]`);
        if (element) {
          const label = element.closest('label');
          if (['delivery', 'backgroundMethod'].includes(field)) label.dataset.gmLegacyDelivery = '';
          if (field === 'partyId' && block.scope === 'managed' && !['leader', 'others'].includes(block.target))
            label.hidden = true;
          if (field === 'parallel' && b === 0) label.hidden = true;
          body.append(label);
        }
      }
      for (const note of section.querySelectorAll('.gm-block-background-note, .gm-block-leader-note'))
        advanced.append(note);
      const subset = section.querySelector('.gm-block-subset');
      if (subset) advanced.append(subset);
      if (blocks.length === 1) {
        const header = section.querySelector(':scope > header');
        header.querySelector('[data-field="name"]').closest('label').remove();
        header.querySelector('[data-block-up]').remove();
        header.querySelector('[data-block-delete]').remove();
        const title = document.createElement('strong');
        title.textContent = 'Действия команды';
        header.append(title);
      }
      workbench.querySelector('.gm-action-library').append(advanced);
    });
    const exampleContainers = [...host.querySelectorAll('.gm-action-library')];
    if (exampleContainers.length) {
      const examples = document.createElement('details');
      examples.className = 'gm-examples-panel';
      examples.innerHTML =
        '<summary>Готовые примеры и мои команды</summary><p>Примеры добавляются в редактор и ничего не запускают.</p>';
      exampleContainers.forEach((library, index) => {
        for (const element of library.querySelectorAll('.gm-quick-templates, .gm-more-library > details')) {
          if (index === 0) {
            if (element.classList.contains('gm-quick-templates')) {
              const title = document.createElement('strong');
              title.textContent = 'Примеры для пати';
              examples.append(title, ...element.querySelectorAll('p, .gm-template-grid'));
              element.remove();
            } else examples.append(element);
          } else element.remove();
        }
      });
      host.querySelector('.gm-compose-block').before(examples);
    }
    host
      .querySelectorAll('[data-step-type="keys"] [data-field="value"]')
      .forEach(input => input.after(keyboardButton(input)));
    updateMode();
  }
  function updateMode() {
    const hybrid = host.dataset.commandMode === 'hybrid-party';
    host.querySelectorAll('.gm-compose-block').forEach(section => {
      const block = blocks[Number(section.dataset.block)];
      const fieldLabel = field => section.querySelector(`[data-field="${field}"]`)?.closest('label');
      const scope = fieldLabel('scope');
      const perWindow = fieldLabel('perWindow');
      const repeat = fieldLabel('repeat');
      const party = fieldLabel('partyId');
      const parallel = fieldLabel('parallel');
      const split = fieldLabel('leaderSplit');
      if (scope) scope.hidden = hybrid;
      if (perWindow) {
        perWindow.hidden = hybrid;
        const toggle = perWindow.querySelector('input');
        const unsupported = block.steps.some(
          step => !['keys', 'wait', 'point', 'screen', 'resize'].includes(step.type)
        );
        toggle.disabled =
          (block.delivery === 'background' && isActivityMethod(block.backgroundMethod)) ||
          (!block.perWindow && unsupported);
        toggle.title =
          unsupported && !block.perWindow ? 'Для обхода по окнам оставьте только клавиши, паузы, клики и размеры.' : '';
      }
      if (repeat) repeat.hidden = hybrid && (block.repeat ?? 1) === 1;
      if (party)
        party.hidden = hybrid
          ? block.scope !== 'party'
          : block.scope === 'managed' && !['leader', 'others'].includes(block.target);
      if (parallel) parallel.hidden = Number(section.dataset.block) === 0 || (hybrid && !block.parallel);
      if (split) split.hidden = hybrid;
      const note = section.querySelector('.gm-block-leader-note');
      if (note) note.hidden = hybrid;
      const extra = section.querySelector('.gm-more-library');
      if (extra) extra.hidden = hybrid;
      for (const button of section.querySelectorAll(
        '[data-add-type="focus"], [data-add-type="launch"], [data-add-type="pause"], [data-add-type="repeat"], [data-add-type="profile"]'
      )) {
        button.disabled = !!block.perWindow;
        button.title = button.disabled ? 'Выключите обход по окнам или добавьте действие в другую группу.' : '';
      }
      const click = section.querySelector('[data-add-type="screen"]');
      if (click) click.hidden = hybrid;
      for (const button of section.querySelectorAll(
        '[data-add-type="keys"], [data-add-type="wait"], [data-step-copy]'
      )) {
        const limit = hybrid && block.steps.length >= 8;
        button.disabled = limit;
        button.title = limit
          ? 'В гибридном режиме не более 8 шагов.'
          : button.hasAttribute('data-step-copy')
            ? 'Дублировать шаг'
            : '';
      }
    });
    const add = host.querySelector('[data-block-add]');
    if (add) add.hidden = hybrid;
    const incompatibleExamples = host.querySelectorAll('[data-template], [data-unpack-command]');
    incompatibleExamples.forEach(button => {
      button.hidden = hybrid;
    });
    host.querySelectorAll('.gm-examples-panel > details').forEach(details => {
      details.hidden = hybrid;
    });
    const empty = blocks.length === 1 && blocks[0].steps.length === 0;
    host.querySelectorAll('[data-preset]').forEach(button => {
      button.disabled = hybrid && !empty;
      button.title = button.disabled
        ? 'Гибрид поддерживает одну группу; пример можно добавить только в пустую команду.'
        : '';
    });
    const warning = host.querySelector('[data-hybrid-plan-warning]');
    if (warning) {
      warning.hidden = !hybrid;
      const incompatible =
        blocks.length !== 1 ||
        blocks.some(
          block =>
            block.parallel ||
            (block.repeat ?? 1) !== 1 ||
            block.steps.length > 8 ||
            block.steps.some(step => !['keys', 'wait'].includes(step.type))
        );
      warning.textContent = incompatible
        ? 'Для гибрида оставьте одну группу, не более 8 шагов клавиш и пауз, без повтора и параллельности. Существующие действия не удалены: исправьте их или вернитесь в активный режим.'
        : 'Гибрид: одна группа клавиш и пауз, до 8 шагов; пауза 50–3000 мс. Выполняется последовательно на участниках выбранной пати.';
    }
  }
  host.onchange = e => {
    const field = e.target.dataset.field,
      el = e.target.closest('[data-block]');
    if (!el) return;
    const b = Number(el.dataset.block),
      stepEl = e.target.closest('[data-step]');
    if (e.target.matches('[data-recipient-class]')) {
      if (e.target.value) {
        const block = blocks[b];
        const hybridMembers =
          host.dataset.commandMode === 'hybrid-party'
            ? partyMembers(state, block.scope === 'party' ? block.partyId || c.partyId : c.partyId)
            : null;
        block.charIds = recipients(block)
          .filter(
            char =>
              char.class === e.target.value && (!hybridMembers || hybridMembers.some(member => member.id === char.id))
          )
          .map(char => char.id);
        draw();
      }
      return;
    }
    if (e.target.dataset.character) {
      const set = new Set(blocks[b].charIds);
      if (e.target.checked) set.add(e.target.dataset.character);
      else set.delete(e.target.dataset.character);
      blocks[b].charIds = [...set];
      return;
    }
    if (e.target.matches('[data-click-source]') && stepEl) {
      const step = blocks[b].steps[Number(stepEl.dataset.step)];
      step.type = e.target.value;
      step.x ??= 0;
      step.y ??= 0;
      step.pointId ??= '';
      draw();
      return;
    }
    if (!field) return;
    const object = stepEl ? blocks[b].steps[Number(stepEl.dataset.step)] : blocks[b];
    if (field === 'type') {
      blocks[b].steps[Number(stepEl.dataset.step)] = blank(e.target.value);
      draw();
      return;
    }
    if (field === 'modifiers') {
      object.modifiers = e.target.value.split('+').filter(Boolean);
      return;
    }
    object[field] =
      e.target.type === 'checkbox'
        ? e.target.checked
        : ['ms', 'x', 'y', 'width', 'height', 'count', 'repeat'].includes(field)
          ? Number(e.target.value)
          : e.target.value;
    if (stepEl) stepEl.querySelector('[data-step-summary]').textContent = summary(object);
    if (!stepEl && ['repeat', 'parallel', 'perWindow'].includes(field)) updateMode();
    if (!stepEl && ['partyId', 'target', 'scope', 'delivery', 'backgroundMethod', 'leaderSplit'].includes(field)) {
      if (object.delivery === 'background' && isActivityMethod(object.backgroundMethod)) object.perWindow = true;
      if (field === 'partyId') object.charIds = [];
      if (object.scope === 'managed' && ['leader', 'others'].includes(object.target)) object.leaderSplit = true;
      if (field === 'scope' || field === 'partyId') object.charIds = [];
      draw();
    }
  };
  host.oninput = e => {
    if (e.target.matches('input[data-field]') && e.target.type !== 'checkbox') host.onchange(e);
  };
  host.onclick = async e => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.quickModifier) {
      applyQuickModifier(button.closest('label').querySelector('input'), button.dataset.quickModifier);
      return;
    }
    const el = button.closest('[data-block]'),
      b = Number(el?.dataset.block),
      step = button.closest('[data-step]'),
      i = Number(step?.dataset.step);
    if (button.hasAttribute('data-undo')) {
      if (undo.length) {
        blocks = undo.pop();
        selected.clear();
        collapsed.clear();
        draw();
      }
      return;
    }
    if (button.hasAttribute('data-block-collapse')) {
      if (collapsed.has(b)) collapsed.delete(b);
      else collapsed.add(b);
      draw();
      return;
    }
    if (button.hasAttribute('data-step-select')) {
      selected.set(b, i);
      draw();
      return;
    }
    if (button.dataset.preset) {
      const templates = {
        assist: {
          name: 'Ассист',
          steps: [
            { type: 'keys', value: 'SHIFT+1' },
            { type: 'wait', ms: 100 },
            { type: 'keys', value: 'F2' }
          ],
          target: 'others'
        },
        buff: { name: 'Баф', steps: [{ type: 'keys', value: '9' }], target: 'others' },
        debuff: { name: 'Раздебаф', steps: [{ type: 'keys', value: '1' }], target: 'others' },
        'assist-buff': {
          name: 'Ассист + баф',
          steps: [
            { type: 'keys', value: 'SHIFT+1' },
            { type: 'wait', ms: 100 },
            { type: 'keys', value: 'F2' },
            { type: 'wait', ms: 200 },
            { type: 'keys', value: '9' }
          ],
          target: 'others'
        },
        'buff-debuff': {
          name: 'Баф + раздебаф',
          steps: [
            { type: 'keys', value: '9' },
            { type: 'wait', ms: 200 },
            { type: 'keys', value: '1' }
          ],
          target: 'others'
        },
        'party-f1': { name: 'Общая клавиша', steps: [{ type: 'keys', value: 'F1' }], target: 'all' }
      };
      const template = templates[button.dataset.preset];
      if (!template) return;
      const empty = blocks.length === 1 && !blocks[0].steps.length;
      if (
        !empty &&
        (blocks.length >= 8 ||
          blocks.reduce((count, block) => count + block.steps.length, 0) + template.steps.length > 128)
      ) {
        host.querySelector('[data-compose-error]').textContent = 'Максимум 8 групп и 128 действий в команде.';
        return;
      }
      remember();
      const added = {
        ...newBlock(blocks.length + 1),
        ...structuredClone(template),
        scope: 'party',
        partyId: '',
        perWindow: true
      };
      if (empty) blocks = [added];
      else blocks.push(added);
      selected.clear();
      if (empty)
        host.dispatchEvent(new CustomEvent('gm-template-picked', { bubbles: true, detail: { name: template.name } }));
      draw();
      return;
    }
    if (button.dataset.template || button.dataset.unpackCommand) {
      try {
        const source = button.dataset.unpackCommand
          ? c.commands.find(cmd => cmd.id === button.dataset.unpackCommand)
          : {
              action: button.dataset.template,
              name: { follow: 'Следование', f6f1: 'Два прохода', optimize: 'Размеры' }[button.dataset.template],
              target: button.dataset.template === 'follow' ? 'others' : 'all',
              partyId: blocks[b]?.partyId || c.partyId
            };
        const added = commandBlocks(source, c);
        const retained = blocks.length === 1 && !blocks[0].steps.length ? [] : blocks;
        if (
          retained.length + added.length > 8 ||
          retained.reduce((n, block) => n + block.steps.length, 0) +
            added.reduce((n, block) => n + block.steps.length, 0) >
            128
        )
          throw new Error('Недостаточно места: максимум 8 блоков / 128 действий.');
        remember();
        if (blocks.length === 1 && !blocks[0].steps.length) blocks = [];
        blocks.push(...added);
        draw();
      } catch (error) {
        host.querySelector('[data-compose-error]').textContent = error.message;
      }
      return;
    }
    if (button.hasAttribute('data-add-type')) {
      if (!canAdd(b)) return;
      const newStep = blank(button.dataset.addType);
      remember();
      blocks[b].steps.push(newStep);
      selected.set(b, blocks[b].steps.length - 1);
      draw();
      return;
    }
    if (button.hasAttribute('data-step-copy')) {
      if (!canAdd(b)) return;
      remember();
      blocks[b].steps.splice(i + 1, 0, structuredClone(blocks[b].steps[i]));
      selected.set(b, i + 1);
      draw();
      return;
    }
    if (button.hasAttribute('data-block-add')) {
      if (blocks.length >= 8) return;
      remember();
      blocks.push(newBlock(blocks.length + 1));
      draw();
    }
    if (button.hasAttribute('data-block-delete')) {
      remember();
      blocks.splice(b, 1);
      selected.clear();
      collapsed.clear();
      if (blocks[0]) blocks[0].parallel = false;
      draw();
    }
    if (button.hasAttribute('data-block-up') && b > 0) {
      remember();
      selected.clear();
      collapsed.clear();
      [blocks[b - 1], blocks[b]] = [blocks[b], blocks[b - 1]];
      blocks[0].parallel = false;
      draw();
    }
    if (button.hasAttribute('data-step-delete')) {
      remember();
      blocks[b].steps.splice(i, 1);
      selected.set(b, Math.max(0, Math.min(i, blocks[b].steps.length - 1)));
      draw();
    }
    if (button.hasAttribute('data-step-down') && i < blocks[b].steps.length - 1) {
      remember();
      selected.set(b, i + 1);
      [blocks[b].steps[i + 1], blocks[b].steps[i]] = [blocks[b].steps[i], blocks[b].steps[i + 1]];
      draw();
    }
    if (button.hasAttribute('data-step-up') && i > 0) {
      remember();
      selected.set(b, i - 1);
      [blocks[b].steps[i - 1], blocks[b].steps[i]] = [blocks[b].steps[i], blocks[b].steps[i - 1]];
      draw();
    }
  };
  draw();
  return {
    read: () => {
      try {
        return normalizeComposition(blocks);
      } catch (error) {
        for (const [b, block] of blocks.entries()) {
          for (const [i, step] of block.steps.entries()) {
            try {
              normalizeComposition([{ ...block, parallel: false, steps: [step] }]);
            } catch {
              selected.set(b, i);
              collapsed.delete(b);
              draw();
              const row = host.querySelector(`[data-block="${b}"] [data-step="${i}"]`);
              row?.classList.add('is-invalid');
              host.querySelector('[data-compose-error]').textContent = `Блок ${b + 1}, шаг ${i + 1}: ${error.message}`;
              row?.querySelector('input, select')?.focus();
              throw error;
            }
          }
        }
        host.querySelector('[data-compose-error]').textContent = error.message;
        throw error;
      }
    },
    snapshot: () => structuredClone(blocks),
    restoreBlocks: next => {
      if (!Array.isArray(next) || next.length > 8) throw new Error('Некорректный черновик.');
      blocks = structuredClone(next);
      draw();
    },
    setBlocks: next => {
      blocks = normalizeComposition(next);
      draw();
    },
    setMode: mode => {
      host.dataset.commandMode = mode;
      draw();
    },
    dispose: () => {
      host.onchange = null;
      host.oninput = null;
      host.onclick = null;
    }
  };
}
