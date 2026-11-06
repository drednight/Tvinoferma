import { escapeHtml as esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import { partyMembers } from './model.js';
import { STEP_LABELS, normalizeComposition } from './composition.js';
import { mountRecorder } from './recorder.js';
export function mountCompositionEditor(host, c, row, { cursor, newPoint }) {
  let blocks = row?.blocks?.length ? structuredClone(row.blocks) : [newBlock()];
  let disposeRecorder = () => {};
  function newBlock(index = 1) {
    return {
      name: `Блок ${index}`,
      parallel: false,
      scope: 'party',
      partyId: c.partyId,
      target: 'all',
      charIds: [],
      delivery: 'foreground',
      steps: [{ type: 'keys', value: 'F8' }]
    };
  }
  const option = (v, label, chosen) =>
    `<option value="${esc(v)}" ${v === chosen ? 'selected' : ''}>${esc(label)}</option>`;
  const select = (field, values, value) =>
    `<select class="input" data-field="${field}">${values.map(([v, l]) => option(v, l, value)).join('')}</select>`;
  const input = (field, value, type = 'text') =>
    `<input class="input" data-field="${field}" type="${type}" value="${esc(value ?? '')}">`;
  const parties = () => [['', 'Текущая управляющая пати'], ...state.parties.map(p => [p.id, p.name])];
  function fields(step) {
    switch (step.type) {
      case 'keys':
        return `<label>Клавиша ${input('value', step.value)}</label>`;
      case 'wait':
        return `<label>Миллисекунды ${input('ms', step.ms, 'number')}</label>`;
      case 'command':
        return `<label>Команда ${select(
          'commandId',
          [
            ['', 'Выберите команду'],
            ...c.commands
              .filter(cmd => cmd.id !== row?.id && !['mirror', 'pause'].includes(cmd.action))
              .map(cmd => [cmd.id, cmd.name])
          ],
          step.commandId
        )}</label><small>Ссылка: изменения исходной команды применяются здесь. Циклы запрещены.</small>`;
      case 'point':
        return `<label>Точка ${select('pointId', [['', 'Выбрать точку'], ...c.points.map(p => [p.id, p.name])], step.pointId)}</label>${mouse(step)}`;
      case 'screen':
        return `<label>Экран X ${input('x', step.x, 'number')}</label><label>Экран Y ${input('y', step.y, 'number')}</label>${mouse(step)}`;
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
        keys: { type, value: 'F8' },
        wait: { type, ms: 100 },
        command: { type, commandId: '' },
        point: { type, pointId: '', button: 'left', count: 1 },
        screen: { type, x: 0, y: 0, button: 'left', count: 1 },
        resize: { type, width: 2560, height: 1400 },
        focus: { type, direction: 'leader' }
      }[type] || { type, partyId: '', profileId: '' }
    );
  }
  function draw() {
    disposeRecorder();
    host.innerHTML = `<h4>Составная команда</h4><p>До 8 блоков / 128 действий. Включите «Одновременно с предыдущим» для соседних блоков. Паузы ветвей перекрываются, ввод сериализован. Получатели задаются для каждого блока. Клики требуют разрешения и предпросмотра после сохранения.</p>${blocks
      .map(
        (block, b) =>
          `<section class="gm-compose-block" data-block="${b}"><header><label>Название ${input('name', block.name)}</label><button class="btn ghost" type="button" data-block-up ${b === 0 ? 'disabled' : ''}>↑</button><button class="btn danger" type="button" data-block-delete>Удалить блок</button></header><label><input type="checkbox" data-field="parallel" ${block.parallel ? 'checked' : ''} ${b === 0 ? 'disabled' : ''}> Одновременно с предыдущим</label><div class="gm-compose-fields"><label>Область ${select(
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
          )}</label></div>${
            block.target === 'subset'
              ? `<fieldset><legend>Участники</legend>${partyMembers(state, block.partyId || c.partyId)
                  .map(
                    char =>
                      `<label><input type="checkbox" data-character="${esc(char.id)}" ${block.charIds.includes(char.id) ? 'checked' : ''}>${esc(char.nick)}</label>`
                  )
                  .join('')}</fieldset>`
              : ''
          }<ol>${block.steps.map((step, i) => `<li data-step="${i}"><div class="gm-compose-fields"><label>Действие ${select('type', Object.entries(STEP_LABELS), step.type)}</label>${fields(step)}</div><button type="button" class="btn ghost" data-step-up ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn danger" data-step-delete>Удалить шаг</button></li>`).join('')}</ol><div class="row gap"><button type="button" class="btn" data-step-add>＋ Действие</button><select data-insert-command>${[['', 'Добавить существующую команду…'], ...c.commands.filter(cmd => cmd.id !== row?.id && !['mirror', 'pause'].includes(cmd.action)).map(cmd => [cmd.id, cmd.name])].map(([v, l]) => option(v, l, '')).join('')}</select><button type="button" class="btn" data-new-point>＋ Именованная точка</button></div><div data-recorder></div></section>`
      )
      .join(
        ''
      )}<button type="button" class="btn" data-block-add>＋ Блок</button><p data-compose-error role="alert"></p>`;
    const cleanups = [];
    host.querySelectorAll('[data-block]').forEach(el => {
      const b = Number(el.dataset.block);
      cleanups.push(
        mountRecorder(el.querySelector('[data-recorder]'), {
          cursor,
          limit: 64 - blocks[b].steps.length,
          onRecorded: steps => {
            blocks[b].steps.push(...steps);
            draw();
          }
        })
      );
    });
    disposeRecorder = () => cleanups.forEach(fn => fn());
  }
  host.onchange = e => {
    const field = e.target.dataset.field,
      el = e.target.closest('[data-block]');
    if (!el) return;
    const b = Number(el.dataset.block),
      stepEl = e.target.closest('[data-step]');
    if (e.target.matches('[data-insert-command]')) {
      if (e.target.value) blocks[b].steps.push({ type: 'command', commandId: e.target.value });
      draw();
      return;
    }
    if (e.target.dataset.character) {
      const set = new Set(blocks[b].charIds);
      if (e.target.checked) set.add(e.target.dataset.character);
      else set.delete(e.target.dataset.character);
      blocks[b].charIds = [...set];
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
        : ['ms', 'x', 'y', 'width', 'height', 'count'].includes(field)
          ? Number(e.target.value)
          : e.target.value;
    if (!stepEl && ['partyId', 'target', 'scope'].includes(field)) {
      if (field === 'partyId') object.charIds = [];
      if (object.scope === 'managed') object.target = 'all';
      draw();
    }
  };
  host.oninput = e => {
    if (e.target.matches('input[data-field]') && e.target.type !== 'checkbox') host.onchange(e);
  };
  host.onclick = async e => {
    const button = e.target.closest('button');
    if (!button) return;
    const el = button.closest('[data-block]'),
      b = Number(el?.dataset.block),
      step = button.closest('[data-step]'),
      i = Number(step?.dataset.step);
    if (button.hasAttribute('data-block-add')) {
      if (blocks.length >= 8) return;
      blocks.push(newBlock(blocks.length + 1));
      draw();
    }
    if (button.hasAttribute('data-block-delete')) {
      blocks.splice(b, 1);
      if (blocks[0]) blocks[0].parallel = false;
      draw();
    }
    if (button.hasAttribute('data-block-up') && b > 0) {
      [blocks[b - 1], blocks[b]] = [blocks[b], blocks[b - 1]];
      blocks[0].parallel = false;
      draw();
    }
    if (button.hasAttribute('data-step-add')) {
      if (blocks[b].steps.length >= 64) return;
      blocks[b].steps.push(blank('keys'));
      draw();
    }
    if (button.hasAttribute('data-step-delete')) {
      blocks[b].steps.splice(i, 1);
      draw();
    }
    if (button.hasAttribute('data-step-up') && i > 0) {
      [blocks[b].steps[i - 1], blocks[b].steps[i]] = [blocks[b].steps[i], blocks[b].steps[i - 1]];
      draw();
    }
    if (button.hasAttribute('data-new-point')) {
      try {
        await newPoint(blocks[b].partyId || c.partyId);
        draw();
      } catch (error) {
        host.querySelector('[data-compose-error]').textContent = error.message;
      }
    }
  };
  draw();
  return { read: () => normalizeComposition(blocks), dispose: () => disposeRecorder() };
}
