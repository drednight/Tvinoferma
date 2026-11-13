import { normalizeTrials } from './trialRecords.js';
import { normalizeLabResults } from './labResults.js';
import { backgroundMethod } from './background.js';
import { chord, steps } from './keySyntax.js';
export { chord, steps } from './keySyntax.js';
import { normalizeComposition } from './composition.js';
import { normalizeAppearance } from './appearance.js';
import { charactersInPartyOrdered } from '../parties/membership.js';
export const ACTIONS = [
  'next',
  'previous',
  'leader',
  'sequence',
  'layout',
  'click',
  'follow',
  'f6f1',
  'optimize',
  'launch',
  'pause',
  'mirror',
  'mouse-mirror',
  'composite',
  'resize'
];
export function normalizeGameMacros(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const leaders = Object.create(null);
  if (input.leaders && typeof input.leaders === 'object') {
    for (const [id, value] of Object.entries(input.leaders).slice(0, 200)) {
      if (typeof value === 'string' && id.length < 200 && value.length < 200) leaders[id] = value;
    }
  }
  const commands = [];
  for (const row of (Array.isArray(input.commands) ? input.commands : []).slice(0, 64)) {
    if (!row || !ACTIONS.includes(row.action) || !row.id || commands.some(c => c.id === row.id)) continue;
    let sequence;
    try {
      sequence = steps(row.sequence || 'F8')
        .map(s => s.key || `wait ${s.wait}`)
        .join('\n');
    } catch {
      continue;
    }
    let blocks = [],
      planError = '';
    if (row.action === 'composite') {
      try {
        blocks = normalizeComposition(row.blocks);
      } catch (error) {
        planError = error.message;
      }
    }
    commands.push({
      id: String(row.id).slice(0, 80),
      name: String(
        row.id === 'ahk-buff' && row.name === 'Баф — отдельная пати' ? 'Баф — выбранная пати' : row.name || 'Команда'
      ).slice(0, 80),
      action: row.action,
      strictTargets: row.strictTargets === true,
      needsConfiguration: row.needsConfiguration === true,
      blocks,
      planError,
      partyId: String(row.partyId || '').slice(0, 200),
      profileId: String(row.profileId || '').slice(0, 80),
      button: ['left', 'right', 'middle', 'x1', 'x2'].includes(row.button) ? row.button : 'left',
      count: row.count === 2 ? 2 : 1,
      width: size(row.width, 2560),
      height: size(row.height, 1400),
      returnTo: ['last', 'leader'].includes(row.returnTo)
        ? row.returnTo
        : ['sequence', 'follow', 'click', 'f6f1', 'optimize'].includes(row.action)
          ? 'leader'
          : 'last',
      switchMs: Math.max(0, Math.min(500, Math.round(Number(row.switchMs ?? 30)) || 0)),
      holdMs: Math.max(10, Math.min(200, Math.round(Number(row.holdMs ?? 30)) || 30)),
      hybridConsent: row.hybridConsent === true,
      backgroundMethod: backgroundMethod(row.backgroundMethod),
      delivery: row.delivery === 'background' ? 'background' : 'foreground',
      hotkey: chord(row.hotkey),
      allowManagedLeaderSplit: row.allowManagedLeaderSplit === true,
      allowManagedSubset: row.allowManagedSubset === true,
      target: ['all', 'others', 'leader', 'subset'].includes(row.target) ? row.target : 'others',
      sequence,
      charIds: [...new Set((Array.isArray(row.charIds) ? row.charIds : []).filter(id => typeof id === 'string'))].slice(
        0,
        30
      ),
      pointId: String(row.pointId || '').slice(0, 80),
      resourceAllowed: row.resourceAllowed === true,
      scope: row.scope === 'managed' ? 'managed' : 'party',
      pointIds: [
        ...new Set((Array.isArray(row.pointIds) ? row.pointIds : []).filter(id => typeof id === 'string'))
      ].slice(0, 30),
      followSequence: String(row.followSequence ?? 'SHIFT+1').slice(0, 1000),
      followButton: ['left', 'right'].includes(row.followButton) ? row.followButton : 'right',
      followMenuButton: ['left', 'right'].includes(row.followMenuButton) ? row.followMenuButton : 'left',
      menuPointId: String(row.menuPointId || '').slice(0, 80)
    });
  }
  const profiles = [];
  for (const p of (Array.isArray(input.profiles) ? input.profiles : []).slice(0, 10)) {
    if (!p || !p.id || !Array.isArray(p.windows)) continue;
    const windows = p.windows
      .slice(0, 30)
      .filter(
        w =>
          w &&
          typeof w.charId === 'string' &&
          ['x', 'y', 'width', 'height'].every(k => Number.isFinite(w[k])) &&
          w.width >= 160 &&
          w.width <= 8000 &&
          w.height >= 120 &&
          w.height <= 8000 &&
          Math.abs(w.x) < 40000 &&
          Math.abs(w.y) < 40000
      );
    profiles.push({ id: String(p.id).slice(0, 80), name: String(p.name || 'Профиль').slice(0, 80), windows });
  }
  const legacySizes =
    input.sizeDefaultsVersion !== 1 &&
    input.leaderWidth === 3440 &&
    input.leaderHeight === 1440 &&
    input.otherWidth === 1920 &&
    input.otherHeight === 1200;
  return {
    backgroundTrials: normalizeTrials(input.backgroundTrials),
    labResults: normalizeLabResults(input.labResults),
    deletedCommands: (Array.isArray(input.deletedCommands) ? input.deletedCommands : []).slice(-5).flatMap(entry => {
      const command = entry?.command && normalizeGameMacros({ commands: [entry.command] }).commands[0];
      return command ? [{ command, deletedAt: String(entry.deletedAt || '').slice(0, 40) }] : [];
    }),
    sizeDefaultsVersion: 1,
    overlayPosition:
      input.overlayPosition &&
      ['x', 'y'].every(
        key => Number.isInteger(input.overlayPosition[key]) && Math.abs(input.overlayPosition[key]) < 100000
      )
        ? { x: input.overlayPosition.x, y: input.overlayPosition.y }
        : null,
    excludedCommandCharacters: [
      ...new Set(
        (Array.isArray(input.excludedCommandCharacters) ? input.excludedCommandCharacters : []).filter(
          id => typeof id === 'string' && id.length <= 200
        )
      )
    ].slice(0, 200),
    enabled: input.enabled === true,
    mirrorMouse: input.mirrorMouse === true,
    mirrorKeyboardMethod: ['combined', 'activity-notify'].includes(input.mirrorKeyboardMethod)
      ? input.mirrorKeyboardMethod
      : 'post',
    mirrorHoldOnly: input.mirrorHoldOnly === true,
    mirrorKeyboardSource: ['any', 'leader'].includes(input.mirrorKeyboardSource)
      ? input.mirrorKeyboardSource
      : 'shared',
    mirrorKeyboardTargets: ['party', 'others', 'leader'].includes(input.mirrorKeyboardTargets)
      ? input.mirrorKeyboardTargets
      : 'all',
    mirrorActiveModifier: [
      '',
      'CTRL',
      'ALT',
      'SHIFT',
      'CTRL+ALT',
      'CTRL+SHIFT',
      'ALT+SHIFT',
      'CTRL+ALT+SHIFT'
    ].includes(input.mirrorActiveModifier)
      ? input.mirrorActiveModifier
      : '',
    mirrorTwinsModifier: ['', 'CTRL', 'ALT', 'SHIFT', 'CTRL+ALT', 'CTRL+SHIFT', 'ALT+SHIFT', 'CTRL+ALT+SHIFT'].includes(
      input.mirrorTwinsModifier
    )
      ? input.mirrorTwinsModifier
      : '',
    mirrorSource: input.mirrorSource === 'leader' ? 'leader' : 'any',
    mirrorPresetVersion: [1, 2].includes(input.mirrorPresetVersion) ? input.mirrorPresetVersion : 0,
    ahkPresetsVersion: input.ahkPresetsVersion === 1 ? 1 : 0,
    buffPartyId: String(input.partyId || '').slice(0, 200),
    leaderWidth: size(legacySizes ? undefined : input.leaderWidth, 2560),
    leaderHeight: size(legacySizes ? undefined : input.leaderHeight, 1400),
    otherWidth: size(legacySizes ? undefined : input.otherWidth, 2560),
    otherHeight: size(legacySizes ? undefined : input.otherHeight, 1400),
    partyId: String(input.partyId || '').slice(0, 200),
    leaders,
    commands,
    profiles,
    points: (Array.isArray(input.points) ? input.points : [])
      .filter(validPoint)
      .slice(0, 30)
      .map(p => ({
        id: String(p.id).slice(0, 80),
        name: String(p.name || 'Точка').slice(0, 80),
        uiScale: String(p.uiScale || '').slice(0, 40),
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        dpi: p.dpi
      })),
    profileId: String(input.profileId || '').slice(0, 80),
    opacity: Math.max(0.1, Math.min(1, Number(input.opacity) || 0.9)),
    appearance: normalizeAppearance(input.appearance),
    topmost: input.topmost !== false
  };
}
export function partyMembers(state, partyId) {
  return charactersInPartyOrdered(state.characters, partyId);
}
export function resolveTargets(state, config, command, rows, excluded = new Set()) {
  if (!['all', 'others', 'leader', 'subset'].includes(command.target)) throw new Error('Укажите получателей явно.');
  const members = partyMembers(state, config.partyId);
  if (!members.length) throw new Error('Выберите непустую пати.');
  const leader = config.leaders[config.partyId];
  if (
    (['leader', 'others'].includes(command.target) || command.action === 'leader') &&
    !members.some(c => c.id === leader)
  )
    throw new Error('В настройках пати назначьте ПЛ.');
  if (
    command.target === 'subset' &&
    (!command.charIds?.length || command.charIds.some(id => !members.some(c => c.id === id)))
  )
    throw new Error('Выберите действующих участников пати.');
  const targets = members
    .filter(c =>
      command.action === 'leader' || command.target === 'leader'
        ? c.id === leader
        : command.target === 'others'
          ? c.id !== leader
          : command.target === 'subset'
            ? command.charIds.includes(c.id)
            : true
    )
    .filter(c => !excluded.has(c.id))
    .map(c => {
      const candidates = rows.filter(r => r.known && r.charId === c.id);
      const matches = candidates.filter(
        r => r.startedAt && r.hwnd && (r.elevated === false || (r.elevated === true && r.selfElevated === true))
      );
      if (matches.length !== 1 || candidates.length !== 1) {
        if (candidates.some(r => r.elevated === true))
          throw new Error(
            `Окно «${c.nick}» запущено от администратора, а Твиноферма — без этих прав. Запустите саму Твиноферму от администратора через стандартный запрос Windows.`
          );
        if (candidates.length > 1)
          throw new Error(
            `Найдено несколько окон «${c.nick}». Закройте лишнее окно или исправьте его название через «Названия и значки».`
          );
        if (candidates.length)
          throw new Error(
            `Не удалось проверить процесс окна «${c.nick}» (права, время запуска или дескриптор окна). Перезапустите клиент обычным способом.`
          );
        throw new Error(
          `Окно «${c.nick}» не распознано. Откройте список игровых окон и проверьте название «Ник — Класс». При одинаковых никах определите нужное окно и привяжите его к персонажу вручную.`
        );
      }
      return { ...matches[0], nick: c.nick, charId: c.id };
    });
  if (!targets.length) throw new Error('Нет получателей.');
  return targets;
}

