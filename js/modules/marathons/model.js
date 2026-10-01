// js/modules/marathons/model.js
// Модель марафона v2: миграция старых данных, расчёт прогресса, запаса дней и наград.
// Ничего не рендерит и не сохраняет — только чистые функции над объектами марафона.

import { getAllDatesInRange, isTaskActiveOnDate } from './dates.js';

export const SCHEMA_VERSION = 2;

export const STATUS_LABELS = {
  active: 'Идёт',
  ended: 'Ждёт завершения',
  completed: 'Завершён',
  upcoming: 'Скоро'
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const todayStr = () => new Date().toLocaleDateString('sv');

/* ------------------------------------------------------------------ */
/*  Создание и миграция                                                */
/* ------------------------------------------------------------------ */

export function createTask(partial = {}) {
  return {
    id: partial.id || uid(),
    title: partial.title || 'Новое задание',
    siteTitle: partial.siteTitle || null,          // точное название задания на сайте (для сверки)
    description: partial.description || '',
    targetChecks: Math.max(1, Number(partial.targetChecks) || 1),
    schedule: {
      mode: partial.schedule?.mode || 'everyDay',
      dates: Array.isArray(partial.schedule?.dates) ? partial.schedule.dates : [],
      weekStartDay: Number(partial.schedule?.weekStartDay ?? 1)
    },
    // Награды: берётся максимальный достигнутый порог
    rewards: Array.isArray(partial.rewards)
      ? partial.rewards.map(r => ({
          id: r.id || uid(),
          threshold: Math.max(1, Number(r.threshold) || 1),
          rewardText: String(r.rewardText || ''),
          rewardCoins: Math.max(0, Number(r.rewardCoins) || 0)
        }))
      : []
  };
}

export function createMarathon(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: partial.id || uid(),
    schemaVersion: SCHEMA_VERSION,
    kind: 'single',
    seriesId: partial.seriesId || null,
    title: partial.title || '',
    description: partial.description || '',
    source: {
      type: partial.source?.type || 'manual',      // site | template | manual
      url: partial.source?.url || null,
      siteName: partial.source?.siteName || null,
      stageKey: partial.source?.stageKey || null,
      stageName: partial.source?.stageName || null,
      templateId: partial.source?.templateId || null,
      newsUrl: partial.source?.newsUrl || null
    },
    // Бонусы за количество выполненных заданий (например, «Летний ларец» за 4 из 5)
    bonuses: Array.isArray(partial.bonuses)
      ? partial.bonuses.map(b => ({ id: b.id || uid(), needTasks: Math.max(1, Number(b.needTasks) || 1), text: String(b.text || '') }))
      : [],
    startDate: partial.startDate || todayStr(),
    endDate: partial.endDate || new Date(Date.now() + 30 * 864e5).toLocaleDateString('sv'),
    status: partial.status === 'completed' ? 'completed' : 'active',
    participantIds: Array.isArray(partial.participantIds) ? [...partial.participantIds] : [],
    assignments: partial.assignments ? JSON.parse(JSON.stringify(partial.assignments)) : {},
    tasks: Array.isArray(partial.tasks) ? partial.tasks.map(createTask) : [],
    progress: partial.progress || {},
    lastSync: partial.lastSync || null,
    balance: partial.balance || { start: {}, end: {} },
    awards: Array.isArray(partial.awards) ? partial.awards : [],
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
    completedAt: partial.completedAt || null
  };
}

export function createSeries(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: partial.id || uid(),
    schemaVersion: SCHEMA_VERSION,
    kind: 'series',
    title: partial.title || '',
    description: partial.description || '',
    source: { type: 'site', url: null, siteName: null, ...(partial.source || {}) },
    childIds: Array.isArray(partial.childIds) ? [...partial.childIds] : [],
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now
  };
}

