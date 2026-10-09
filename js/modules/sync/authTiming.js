// Замер скорости проверки входа: гоняет настоящую команду на живых аккаунтах и печатает,
// где именно уходит время. Это инструмент для разбора «проверка идёт 42 секунды»:
// без поэтапных цифр любое ускорение — гадание.
//
// Запуск из консоли приложения (Ctrl+Shift+I в Твиноферме) или из dev-сервера:
//   await import('/js/modules/sync/authTiming.js').then(m => m.measureAuth(['id1','id2']))
//
// Что показывает:
//   окно   — создание/переиспользование скрытого окна профиля
//   переход— navigate + пауза 1.5 с перед разбором
//   разбор — ожидание ответа парсера (цикл eval_and_wait)
//   куки   — сохранение сессии в банк кук
//   итого  — вся проверка одного персонажа
//
// Итоги копируются в буфер и вставляются в чат — по ним уже видно, что именно тормозит.

import { checkCharacterAuth } from './checkAuth.js';

/**
 * Разбор замеров одного персонажа.
 * @param {Array<{ charId: string, status: string, reason: string|null, timings?: any }>} results
 * @returns {Array<{ charId: string, status: string, reason: string|null, totalMs: number, windowMs: number, navigateMs: number, parseMs: number, cookiesMs: number }>}
 */
export function parseTimings(results) {
  return (results || []).map(r => {
    const t = r?.timings || {};
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      charId: r?.charId || '',
      status: r?.status || 'unknown',
      reason: r?.reason ?? null,
      totalMs: num(t.totalMs),
      windowMs: num(t.windowMs),
      navigateMs: num(t.navigateMs),
      parseMs: num(t.parseMs),
      cookiesMs: num(t.cookiesMs)
    };
  });
}

/**
 * Строки, по которым есть что усреднять.
 *
 * Пропущенные (открыто окно персонажа) и упавшие проверки времени не имеют: Rust в этом
 * случае timings не отдаёт вовсе. Если их не отбросить, средние покажут половину
 * настоящего времени, а подсказка «дольше всего» укажет не на тот этап.
 */
export function measuredRows(rows) {
  return (rows || []).filter(r => r?.status !== 'skipped' && r?.status !== 'error');
}

/** Средние по этапам, мс. Пустой набор — нули, а не NaN. */
export function stageAverages(rows) {
  const list = measuredRows(rows);
  if (!list.length) return { windowMs: 0, navigateMs: 0, parseMs: 0, cookiesMs: 0, totalMs: 0 };
  const sum = key => list.reduce((a, r) => a + (r[key] || 0), 0);
  return {
    windowMs: Math.round(sum('windowMs') / list.length),
    navigateMs: Math.round(sum('navigateMs') / list.length),
    parseMs: Math.round(sum('parseMs') / list.length),
    cookiesMs: Math.round(sum('cookiesMs') / list.length),
    totalMs: Math.round(sum('totalMs') / list.length)
  };
}

const ms = v => `${(v / 1000).toFixed(1)} с`;