export function validPoint(p) {
  return (
    !!p &&
    typeof p.id === 'string' &&
    !!p.id &&
    typeof p.uiScale === 'string' &&
    !!p.uiScale.trim() &&
    ['x', 'y', 'width', 'height', 'dpi'].every(k => Number.isInteger(p[k])) &&
    p.width >= 160 &&
    p.width <= 8000 &&
    p.height >= 120 &&
    p.height <= 8000 &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < p.width &&
    p.y < p.height &&
    p.dpi >= 48 &&
    p.dpi <= 768
  );
}
export function commandPoint(c, command, authorize = true) {
  const point = c.points.find(p => p.id === command.pointId);
  if (!validPoint(point)) throw new Error('Выберите откалиброванную точку.');
  if (authorize && !command.resourceAllowed)
    throw new Error(
      'В редакторе команды выберите точку и отметьте «Разрешаю координатный клик». Такой клик может потратить свиток или другой игровой ресурс.'
    );
  return point;
}

function size(value, fallback) {
  return Number.isInteger(value) && value >= 160 && value <= 8000 ? value : fallback;
}

/** Background window messages cannot reliably synthesize modifier state for a game. */
export function backgroundCompatible(command) {
  if (command.action === 'f6f1') return true;
  if (command.action !== 'sequence') return false;
  try {
    return steps(command.sequence).every(step => step.wait || !!step.key);
  } catch {
    return false;
  }
}

// Global routes start with the selected party's persisted order, never OS enumeration order.
export function orderManagedTargets(state, config, rows) {
  const ids = [
    ...new Set(
      [config.partyId, ...(state.parties || []).map(p => p.id)].flatMap(id => partyMembers(state, id).map(c => c.id))
    )
  ];
  const rank = new Map(ids.map((id, i) => [id, i]));
  const chars = new Map(state.characters.map(c => [c.id, c]));
  return [...rows].sort(
    (a, b) =>
      (rank.get(a.charId) ?? ids.length) - (rank.get(b.charId) ?? ids.length) ||
      String(chars.get(a.charId)?.nick || a.charId).localeCompare(
        String(chars.get(b.charId)?.nick || b.charId),
        'ru'
      ) ||
      String(a.charId).localeCompare(String(b.charId))
  );
}

export const commandVisible = command => !['resize', 'layout'].includes(command.action);