/** Приводит марафон любой версии к схеме v2. Старые данные (records, stages, participantAssignments) конвертируются. */
export function migrateMarathon(m, characters = []) {
  if (!m || typeof m !== 'object') return null;
  if (m.schemaVersion === SCHEMA_VERSION) {
    return m.kind === 'series' ? createSeries(m) : createMarathon(m);
  }

  // --- задания: stages + base reward -> rewards ---
  const tasks = (m.tasks || []).map(t => {
    const rewards = (t.stages || []).map(s => ({
      threshold: s.threshold, rewardText: s.rewardText, rewardCoins: s.rewardCoins
    }));
    if (Number(t.baseRewardCoins) > 0 || t.baseRewardText) {
      rewards.push({ threshold: t.targetChecks, rewardText: t.baseRewardText || 'Выполнение', rewardCoins: t.baseRewardCoins });
    }
    return createTask({ ...t, siteTitle: m.type === 'auto-detected' ? t.title : null, rewards });
  });
  const allTaskIds = tasks.map(t => t.id);

  // --- назначения: пустой список раньше означал «все задания» ---
  const assignments = {};
  (m.participantIds || []).forEach(pid => {
    const list = m.participantAssignments?.[pid];
    assignments[pid] = Array.isArray(list) && list.length ? list.filter(id => allTaskIds.includes(id)) : [...allTaskIds];
  });

  // --- галочки по дням -> ручные отметки ---
  const progress = {};
  (m.records || []).forEach(r => {
    if (!r.completed) return;
    const cell = ensureCell(progress, r.characterId, r.taskId);
    if (!cell.marks.includes(String(r.date))) cell.marks.push(String(r.date));
  });

  // --- источник ---
  const urlFromDesc = /Источник:\s*(https?:\/\/\S+)/.exec(m.description || '')?.[1] || null;

  // --- старые награды завершённого марафона ---
  const awards = (m.awards || []).map(a => ({
    characterId: a.characterId || characters.find(c => c.nick === a.charNick)?.id || null,
    charNick: a.charNick || '',
    taskId: a.taskId || tasks.find(t => t.title === a.taskTitle)?.id || null,
    taskTitle: a.taskTitle || '',
    rewardText: a.description || a.rewardText || '',
    coins: Number(a.coins ?? a.rewardCoins) || 0
  }));

  return createMarathon({
    ...m,
    tasks,
    assignments,
    progress,
    awards,
    source: {
      type: m.type === 'auto-detected' ? 'site' : 'manual',
      url: m.sourceUrl || urlFromDesc
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Прогресс по ячейке «персонаж × задание»                            */
/* ------------------------------------------------------------------ */

export function ensureCell(progress, charId, taskId) {
  if (!progress[charId]) progress[charId] = {};
  if (!progress[charId][taskId]) {
    progress[charId][taskId] = { site: null, siteTotal: null, adjust: 0, marks: [], history: {}, syncedAt: null };
  }
  const c = progress[charId][taskId];
  c.marks = c.marks || []; c.history = c.history || {}; c.adjust = Number(c.adjust) || 0;
  return c;
}

export function getCellData(m, charId, taskId) {
  return m.progress?.[charId]?.[taskId] || null;
}

export function isAssigned(m, charId, taskId) {
  return m.participantIds.includes(charId) && (m.assignments?.[charId] || []).includes(taskId);
}

/** Сколько активных дней задания осталось начиная с сегодня (включительно). */
export function daysLeft(m, task, today = todayStr()) {
  const all = getAllDatesInRange(m.startDate, m.endDate);
  return all.filter(d => d >= today && isTaskActiveOnDate(task, d, all)).length;
}

export function totalActiveDays(m, task) {
  const all = getAllDatesInRange(m.startDate, m.endDate);
  return all.filter(d => isTaskActiveOnDate(task, d, all)).length;
}

/** Награда за текущее количество (максимальный достигнутый порог) и следующая цель. */
export function rewardFor(task, count) {
  const sorted = [...(task.rewards || [])].sort((a, b) => a.threshold - b.threshold);
  let reached = null, next = null;
  for (const r of sorted) {
    if (count >= r.threshold) reached = r;
    else { next = r; break; }
  }
  return { reached, next };
}

export function maxRewardCoins(task) {
  return Math.max(0, ...(task.rewards || []).map(r => Number(r.rewardCoins) || 0));
}

/**
 * Полный расчёт ячейки.
 * count = данные сайта + поправка; если сайта нет — отмеченные дни + поправка.
 * reserve = оставшиеся активные дни − оставшиеся выполнения.
 */
export function computeCell(m, charId, taskId, today = todayStr()) {
  const task = m.tasks.find(t => t.id === taskId);
  const assigned = isAssigned(m, charId, taskId);
  if (!task) return { assigned: false };
  const data = getCellData(m, charId, taskId);
  const target = Number(task.targetChecks) || 0;

  const hasSite = data && data.site !== null && data.site !== undefined;
  const base = hasSite ? Number(data.site) : (data?.marks?.length || 0);
  const adjust = Number(data?.adjust) || 0;
  const count = Math.max(0, base + adjust);
  const remaining = Math.max(0, target - count);
  const left = daysLeft(m, task, today);
  const reserve = left - remaining;
  const { reached, next } = rewardFor(task, count);

  let stateKey;
  if (!assigned) stateKey = 'off';
  else if (count >= target && target > 0) stateKey = 'done';
  else if (m.status === 'completed' || today > m.endDate) stateKey = 'fail';
  else if (today < m.startDate) stateKey = 'idle';
  else if (reserve < 0) stateKey = 'fail';
  else if (reserve <= 1) stateKey = 'warn';
  else stateKey = 'ok';

  return {
    assigned, task, target, count, base, adjust, hasSite, remaining, left, reserve,
    reached, next, coins: assigned && reached ? Number(reached.rewardCoins) || 0 : 0,
    state: stateKey, data,
    percent: target > 0 ? Math.min(100, Math.round((count / target) * 100)) : 0
  };
}

/* ------------------------------------------------------------------ */
/*  Итоги                                                              */
/* ------------------------------------------------------------------ */

export function marathonTotals(m) {
  let cells = 0, done = 0, coins = 0, maxCoins = 0, failing = 0;
  const perChar = {}, perTask = {};

  m.tasks.forEach(t => { perTask[t.id] = { coins: 0, done: 0, assigned: 0 }; });
  m.participantIds.forEach(cid => {
    perChar[cid] = { coins: 0, done: 0, assigned: 0 };
    m.tasks.forEach(t => {
      const c = computeCell(m, cid, t.id);
      if (!c.assigned) return;
      cells++; perChar[cid].assigned++; perTask[t.id].assigned++;
      maxCoins += maxRewardCoins(t);
      if (c.state === 'done') { done++; perChar[cid].done++; perTask[t.id].done++; }
      if (c.state === 'fail') failing++;
      coins += c.coins; perChar[cid].coins += c.coins; perTask[t.id].coins += c.coins;
    });
  });

  // Завершённый марафон: монеты берём из зафиксированных наград
  if (m.status === 'completed' && m.awards?.length) {
    coins = 0;
    Object.values(perChar).forEach(p => { p.coins = 0; });
    Object.values(perTask).forEach(p => { p.coins = 0; });
    m.awards.forEach(a => {
      coins += a.coins;
      if (a.characterId && perChar[a.characterId]) perChar[a.characterId].coins += a.coins;
      if (a.taskId && perTask[a.taskId]) perTask[a.taskId].coins += a.coins;
    });
  }

  return { cells, done, coins, maxCoins, failing, perChar, perTask, percent: cells ? Math.round(done / cells * 100) : 0 };
}

/** Фиксирует награды при завершении марафона. Баланс ДМ персонажей НЕ меняется (он берётся с сайта). */
export function freezeAwards(m, characters) {
  const awards = [];
  m.participantIds.forEach(cid => {
    const ch = characters.find(c => c.id === cid);
    m.tasks.forEach(t => {
      const c = computeCell(m, cid, t.id);
      if (c.assigned && c.reached && c.coins > 0) {
        awards.push({
          characterId: cid, charNick: ch?.nick || '', taskId: t.id, taskTitle: t.title,
          rewardText: c.reached.rewardText || `Порог ${c.reached.threshold}`, coins: c.coins
        });
      }
    });
  });
  return awards;
}

export function marathonPhase(m, today = todayStr()) {
  if (m.status === 'completed') return 'completed';
  if (today < m.startDate) return 'upcoming';
  if (m.endDate && today > m.endDate) return 'ended';
  return 'active';
}

export function seriesChildren(series, all) {
  return (series.childIds || []).map(id => all.find(m => m.id === id)).filter(Boolean)
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
}

export function seriesPhase(series, all) {
  const kids = seriesChildren(series, all);
  if (!kids.length) return 'active';
  if (kids.every(k => k.status === 'completed')) return 'completed';
  const phases = kids.map(k => marathonPhase(k));
  if (phases.every(p => p === 'upcoming')) return 'upcoming';
  if (phases.every(p => p === 'ended' || p === 'completed')) return 'ended';
  return 'active';
}

/* ------------------------------------------------------------------ */
/*  Сверка с сайтом                                                    */
/* ------------------------------------------------------------------ */

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

export function normTitle(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
}
export function baseTitle(s) {
  return normTitle(String(s || '').replace(/\([^)]*\)/g, ''));
}
function parenOf(s) {
  return (/\(([^)]*)\)/.exec(String(s || ''))?.[1] || '').toLowerCase().trim();
}
function sameMonth(a, b) {
  if (!a || !b) return false;
  const ia = MONTHS.findIndex(x => a.startsWith(x));
  const ib = MONTHS.findIndex(x => b.startsWith(x));
  return ia !== -1 && ia === ib;
}

/** Находит задание сайта для задания марафона: точное название, затем «без скобок» с учётом месяца этапа. */
export function matchQuest(task, quests, stageKey) {
  const exact = normTitle(task.siteTitle || task.title);
  let q = quests.find(x => normTitle(x.title) === exact);
  if (q) return q;
  const base = baseTitle(task.siteTitle || task.title);
  const candidates = quests.filter(x => baseTitle(x.title) === base);
  if (candidates.length === 1) return candidates[0];
  const month = stageKey || parenOf(task.siteTitle || task.title);
  return candidates.find(x => sameMonth(parenOf(x.title), month)) || null;
}

/**
 * Применяет данные сайта (quests персонажа) к марафону.
 * Возвращает список изменений [{ taskId, from, to }].
 */
export function applySiteQuests(m, charId, quests, at = new Date().toISOString()) {
  const changes = [];
  if (!Array.isArray(quests) || m.kind === 'series' || m.status === 'completed') return changes;
  if (!m.participantIds.includes(charId)) return changes;
  const day = at.slice(0, 10);

  m.tasks.forEach(task => {
    const q = matchQuest(task, quests, m.source?.stageKey);
    if (!q) return;
    const cell = ensureCell(m.progress, charId, task.id);
    const from = cell.site;
    const to = Number(q.completed) || 0;
    if (from !== null && from !== undefined && to > from) {
      cell.history[day] = (cell.history[day] || 0) + (to - from);
    }
    cell.site = to;
    cell.siteTotal = Number(q.total) || null;
    cell.syncedAt = at;
    if (!task.siteTitle) task.siteTitle = q.title;
    if (from !== to) changes.push({ taskId: task.id, from, to });
  });
  return changes;
}


/** Статус бонусов персонажа: [{ bonus, done, need, reached }] */
export function bonusStatus(m, charId) {
  const done = m.tasks.filter(t => computeCell(m, charId, t.id).state === 'done').length;
  return (m.bonuses || []).map(b => ({ bonus: b, done, need: b.needTasks, reached: done >= b.needTasks }));
}
