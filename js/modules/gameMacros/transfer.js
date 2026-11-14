import { normalizeGameMacros } from './model.js';
import { BACKGROUND_METHODS } from './background.js';
export function exportCommands(c, includeCoordinates = false) {
  const normalized = normalizeGameMacros({
    commands: c.commands,
    points: includeCoordinates ? c.points : [],
    profiles: includeCoordinates ? c.profiles : []
  });
  return JSON.stringify(
    {
      kind: 'tvinoferma-macros',
      schema: 1,
      commands: normalized.commands,
      points: normalized.points,
      profiles: normalized.profiles
    },
    null,
    2
  );
}
export function importCommandPlan(text, c, mode = 'copy', makeId = () => crypto.randomUUID()) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 512000)
    throw new Error('Файл должен быть меньше 500 КБ.');
  const raw = JSON.parse(text);
  if (
    raw?.kind !== 'tvinoferma-macros' ||
    raw.schema !== 1 ||
    !Array.isArray(raw.commands) ||
    raw.commands.length > 64 ||
    !raw.commands.length
  )
    throw new Error('Неизвестный формат или число команд вне 1–64.');
  if (!['copy', 'replace'].includes(mode)) throw new Error('Выберите копирование или явную замену.');
  if (new Set(raw.commands.map(row => row?.id)).size !== raw.commands.length)
    throw new Error('В файле повторяются идентификаторы команд.');
  if (
    (raw.points !== undefined && (!Array.isArray(raw.points) || raw.points.length > 30)) ||
    (raw.profiles !== undefined && (!Array.isArray(raw.profiles) || raw.profiles.length > 10))
  )
    throw new Error('Слишком много точек или профилей.');
  for (const row of raw.commands) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') throw new Error('Некорректная команда.');
    if (row.backgroundMethod && !Object.hasOwn(BACKGROUND_METHODS, row.backgroundMethod))
      throw new Error('Неизвестный фоновый способ.');
    if (row.target && !['all', 'leader', 'others', 'subset'].includes(row.target))
      throw new Error('Неизвестные получатели.');
    if (row.delivery && !['foreground', 'background'].includes(row.delivery)) throw new Error('Неизвестная доставка.');
  }
  const normalized = normalizeGameMacros(raw);
  if (normalized.commands.length !== raw.commands.length || normalized.commands.some(row => row.planError))
    throw new Error('Файл содержит некорректные команды или шаги.');
  const commandMap = new Map(),
    pointMap = new Map(),
    profileMap = new Map();
  const commands = [...c.commands],
    points = [...c.points],
    profiles = [...c.profiles],
    changes = [];
  for (const row of normalized.commands) {
    const matches = c.commands.filter(old => old.name === row.name);
    if (mode === 'replace' && matches.length > 1)
      throw new Error(`Название «${row.name}» неоднозначно: используйте копирование.`);
    commandMap.set(row.id, mode === 'replace' && matches.length === 1 ? matches[0].id : makeId());
  }
  for (const point of normalized.points) {
    const id = makeId();
    pointMap.set(point.id, id);
    points.push({ ...point, id });
  }
  for (const profile of normalized.profiles) {
    const id = makeId();
    profileMap.set(profile.id, id);
    profiles.push({ ...profile, id });
  }
  for (const row of normalized.commands) {
    const id = commandMap.get(row.id),
      replacing = commands.some(old => old.id === id);
    let name = row.name;
    if (!replacing) {
      let counter = 1;
      while (commands.some(old => old.name === name)) name = `${row.name.slice(0, 65)} (копия ${counter++})`;
    }
    const next = {
      ...row,
      id,
      name,
      hotkey: '',
      resourceAllowed: false,
      strictTargets: true,
      needsConfiguration: true,
      pointId: pointMap.get(row.pointId) || 'missing-import-point',
      pointIds: row.pointIds.map(p => pointMap.get(p) || 'missing-import-point'),
      profileId: profileMap.get(row.profileId) || 'missing-import-profile',
      blocks: row.blocks.map(block => ({
        ...block,
        steps: block.steps.map(step => ({
          ...step,
          ...(step.type === 'command' ? { commandId: commandMap.get(step.commandId) || step.commandId } : {}),
          ...(step.type === 'point'
            ? {
                pointId: pointMap.get(step.pointId) || 'missing-import-point',
                pointIds: (step.pointIds || []).map(p => pointMap.get(p) || 'missing-import-point')
              }
            : {}),
          ...(step.type === 'profile' ? { profileId: profileMap.get(step.profileId) || 'missing-import-profile' } : {}),
          ...(step.type === 'command' && !commandMap.has(step.commandId)
            ? { commandId: 'missing-import-reference' }
            : {})
        }))
      }))
    };
    if (replacing)
      commands.splice(
        commands.findIndex(old => old.id === id),
        1,
        next
      );
    else commands.push(next);
    changes.push({
      name,
      mode: replacing ? 'Заменить' : 'Добавить',
      warnings: [
        'Сочетание и согласие на клики сброшены.',
        'Перед запуском откройте, проверьте получателей и сохраните команду.',
        'Координаты, DPI и локальные ID пати/персонажей могут отличаться.'
      ]
    });
  }
  if (commands.length > 64 || points.length > 30 || profiles.length > 10)
    throw new Error('После импорта превышен лимит команд/точек/профилей.');
  return { patch: { commands, points, profiles }, changes };
}
export function deleteCommandPlan(c, id) {
  const command = c.commands.find(row => row.id === id);
  if (!command) throw new Error('Команда уже отсутствует.');
  return {
    commands: c.commands.filter(row => row.id !== id),
    deletedCommands: [...(c.deletedCommands || []), { command, deletedAt: new Date().toISOString() }].slice(-5)
  };
}
export function restoreDeletedCommand(c, makeId = () => crypto.randomUUID()) {
  const entry = c.deletedCommands?.at(-1);
  if (!entry) throw new Error('Нет удалённой команды для восстановления.');
  if (c.commands.length >= 64) throw new Error('Нет места для восстановления.');
  const command = { ...entry.command };
  if (c.commands.some(row => row.id === command.id)) {
    command.id = makeId();
    command.name = `${command.name.slice(0, 60)} (восстановлено)`;
  }
  if (command.hotkey && c.commands.some(row => row.hotkey === command.hotkey)) command.hotkey = '';
  return { commands: [...c.commands, command], deletedCommands: c.deletedCommands.slice(0, -1) };
}
