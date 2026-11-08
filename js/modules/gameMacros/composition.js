import { backgroundMethod } from './background.js';
import { chord, steps } from './keySyntax.js';
const text = (v, max = 200) => String(v || '').slice(0, max);
const integer = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: допустимо ${min}–${max}.`);
  return n;
};
export const STEP_LABELS = {
  keys: 'Клавиша / сочетание',
  wait: 'Задержка',
  command: 'Существующая команда',
  point: 'Именованный клик / двойной клик',
  screen: 'Клик в экранной точке',
  profile: 'Профиль размещения',
  resize: 'Размер игровой области',
  launch: 'Запуск выбранной пати',
  focus: 'Следующее / предыдущее окно / ПЛ',
  repeat: 'Режим повтора ввода',
  pause: 'Пауза до продолжения'
};
export function normalizeComposition(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8) throw new Error('Нужно 1–8 блоков.');
  let total = 0;
  return value.map((block, i) => {
    if (!block || !Array.isArray(block.steps) || !block.steps.length || block.steps.length > 64)
      throw new Error(`Блок ${i + 1}: нужно 1–64 действия.`);
    if (i === 0 && block.parallel) throw new Error('Первый блок не может быть параллельным предыдущему.');
    if (block.perWindow && block.steps.some(s => !['keys', 'wait', 'point', 'screen', 'resize'].includes(s?.type)))
      throw new Error(
        'Обход по окнам поддерживает клавиши, клики, размеры и паузы; управление пати/повтором вынесите в отдельный блок.'
      );
    return {
      perWindow: block.perWindow === true,
      leaderSplit: block.leaderSplit === true,
      name: text(block.name || `Блок ${i + 1}`, 80),
      parallel: block.parallel === true,
      repeat: integer(block.repeat ?? 1, 1, 100, 'Повторений блока'),
      scope: block.scope === 'managed' ? 'managed' : 'party',
      partyId: text(block.partyId),
      target: ['all', 'leader', 'others', 'subset'].includes(block.target) ? block.target : 'all',
      charIds: [
        ...new Set((Array.isArray(block.charIds) ? block.charIds : []).filter(id => typeof id === 'string'))
      ].slice(0, 30),
      backgroundMethod: backgroundMethod(block.backgroundMethod),
      delivery: block.delivery === 'background' ? 'background' : 'foreground',
      steps: block.steps.map(step => {
        if (++total > 128) throw new Error('Не более 128 действий в плане.');
        if (!step || !Object.hasOwn(STEP_LABELS, step.type)) throw new Error('Неизвестный тип действия.');
        const base = { type: step.type };
        switch (step.type) {
          case 'keys': {
            const value = chord(step.value);
            if (!value || value.includes('WHEEL')) throw new Error('Укажите клавишу, например SHIFT+1.');
            return { ...base, value };
          }
          case 'wait':
            return { ...base, ms: integer(step.ms, 0, 10000, 'Задержка, мс') };
          case 'command':
            if (!step.commandId) throw new Error('Выберите существующую команду.');
            return { ...base, commandId: text(step.commandId, 80) };
          case 'repeat':
            if (!['keyboard', 'mouse'].includes(step.device) || !['on', 'off', 'toggle'].includes(step.mode))
              throw new Error('Выберите режим повтора.');
            return { ...base, device: step.device, mode: step.mode };
          case 'point':
            if (!step.pointId) throw new Error('Выберите именованную точку.');
            return {
              ...base,
              pointId: text(step.pointId, 80),
              ...(step.pointIds?.length
                ? { pointIds: [...new Set(step.pointIds.filter(id => typeof id === 'string'))].slice(0, 30) }
                : {}),
              ...mouse(step)
            };
          case 'screen':
            return {
              ...base,
              x: integer(step.x, -100000, 100000, 'Экран X'),
              y: integer(step.y, -100000, 100000, 'Экран Y'),
              ...mouse(step)
            };
          case 'profile':
            if (!step.profileId) throw new Error('Выберите профиль.');
            return { ...base, profileId: text(step.profileId, 80) };
          case 'resize':
            return {
              ...base,
              width: integer(step.width, 160, 8000, 'Ширина'),
              height: integer(step.height, 160, 8000, 'Высота')
            };
          case 'launch':
            if (!step.partyId) throw new Error('Выберите пати для запуска.');
            return { ...base, partyId: text(step.partyId) };
          case 'focus':
            return {
              ...base,
              direction: ['next', 'previous', 'leader'].includes(step.direction) ? step.direction : 'leader'
            };
          default:
            return base;
        }
      })
    };
  });
}
function mouse(step) {
  if (!['left', 'right', 'middle', 'x1', 'x2'].includes(step.button)) throw new Error('Выберите кнопку мыши.');
  return {
    button: step.button,
    count: step.count === 2 ? 2 : 1,
    modifiers: [
      ...new Set(
        (Array.isArray(step.modifiers) ? step.modifiers : []).filter(v => ['CTRL', 'SHIFT', 'ALT'].includes(v))
      )
    ]
  };
}
/** Fully expand references before execution. No eval, arbitrary code, or unbounded graph. */
export function compileComposition(command, config) {
  let count = 0,
    totalWait = 0;
  const refs = new Map(config.commands.map(c => [c.id, c]));
  const expand = (cmd, path = []) => {
    if (path.includes(cmd.id) || path.length >= 4) throw new Error('Цикл команд или вложенность более 4.');
    if (cmd.action !== 'composite') {
      if (['mirror', 'mouse-mirror', 'pause'].includes(cmd.action))
        throw new Error('Переключатели повтора/паузы нельзя вставлять как ссылку: используйте отдельный шаг паузы.');
      if (['click', 'follow'].includes(cmd.action) && !command.resourceAllowed)
        throw new Error('Разрешите клики для всей составной команды.');
      const followSequence = String(cmd.followSequence ?? 'SHIFT+1').trim();
      const nested =
        cmd.action === 'sequence'
          ? steps(cmd.sequence)
          : cmd.action === 'follow' && followSequence
            ? steps(followSequence)
            : [];
      count += cmd.action === 'follow' ? nested.length + 2 : Math.max(1, nested.length);
      totalWait += nested.reduce((n, s) => n + (s.wait || 0), 0);
      if (count > 256 || totalWait > 120000) throw new Error('Вставленные команды превышают предел действий/пауз.');
      return { kind: 'action', command: cmd };
    }
    if (cmd.planError) throw new Error(cmd.planError);
    const groups = [];
    let lanes = [];
    for (const block of normalizeComposition(cmd.blocks)) {
      if (!block.parallel && lanes.length) {
        groups.push({ kind: 'parallel', children: lanes });
        lanes = [];
      }
      const selector = {
        target: block.target,
        allowEmptyOthers: block.target === 'others',
        allowManagedLeaderSplit: block.leaderSplit,
        scope: block.scope,
        charIds: block.charIds,
        partyId: block.partyId,
        delivery: block.delivery,
        backgroundMethod: block.backgroundMethod,
        resourceAllowed: cmd.resourceAllowed
      };
      const nodes = Array.from({ length: block.repeat }, () =>
        block.steps.map(step => {
          if (++count > 256) throw new Error('После вставки команд получилось более 256 действий.');
          if (step.type === 'wait') {
            totalWait += step.ms;
            if (totalWait > 120000) throw new Error('Сумма пауз превышает 120 секунд.');
            return { kind: 'wait', ms: step.ms };
          }
          if (step.type === 'pause') return { kind: 'pause' };
          if (step.type === 'command') {
            const ref = refs.get(step.commandId);
            if (!ref) throw new Error(`Команда ${step.commandId} удалена. Выберите замену.`);
            return expand(ref, [...path, cmd.id]);
          }
          if (step.type === 'point' && !config.points.some(p => p.id === step.pointId))
            throw new Error('Именованная точка удалена.');
          if (step.type === 'profile' && !config.profiles.some(p => p.id === step.profileId))
            throw new Error('Профиль размещения удалён.');
          if (['point', 'screen'].includes(step.type) && !cmd.resourceAllowed)
            throw new Error('Разрешите координатные действия для составной команды.');
          const mapping = {
            keys: { action: 'sequence', sequence: step.value },
            point: {
              action: 'click',
              pointId: step.pointId,
              pointIds: step.pointIds || [],
              button: step.button,
              count: step.count,
              modifiers: step.modifiers
            },
            screen: {
              action: 'screen',
              x: step.x,
              y: step.y,
              button: step.button,
              count: step.count,
              modifiers: step.modifiers
            },
            profile: { action: 'layout', profileId: step.profileId },
            resize: { action: 'resize', width: step.width, height: step.height },
            launch: { action: 'launch', partyId: step.partyId },
            repeat: { action: 'repeat-mode', device: step.device, mode: step.mode },
            focus: { action: step.direction }
          };
          return {
            kind: 'action',
            command: {
              ...selector,
              ...mapping[step.type],
              id: `${cmd.id}:${count}`,
              name: `${block.name}: ${STEP_LABELS[step.type]}`
            }
          };
        })
      ).flat();
      lanes.push(
        block.perWindow ? { kind: 'per-window', selector, children: nodes } : { kind: 'serial', children: nodes }
      );
      if (lanes.length > 4) throw new Error('Не более 4 параллельных блоков.');
    }
    if (lanes.length) groups.push({ kind: 'parallel', children: lanes });
    return { kind: 'serial', children: groups };
  };
  return expand(command);
}
/** Only actions share the input lock. Waits in independent branches overlap. */
export async function executeComposition(tree, { action, wait, checkpoint, pause, targets }) {
  let tail = Promise.resolve();
  let failed = false;
  const visit = async (node, target) => {
    if (failed) throw new Error('Параллельный блок остановлен.');
    await checkpoint(() => failed);
    if (node.kind === 'wait') {
      for (let left = node.ms; left > 0; left -= 50) {
        if (failed) throw new Error('Параллельный блок остановлен.');
        await checkpoint(() => failed);
        await wait(Math.min(50, left), () => failed);
      }
      return;
    }
    if (node.kind === 'pause') {
      await pause();
      return checkpoint(() => failed);
    }
    if (node.kind === 'action') {
      const job = tail.then(async () => {
        if (failed) throw new Error('Параллельный блок остановлен.');
        await checkpoint(() => failed);
        return action(node.command, target);
      });
      tail = job.catch(() => {});
      try {
        return await job;
      } catch (error) {
        failed = true;
        throw error;
      }
    }
    if (node.kind === 'per-window') {
      if (!targets) throw new Error('Обход окон недоступен.');
      let rows;
      try {
        rows = await targets(node.selector);
      } catch (error) {
        failed = true;
        throw error;
      }
      for (const row of rows) for (const child of node.children) await visit(child, row);
      return;
    }
    if (node.kind === 'serial') {
      for (const child of node.children) await visit(child, target);
      return;
    }
    const results = await Promise.allSettled(node.children.map(child => visit(child, target)));
    const failure = results.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
  };
  await visit(tree);
}
export function compositionActions(tree) {
  return tree.kind === 'action' ? [tree.command] : (tree.children || []).flatMap(compositionActions);
}
