import { charactersInPartyOrdered } from '../parties/membership.js';
export const ACTIONS = ['next', 'previous', 'leader', 'sequence', 'layout'];
export function chord(value) {
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
    if (!key) throw new Error('Недопустимая клавиша. Пример: SHIFT+1, F7 или wait 200, каждый шаг с новой строки.');
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
  for (const row of (Array.isArray(input.commands) ? input.commands : []).slice(0, 30)) {
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
      name: String(row.name || 'Команда').slice(0, 80),
      action: row.action,
      hotkey: chord(row.hotkey),
      target: ['all', 'others', 'leader'].includes(row.target) ? row.target : 'others',
      sequence
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
  return {
    enabled: input.enabled === true,
    partyId: String(input.partyId || '').slice(0, 200),
    leaders,
    commands,
    profiles,
    profileId: String(input.profileId || '').slice(0, 80),
    opacity: Math.max(0.3, Math.min(1, Number(input.opacity) || 0.9)),
    topmost: input.topmost !== false
  };
}
export function partyMembers(state, partyId) {
  return charactersInPartyOrdered(state.characters, partyId);
}
export function resolveTargets(state, config, command, rows) {
  const members = partyMembers(state, config.partyId);
  if (!members.length) throw new Error('Выберите непустую пати.');
  const leader = config.leaders[config.partyId];
  if ((command.target !== 'all' || command.action === 'leader') && !members.some(c => c.id === leader))
    throw new Error('В настройках пати назначьте ПЛ.');
  const targets = members
    .filter(c =>
      command.action === 'leader' || command.target === 'leader'
        ? c.id === leader
        : command.target === 'others'
          ? c.id !== leader
          : true
    )
    .map(c => {
      const matches = rows.filter(r => r.known && r.charId === c.id && r.startedAt && r.hwnd && r.elevated === false);
      if (matches.length !== 1)
        throw new Error(
          `Нет однозначно привязанного доступного окна: ${c.nick}. Окна от администратора не управляются.`
        );
      return { ...matches[0], nick: c.nick, charId: c.id };
    });
  if (!targets.length) throw new Error('Нет получателей.');
  return targets;
}