/** Текст отчёта: строки по персонажам, затем средние по этапам. */
export function timingReport(rows) {
  if (!rows?.length) return 'Замеров нет: ни один персонаж не проверился.';
  const avg = stageAverages(rows);
  const measured = measuredRows(rows);
  // Без единого замера средних нет: показывать нули и «дольше всего» не о чем
  if (!measured.length) {
    return `${rows.map(r => `${r.charId}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`).join('\n')}\n`
      + 'Время не замерено: всех персонажей пропустили (открыто окно) или проверка упала.';
  }
  const lines = rows.map(r =>
    `${r.charId}: ${r.status}${r.reason ? ` (${r.reason})` : ''} — итого ${ms(r.totalMs)}; `
    + `окно ${ms(r.windowMs)}, переход ${ms(r.navigateMs)}, разбор ${ms(r.parseMs)}, куки ${ms(r.cookiesMs)}`);
  lines.push('', `Среднее по ${measured.length}: итого ${ms(avg.totalMs)}; окно ${ms(avg.windowMs)}, `
    + `переход ${ms(avg.navigateMs)}, разбор ${ms(avg.parseMs)}, куки ${ms(avg.cookiesMs)}`);
  // Пропуски и ошибки в среднее не входят, но и молчать о них нельзя: иначе кажется,
  // что замерено меньше персонажей, чем на самом деле
  if (measured.length < rows.length) {
    lines.push(`Без времени: ${rows.length - measured.length} (пропущено или ошибка) — в среднее не входят.`);
  }
  // Подсказка по самому долгому этапу: обычно он и есть причина
  const worst = Object.entries({ окно: avg.windowMs, переход: avg.navigateMs, разбор: avg.parseMs, куки: avg.cookiesMs })
    .sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] > 0) lines.push(`Дольше всего: «${worst[0]}» — ${ms(worst[1])}`);
  return lines.join('\n');
}

/**
 * Замеряет проверку входа на указанных персонажах.
 * @param {string[]} charIds
 * @param {{ timeoutSeconds?: number, deps?: { invoke?: Function } }} [opts]
 * @returns {Promise<{ rows: any[], avg: any, report: string }>}
 */
export async function measureAuth(charIds, { timeoutSeconds = 4, deps = {} } = {}) {
  const rows = [];
  // Замеры идут по одному: параллельные окна мешали бы друг другу и завышали бы «окно» и «переход»
  const run = deps.check || ((id) => checkCharacterAuth(id, { timeoutSeconds, closeAfter: true }));
  for (const id of charIds || []) {
    try {
      rows.push(...parseTimings([await run(id)]));
    } catch (e) {
      // Одна ошибка не должна отменять замер остальных: иначе цифры будут неполными
      rows.push({ charId: id, status: 'error', reason: String(e?.message || e), totalMs: 0, windowMs: 0, navigateMs: 0, parseMs: 0, cookiesMs: 0 });
    }
  }
  const report = timingReport(rows);
  console.log(`[AUTH TIMING]\n${report}`);
  try { await navigator.clipboard.writeText(report); } catch { /* буфер может быть недоступен */ }
  return { rows, avg: stageAverages(rows), report };
}

/**
 * Замер без указания персонажей: берёт всех, кроме архивных.
 *
 * Берём именно всех, а не только тех, у кого вход не подтверждён: замерять нужно и быстрые
 * проверки — только они показывают, сколько времени стоит сама настройка окна и переход,
 * без ожидания сайта. Если мерить только офлайн, получится «тормозит сайт», хотя тормозит
 * приложение.
 *
 * @param {{ state?: any, timeoutSeconds?: number, limit?: number, onlyUnconfirmed?: boolean, deps?: object }} [opts]
 */
export async function measureAllAuth(opts = {}) {
  const { state } = opts.state ? { state: opts.state } : await import('../../core/state.js');
  const all = (state.characters || []).filter(c => !c.archived);
  const list = opts.onlyUnconfirmed ? all.filter(c => c.isLoggedIn !== true) : all;
  if (!list.length) {
    return { rows: [], avg: {}, report: 'Некого мерить: в приложении нет персонажей.' };
  }
  // Персонажей может быть много, а каждая проверка — это окно и запрос к сайту.
  // По умолчанию берём первые 10: этого хватает, чтобы увидеть картину.
  const limit = opts.limit ?? 10;
  const picked = list.slice(0, limit);
  const res = await measureAuth(picked.map(c => c.id), { timeoutSeconds: opts.timeoutSeconds ?? 4, deps: opts.deps });
  if (picked.length < list.length) {
    res.report += `\n\nЗамерены первые ${picked.length} из ${list.length}. Для остальных: measureAllAuth({ limit: ${list.length} })`;
  }
  return res;
}