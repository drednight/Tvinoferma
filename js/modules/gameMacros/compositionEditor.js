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
  const advancedExpansion = new Map();
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
      steps: []
    };
  }
  const option = (v, label, chosen, hidden = false) =>
    `<option ${hidden ? 'hidden' : ''} value="${esc(v)}" ${v === chosen ? 'selected' : ''}>${esc(label)}</option>`;
  const select = (field, values, value) =>
    `<select class="input" data-field="${field}">${values.map(([v, l]) => option(v, l, value, field === 'commandId' && c.commands.some(cmd => cmd.id === v && !commandVisible(cmd)))).join('')}</select>`;
  const input = (field, value, type = 'text') =>
    `<input class="input" data-field="${field}" type="${type}" value="${esc(value ?? '')}">`;
  const recipients = block =>
    block.scope === 'managed' ? state.characters : partyMembers(state, block.partyId || c.partyId);
  const parties = () => [['', 'Текущая управляющая пати'], ...state.parties.map(p => [p.id, p.name])];
  function fields(step) {
    switch (step.type) {
      case 'keys':
        return `<label>Клавиша ${input('value', step.value)}${quickKeysHtml()}</label><small>Например SHIFT+1, CTRL+F2 или F8. Сочетание задаётся здесь, без отдельного окна ввода.</small>`;
      case 'wait':
        return `<label>Задержка, мс ${input('ms', step.ms, 'number')}</label>`;
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
        return `${clickSource(step)}<label>Точка ${select('pointId', [['', 'Выбрать точку'], ...c.points.map(p => [p.id, p.name])], step.pointId)}</label>${pointVariants(step)}${mouse(step)}`;
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
  function pointVariants(step) {
    return `<details><summary>Дополнительные шаблоны для других размеров/DPI</summary>${c.points
      .filter(p => p.id !== step.pointId)
      .map(
        p =>
          `<label><input type="checkbox" data-point-variant="${esc(p.id)}" ${step.pointIds?.includes(p.id) ? 'checked' : ''}>${esc(p.name)} · ${p.width}×${p.height} · DPI ${p.dpi}</label>`
      )
      .join(
        ''
      )}<small>Для каждого окна должен подходить ровно один шаблон; автоматического растягивания нет.</small></details>`;
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
    host.innerHTML = `<div class="gm-compose-title"><h4>Что выполнить</h4><button type="button" class="btn ghost small" data-undo ${undo.length ? '' : 'disabled'}>↶ Отменить изменение</button></div><p>Добавьте действия и расположите их в нужном порядке. Команда выполняется на выбранных запущенных персонажах.</p>${blocks
      .map(
        (block, b) =>
          `<section class="gm-compose-block" data-block="${b}"><header><button type="button" class="btn ghost small" data-block-collapse aria-expanded="${!collapsed.has(b)}" title="Свернуть или раскрыть блок">${collapsed.has(b) ? '▸' : '▾'}</button><label>Название ${input('name', block.name)}</label><button class="btn ghost" type="button" data-block-up ${b === 0 ? 'disabled' : ''}>↑</button><button class="btn danger" type="button" data-block-delete>Удалить блок</button></header><p class="gm-compose-summary">${esc(block.name)} · ${block.steps.length} действий × ${block.repeat ?? 1} · ${block.scope === 'managed' ? 'Все распознанные окна' : esc(state.parties.find(p => p.id === (block.partyId || c.partyId))?.name || 'Текущая пати')} · ${block.delivery === 'background' ? 'В фоне' : 'С активацией'}</p><div ${collapsed.has(b) ? 'hidden' : ''}><label><input type="checkbox" data-field="parallel" ${block.parallel ? 'checked' : ''} ${b === 0 ? 'disabled' : ''}> Одновременно с предыдущим</label><div class="gm-compose-fields"><label>Область ${select(
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
                  Object.entries(BACKGROUND_METHODS),
                  block.backgroundMethod || 'post'
                )}</label><small>Уведомления активности: в группе только клавиши и паузы, без циклов и параллельности. Вся цепочка выполняется в каждом выбранном окне. Для этой доставки паузы — 50–3000 мс. Клики и непрерывный повтор используют PostMessage. Другие способы здесь проверяются только для клавиш; без перебора и переключения.</small>`
              : ''
          }</div>${
            block.target === 'subset'
              ? `<fieldset><legend>Участники</legend><label>Быстро отметить класс<select data-recipient-class><option value="">Выберите класс</option>${[
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
                      `<label><input type="checkbox" data-character="${esc(char.id)}" ${block.charIds.includes(char.id) ? 'checked' : ''}>${esc(char.nick)}</label>`
                  )
                  .join('')}</fieldset>`
              : ''
          }${block.scope === 'managed' && ['leader', 'others'].includes(block.target) ? '<small>ПЛ берётся из настроек выбранной пати; остальные распознанные окна остаются вне ПЛ.</small>' : ''}<label><input type="checkbox" data-field="perWindow" ${block.perWindow ? 'checked' : ''} ${block.delivery === 'background' && isActivityMethod(block.backgroundMethod) ? 'disabled' : ''}> Выполнить все шаги в одном окне, затем перейти к следующему</label><label class="gm-loop-setting">Повторить блок ${input('repeat', block.repeat ?? 1, 'number')} раз <small>1–100; Стоп прерывает цикл. Все повторы проверяются до запуска.</small></label><div class="gm-compose-workbench"><aside class="gm-action-library" aria-label="Добавить действие"><strong>Добавить действие</strong>${[
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
            )}<details class="gm-more-library"><summary>Другие действия и примеры</summary><details class="gm-extra-actions"><summary>Окна, пати и повтор</summary>${[
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
            )}</details><details class="gm-template-library"><summary>Примеры из обычных шагов</summary><button type="button" class="btn ghost small" data-template="f6f1">F6 → F1, два прохода</button><button type="button" class="btn ghost small" data-template="follow">Следование</button><button type="button" class="btn ghost small" data-template="optimize">Размеры + Ctrl+F9</button></details><details><summary>Добавить шаги моей команды</summary>${c.commands
            .filter(cmd => cmd.id !== row?.id && cmd.action !== 'pause')
            .map(
              cmd =>
                `<button type="button" class="btn ghost small" data-unpack-command="${esc(cmd.id)}">${esc(cmd.name)}</button>`
            )
            .join(
              ''
            )}<small>Копия редактируемых блоков, не эксклюзивная команда и не зависимость от её будущих изменений.</small></details></details></aside><ol class="gm-compose-steps">${block.steps.length ? '' : '<li class="gm-empty-plan"><b>С чего начнём?</b><p>Добавьте клавишу, задержку или клик. Затем настройте действие в появившейся карточке.</p></li>'}${block.steps.map((step, i) => `<li class="gm-action-row ${i === (selected.get(b) || 0) ? 'is-selected' : ''}" data-step="${i}" data-step-type="${esc(step.type)}" ><div class="gm-step-heading"><button type="button" class="gm-step-select" data-step-select aria-expanded="${i === (selected.get(b) || 0)}"><span class="gm-step-number">${i + 1}</span><span class="gm-step-kind">${esc(STEP_LABELS[step.type])}</span><strong data-step-summary>${esc(summary(step))}</strong></button><div class="gm-step-actions"><button type="button" class="btn ghost small" data-step-up title="Переместить шаг вверх" aria-label="Переместить шаг вверх" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn ghost small" data-step-down title="Переместить шаг вниз" aria-label="Переместить шаг вниз" ${i === block.steps.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="btn ghost small" data-step-copy title="Дублировать шаг" aria-label="Дублировать шаг">⧉</button><button type="button" class="btn danger small" data-step-delete title="Удалить шаг" aria-label="Удалить шаг">×</button></div></div><div class="gm-compose-fields gm-step-editor" ${i === (selected.get(b) || 0) ? '' : 'hidden'}>${fields(step)}</div></li>`).join('')}</ol></div></div></section>`
      )
      .join(
        ''
      )}<details class="gm-add-group"><summary>Сложная команда: несколько групп</summary><button type="button" class="btn" data-block-add>＋ Добавить группу</button></details><p data-compose-error role="alert"></p>`;
    host.querySelectorAll('.gm-compose-block').forEach(section => {
      const b = Number(section.dataset.block),
        block = blocks[b],
        workbench = section.querySelector('.gm-compose-workbench');
      const advanced = document.createElement('details');
      advanced.className = 'gm-block-advanced';
      advanced.innerHTML =
        '<summary>Дополнительные настройки группы</summary><p class="muted">Обычно менять не нужно. Для старых команд сохранены прежние ограничения.</p><div class="gm-compose-fields"></div>';
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
        if (element) body.append(element.closest('label'));
      }
      advanced.open = advancedExpansion.has(b)
        ? advancedExpansion.get(b)
        : !!(
            block.parallel ||
            block.perWindow ||
            block.repeat > 1 ||
            block.scope === 'party' ||
            block.target !== 'all' ||
            block.delivery === 'background'
          );
      advanced.addEventListener('toggle', () => {
        if (advanced.isConnected) advancedExpansion.set(b, advanced.open);
      });
      if (blocks.length === 1) {
        const header = section.querySelector(':scope > header');
        body.append(header.querySelector('[data-field="name"]').closest('label'));
        body.append(header.querySelector('[data-block-up]'), header.querySelector('[data-block-delete]'));
        const title = document.createElement('strong');
        title.textContent = 'Действия команды';
        header.append(title);
      }
      workbench.after(advanced);
    });
    host
      .querySelectorAll('[data-step-type="keys"] [data-field="value"]')
      .forEach(input => input.after(keyboardButton(input)));
  }
  host.onchange = e => {
    const field = e.target.dataset.field,
      el = e.target.closest('[data-block]');
    if (!el) return;
    const b = Number(el.dataset.block),
      stepEl = e.target.closest('[data-step]');
    if (e.target.matches('[data-recipient-class]')) {
      if (e.target.value) {
        blocks[b].charIds = recipients(blocks[b])
          .filter(char => char.class === e.target.value)
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
    if (e.target.dataset.pointVariant && stepEl) {
      const step = blocks[b].steps[Number(stepEl.dataset.step)];
      const ids = new Set(step.pointIds || []);
      if (e.target.checked) ids.add(e.target.dataset.pointVariant);
      else ids.delete(e.target.dataset.pointVariant);
      step.pointIds = [...ids];
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
    dispose: () => {
      host.onchange = null;
      host.oninput = null;
      host.onclick = null;
    }
  };
}
