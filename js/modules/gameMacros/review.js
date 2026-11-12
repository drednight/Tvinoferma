import { chord, steps, partyMembers } from './model.js';
import { compileComposition } from './composition.js';
import { commandBlocks, materializeUnifiedCommand } from './unified.js';
import { validateActivityCommand, BACKGROUND_METHODS } from './background.js';
import { escapeHtml as esc } from '../../core/utils.js';
/** Configuration checks only: never sends input, activates windows, or claims game acceptance. */
export function reviewCommand(command, c, state, path = []) {
  if (path.includes(command.id) || path.length >= 4)
    return {
      issues: [{ severity: 'error', field: 'blocks', message: 'Цикл или слишком глубокая вложенность команд.' }],
      lines: []
    };
  const issues = [],
    lines = [];
  const add = (severity, field, message) => issues.push({ severity, field, message });
  if (!String(command.name || '').trim()) add('error', 'name', 'Введите название команды.');
  try {
    if (command.hotkey && !chord(command.hotkey)) add('error', 'hotkey', 'Укажите корректное сочетание запуска.');
  } catch {
    add('error', 'hotkey', 'Некорректное сочетание запуска.');
  }
  if (
    command.hotkey &&
    (command.hotkey === 'CTRL+ALT+PAUSE' ||
      c.commands.some(other => other.id !== command.id && other.hotkey && other.hotkey === command.hotkey))
  )
    add(
      'error',
      'hotkey',
      'Сочетание занято командой или аварийной остановкой; ручной запуск не зависит от регистрации.'
    );
  if (command.needsConfiguration)
    add('error', 'configuration', 'После импорта откройте, проверьте и сохраните команду.');
  let blocks = [];
  try {
    if (command.action === 'pause') lines.push('Переключить служебную паузу / продолжение выполнения.');
    else blocks = commandBlocks(command, c);
    if (command.action === 'composite')
      compileComposition(command, { ...c, commands: [...c.commands.filter(row => row.id !== command.id), command] });
    const materialized = materializeUnifiedCommand({ ...command, blocks });
    validateActivityCommand(materialized);
  } catch (error) {
    add('error', 'blocks', error.message || 'Проверьте действия команды.');
  }
  for (const [index, block] of blocks.entries()) {
    const partyId = block.partyId || command.partyId || c.partyId;
    const members = block.scope === 'managed' ? state.characters : partyMembers(state, partyId),
      leader = c.leaders[partyId];
    const selected =
      block.target === 'leader'
        ? members.filter(char => char.id === leader)
        : block.target === 'others'
          ? members.filter(char => char.id !== leader)
          : block.target === 'subset'
            ? members.filter(char => block.charIds?.includes(char.id))
            : members;
    if (block.scope !== 'managed') {
      if (!members.length)
        add(
          command.strictTargets ? 'error' : 'warning',
          `block:${index}:partyId`,
          'Пати не выбрана или пуста. Получатели Windows ещё не проверены.'
        );
      if (['leader', 'others'].includes(block.target) && !members.some(char => char.id === leader))
        add('error', `block:${index}:target`, 'Для этих получателей назначьте ПЛ выбранной пати.');
      if (
        block.target === 'subset' &&
        (!block.charIds?.length || block.charIds.some(id => !members.some(char => char.id === id)))
      )
        add('error', `block:${index}:target`, 'Поднабор пуст или содержит отсутствующего участника пати.');
    }
    lines.push(
      `Группа ${index + 1}: ${block.scope === 'managed' && block.target === 'all' ? 'все распознанные окна (включая другие пати)' : selected.map(char => char.nick || char.id).join(' → ') || 'получатели ещё не определены'}. ${block.parallel ? 'Одновременно с предыдущей группой. ' : ''}Повторений: ${block.repeat ?? 1}. ${block.perWindow ? 'Все шаги в одном окне, затем следующее.' : 'Каждый шаг всем получателям, затем следующий шаг.'}`
    );
    lines.push(
      `Доставка: ${block.delivery === 'background' ? BACKGROUND_METHODS[block.backgroundMethod || 'post'] || 'неизвестный способ' : 'с активацией окна'}.`
    );
    for (const [stepIndex, step] of (block.steps || []).entries()) {
      const field = `block:${index}:step:${stepIndex}`;
      let text = '';
      switch (step.type) {
        case 'keys':
          try {
            if (!chord(step.value)) throw new Error();
          } catch {
            add('error', field, 'Введите клавишу или сочетание, например F8.');
          }
          text = `Клавиша ${step.value || 'не задана'}`;
          break;
        case 'wait':
          text = `Задержка ${step.ms} мс`;
          break;
        case 'point': {
          const point = c.points.find(p => p.id === step.pointId);
          if (!point) add('error', field, 'Сохранённая точка отсутствует.');
          for (const id of step.pointIds || [])
            if (!c.points.some(p => p.id === id)) add('error', field, 'Дополнительный шаблон точки отсутствует.');
          text = `${step.count === 2 ? 'Двойной' : 'Одинарный'} клик ${step.button || 'left'}: ${point ? `${point.name}, (${point.x}, ${point.y}), ${point.width}×${point.height}, DPI ${point.dpi}` : 'точка не задана'}`;
          break;
        }
        case 'screen':
          text = `${step.count === 2 ? 'Двойной' : 'Одинарный'} клик ${step.button || 'left'} в абсолютной точке (${step.x}, ${step.y})`;
          break;
        case 'repeat':
          text = `Повтор ${step.device === 'mouse' ? 'мыши' : 'клавиатуры'}: ${step.mode}. Режим остаётся после завершения команды`;
          add('warning', field, 'Переключение непрерывного повтора сохраняется после завершения команды.');
          break;
        case 'pause':
          text = 'Ждать кнопку «Продолжить»; «Стоп» отменит остаток';
          break;
        case 'focus':
          text = `Активировать окно: ${step.direction}`;
          break;
        case 'launch':
          text = `Запустить пати ${state.parties.find(p => p.id === step.partyId)?.name || step.partyId || 'не выбрана'}`;
          if (!state.parties.some(p => p.id === step.partyId)) add('error', field, 'Пати для запуска отсутствует.');
          break;
        case 'resize':
          text = `Изменить игровую область на ${step.width}×${step.height}`;
          break;
        case 'profile':
          text = `Применить профиль ${c.profiles.find(p => p.id === step.profileId)?.name || 'не найден'}`;
          if (!c.profiles.some(p => p.id === step.profileId)) add('error', field, 'Профиль размещения отсутствует.');
          break;
        case 'command': {
          const nested = c.commands.find(row => row.id === step.commandId);
          text = `Вложенная команда: ${nested?.name || 'не найдена'}`;
          if (!nested) add('error', field, 'Вложенная команда отсутствует.');
          else {
            const report = reviewCommand(nested, c, state, [...path, command.id]);
            for (const issue of report.issues) add(issue.severity, field, `${nested.name}: ${issue.message}`);
            lines.push(text, ...report.lines.slice(0, 60).map(line => `↳ ${line}`));
            text = 'Конец вложенной команды';
          }
          break;
        }
        default:
          add('error', field, 'Неизвестное действие.');
      }
      if (['point', 'screen'].includes(step.type)) {
        add('warning', field, 'Клик может потратить ресурсы; перед вводом нужен предпросмотр координат.');
        if (!command.resourceAllowed)
          add('error', 'resourceAllowed', 'Для кликов подтвердите разрешение координатных действий.');
      }
      lines.push(`${stepIndex + 1}. ${text}${step.modifiers?.length ? ' · ' + step.modifiers.join('+') : ''}`);
    }
  }
  if (command.delivery === 'background' || blocks.some(b => b.delivery === 'background'))
    add(
      'warning',
      'delivery',
      'Windows/API и журнал не подтверждают действие в игре. Автоматического перехода к активации нет.'
    );
  if (command.action === 'sequence')
    try {
      steps(command.sequence);
    } catch (error) {
      add('error', 'sequence', error.message);
    }
  if (
    !command.strictTargets &&
    command.action === 'sequence' &&
    command.scope !== 'managed' &&
    command.backgroundMethod !== 'hybrid-party'
  )
    add(
      'warning',
      'targets',
      'Эта команда использует прежние ограничения пати. Общий выбор персонажей дополнительно ограничивает получателей; при ошибке отправка не расширяется.'
    );
  lines.push(
    command.returnTo === 'leader'
      ? 'После команды: возврат к ПЛ явно выбранной пати.'
      : 'После команды: остаться на последнем окне; для фонового теста возврата фокуса нет.'
  );
  return {
    issues: issues.filter((v, i, a) => a.findIndex(x => x.field === v.field && x.message === v.message) === i),
    lines: lines.slice(0, 300)
  };
}
export function reviewHtml(review) {
  return `<div class="gm-review"><h4>Проверка настроек — без ввода</h4><p>Это план по сохранённым данным, не подтверждение готовности Windows или игры.</p><ul>${review.issues.map(issue => `<li class="gm-review-${issue.severity}">${issue.severity === 'error' ? '✕' : '!'} ${esc(issue.message)}</li>`).join('') || '<li>В настройках проблем не найдено. Окна и права будут проверены отдельно перед вводом.</li>'}</ul><ol>${review.lines.map(line => `<li>${esc(line)}</li>`).join('')}</ol></div>`;
}
