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
  'pause'
];
export function chord(value) {
  if (/^CTRL\+WHEEL(UP|DOWN)$/i.test(String(value))) return String(value).toUpperCase();
  const parts = String(value || '')
    .toUpperCase()
    .replace(/\s/g, '')
    .split('+');
  const key = parts.pop();
  if (!/^(F([1-9]|1[0-2])|[A-Z0-9]|LEFT|RIGHT|UP|DOWN|SPACE|ENTER|TAB|PAUSE|HOME)$/.test(key || '')) return '';
  if (parts.some(p => !['CTRL', 'ALT', 'SHIFT'].includes(p)) || new Set(parts).size !== parts.length) return '';
  return [...['CTRL', 'ALT', 'SHIFT'].filter(p => parts.includes(p)), key].join('+');
}
export function steps(text) {
  const rows = String(text || '')
    .split(/\n/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!rows.length || rows.length > 20) throw new Error('Нужно от 1 до 20 шагов.');
  return rows.map(row => {
    if (/^wait\s+\d+$/i.test(row)) {
      const ms = Number(row.split(/\s+/)[1]);
      if (ms < 50 || ms > 3000) throw new Error('Пауза — от 50 до 3000 мс.');
      return { wait: ms };
    }
    const key = chord(row);
    if (!key || key.includes('WHEEL'))
      throw new Error('Недопустимая клавиша. Пример: SHIFT+1, F7 или wait 200, каждый шаг с новой строки.');
    return { key };
  });
}
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
    commands.push({
      id: String(row.id).slice(0, 80),
      name: String(
        row.id === 'ahk-buff' && row.name === 'Баф — отдельная пати' ? 'Баф — выбранная пати' : row.name || 'Команда'
      ).slice(0, 80),
      action: row.action,
      delivery: row.delivery === 'background' ? 'background' : 'foreground',
      hotkey: chord(row.hotkey),
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
    sizeDefaultsVersion: 1,
    overlayPosition:
      input.overlayPosition &&
      ['x', 'y'].every(
        key => Number.isInteger(input.overlayPosition[key]) && Math.abs(input.overlayPosition[key]) < 100000
      )
        ? { x: input.overlayPosition.x, y: input.overlayPosition.y }
        : null,
    enabled: input.enabled === true,
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
export function resolveTargets(state, config, command, rows) {
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
          `Окно «${c.nick}» не распознано. Откройте список игровых окон и проверьте название «Ник — Класс», либо запустите этого персонажа через Твиноферму. При одинаковых никах управление недоступно.`
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
    return steps(command.sequence).every(step => step.wait || !step.key.includes('+'));
  } catch {
    return false;
  }
}
