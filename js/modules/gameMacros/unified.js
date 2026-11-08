import { isActivityMethod } from './background.js';
import { steps } from './keySyntax.js';

const keySteps = value =>
  steps(value).map(step => (step.wait ? { type: 'wait', ms: step.wait } : { type: 'keys', value: step.key }));
/** Editable snapshots, never references to exclusive commands. No automatic saved-data migration. */
export function commandBlocks(command, config) {
  if (command.action === 'composite') return structuredClone(command.blocks);
  const base = {
    name: command.name || 'Действия',
    scope: command.scope || 'party',
    target: command.target || 'all',
    partyId: command.partyId || '',
    charIds: command.charIds || [],
    delivery: command.delivery || 'foreground',
    backgroundMethod: command.backgroundMethod || 'post',
    repeat: 1,
    leaderSplit: command.scope === 'managed' && ['f6f1', 'optimize'].includes(command.action),
    parallel: false
  };
  const block = (steps, patch = {}) => ({ ...base, steps, ...patch });
  const mouse = { button: command.button || 'left', count: command.count || 1, modifiers: command.modifiers || [] };
  switch (command.action) {
    case 'sequence':
      return [block(keySteps(command.sequence || 'F8'), { perWindow: true })];
    case 'click':
      return [block([{ type: 'point', pointId: command.pointId || '', pointIds: command.pointIds || [], ...mouse }])];
    case 'follow':
      return [
        block(
          [
            ...(String(command.followSequence ?? 'SHIFT+1').trim()
              ? keySteps(command.followSequence ?? 'SHIFT+1')
              : []),
            { type: 'wait', ms: 80 },
            { type: 'point', pointId: command.pointId || '', button: command.followButton || 'right', count: 1 },
            { type: 'wait', ms: 120 },
            { type: 'point', pointId: command.menuPointId || '', button: command.followMenuButton || 'left', count: 1 }
          ],
          { perWindow: true, delivery: 'foreground' }
        )
      ];
    case 'f6f1':
      return [
        block([{ type: 'keys', value: 'F6' }], { name: 'Первый проход: кроме ПЛ', target: 'others' }),
        block([{ type: 'keys', value: 'F1' }], { name: 'Второй проход: всем', target: 'all' })
      ];
    case 'optimize':
      return [
        block([{ type: 'resize', width: config.leaderWidth, height: config.leaderHeight }], {
          name: 'Размер ПЛ',
          target: 'leader',
          delivery: 'foreground'
        }),
        block(
          [
            { type: 'keys', value: 'CTRL+F9' },
            { type: 'wait', ms: 150 },
            { type: 'resize', width: config.otherWidth, height: config.otherHeight }
          ],
          { name: 'Остальные окна', target: 'others', delivery: 'foreground', perWindow: true }
        )
      ];
    case 'next':
    case 'previous':
    case 'leader':
      return [block([{ type: 'focus', direction: command.action }], { delivery: 'foreground' })];
    case 'layout':
      return [block([{ type: 'profile', profileId: command.profileId || config.profileId || '' }])];
    case 'resize':
      return [block([{ type: 'resize', width: command.width, height: command.height }])];
    case 'launch':
      return [block([{ type: 'launch', partyId: command.partyId || config.partyId || '' }])];
    case 'mirror':
    case 'mouse-mirror':
      return [
        block([{ type: 'repeat', device: command.action === 'mirror' ? 'keyboard' : 'mouse', mode: 'toggle' }], {
          delivery: 'foreground'
        })
      ];
    default:
      throw new Error('Эта служебная команда не является конечным планом.');
  }
}
export function unifiedCommand(command, config) {
  return { ...command, action: 'composite', blocks: commandBlocks(command, config) };
}
/** Preserve isolated activity and compatible legacy keyboard routing behind the unified editor. */
export function materializeUnifiedCommand(entry) {
  if (entry.action !== 'composite') return entry;
  const activity = entry.blocks.some(b => b.delivery === 'background' && isActivityMethod(b.backgroundMethod));
  const [block] = entry.blocks;
  const simple =
    entry.blocks.length === 1 &&
    block.repeat === 1 &&
    !block.parallel &&
    block.steps.every(s => ['keys', 'wait'].includes(s.type));
  if (!activity && (!simple || !block.perWindow)) return entry;
  if (activity && !block.perWindow)
    throw new Error('Уведомления активности выполняют всю последовательность в каждом окне. Включите обход по окнам.');
  if (!simple)
    throw new Error('Уведомления активности: один блок клавиш и пауз, без повторений, мыши и управления окнами.');
  const sequence = block.steps.map(s => (s.type === 'keys' ? s.value : `wait ${s.ms}`)).join('\n');
  try {
    steps(sequence);
  } catch (error) {
    if (activity) throw error;
    return entry;
  }
  return { ...entry, ...block, id: entry.id, name: entry.name, action: 'sequence', sequence, blocks: [] };
}
