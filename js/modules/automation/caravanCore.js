// js/modules/automation/caravanCore.js
// 🧰 Сундук караванщика: чистая логика (без интерфейса и без вызовов в Rust): строки результата, статусы, тексты и сводка.
// Команда: open_caravan_chests (src-tauri/src/automation/caravan.rs). Правила: docs/COMPLIANCE.md.

import { errorText } from '../../core/errorCodes.js';

/**
 * Статусы результата по персонажу (приходят из Rust, плюс два служебных — `cancelled` и `not_run`).
 * level: ok — всё открыто; info — делать было нечего / пробный запуск; warn — стоит посмотреть; error — не получилось.
 */
const STATUS = {
  success: { icon: '✅', label: 'Открыто', level: 'ok' },
  partial: { icon: '⚠️', label: 'Открыто не всё', level: 'warn' },
  nothing: { icon: '➖', label: 'Сундуков нет', level: 'info' },
  dry_run: { icon: '👁', label: 'Сундуки найдены', level: 'info' },
  not_logged_in: { icon: '🔴', label: 'Нет входа на сайт', level: 'error' },
  challenge: { icon: '🛡', label: 'Проверка безопасности', level: 'warn' },
  unknown: { icon: '❓', label: 'Результат не проверен', level: 'warn' },
  error: { icon: '❌', label: 'Ошибка', level: 'error' },
  cancelled: { icon: '⏹', label: 'Остановлено', level: 'info' },
  not_run: { icon: '⏭', label: 'Не выполнялось', level: 'info' }
};

export const statusInfo = (status) => STATUS[status] || STATUS.error;

/** Состояния отдельных сундуков в отчёте Rust. */
const CHEST_STATE = {
  found: '📦 найден',
  opened: '✅ открыт',
  not_opened: '⚠ остался в инвентаре',
  sent: '❓ нажато, итог не проверен',
  gone: '➖ уже недоступен',
  error: '❌ не открыт'
};
export const chestStateLabel = (state) => CHEST_STATE[state] || String(state || '');

/** Тексты ошибок для сундука: у общих кодов формулировки про «Активировать» и «передачу» тут не подходят. */
const OWN_ERROR_TEXT = {
  button_not_found: 'в сундуке нет кнопки отправки (возможно, сайт изменил вёрстку)',
  selection_changed: 'отметки в сундуке изменились, ничего не нажато',
  no_items: 'в сундуке нет предметов',
  form_not_found: 'на странице сундука нет формы (возможно, сайт изменил вёрстку)'
};
export const caravanErrorText = (code) => OWN_ERROR_TEXT[code] || errorText(code);

/** Ошибки, после которых имеет смысл подождать и повторить (пока ничего не нажато). */
export const TRANSIENT_ERRORS = new Set(['timeout', 'pending', 'page_not_found', 'form_not_found', 'click_failed']);
export const isTransient = (code) => !!code && (TRANSIENT_ERRORS.has(code) || String(code).startsWith('exception_'));

/** Строка результата без обращения к сайту (остановлено, не запускалось). */
export const plainRow = (char, status, detail = null, extra = {}) => ({
  charId: char.id, nick: char.nick, status, error: null, detail, dryRun: false, clicked: false,
  found: 0, other: 0, opened: 0, truncated: 0, chests: [], ...extra
});

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

/**
 * Строка результата из ответа команды. Любой ответ не того вида превращается в ошибку `bad_response`,
 * исключение или отсутствие ответа — в ошибку с текстом исключения.
 */
export function rowFromPayload(char, payload, error) {
  if (error || !payload || typeof payload !== 'object') {
    return plainRow(char, 'error', null, { error: String(error?.message || error || 'no_response') });
  }
  const status = STATUS[payload.status] && !['cancelled', 'not_run'].includes(payload.status) ? payload.status : 'error';
  const chests = Array.isArray(payload.chests)
    ? payload.chests.map(c => ({
      cartId: String(c?.cartId ?? ''), until: String(c?.until ?? ''), state: String(c?.state ?? 'found'),
      error: c?.error ? String(c.error) : null, items: Array.isArray(c?.items) ? c.items.map(String) : []
    }))
    : [];
  return {
    charId: char.id, nick: char.nick, status,
    error: payload.error ? String(payload.error) : (status === 'error' && payload.status !== 'error' ? 'bad_response' : null),
    detail: null,
    dryRun: !!payload.dryRun, clicked: !!payload.clicked,
    found: num(payload.found), other: num(payload.other), opened: num(payload.opened), truncated: num(payload.truncated),
    chests
  };
}

/**
 * Можно ли повторить САМИМ (без участия пользователя): ничего не нажато, а причина временная —
 * сайт не успел ответить или показал «Проверку безопасности». «Нет входа» не повторяется.
 */
export function canAutoRetry(row, isTransientError = isTransient) {
  if (!row || row.clicked || row.dryRun) return false;
  if (row.status === 'challenge') return true;
  return row.status === 'error' && isTransientError(row.error);
}

/**
 * Строки, которые кнопка «Повторить» запустит снова. Повтор безопасен: команда сначала читает инвентарь
 * и открывает только те сундуки, которые в нём ещё лежат.
 */
export const isRerunnable = (row) => !!row && !row.dryRun && ['partial', 'error', 'challenge', 'unknown', 'cancelled', 'not_run'].includes(row.status);

/** Короткая подпись результата для таблицы. */
export function rowLabel(row) {
  const info = statusInfo(row.status);
  switch (row.status) {
    case 'success': return `Открыто сундуков: ${row.opened}`;
    case 'partial': return `Открыто ${row.opened} из ${row.found}`;
    case 'dry_run': return `Сундуков караванщика: ${row.found}`;
    case 'unknown': return `Нажато, но список не перечитан (сундуков: ${row.found})`;
    case 'error': return row.error ? `Ошибка: ${caravanErrorText(row.error)}` : info.label;
    default: return info.label;
  }
}

/** Подробности под подписью: чужие сундуки, лишние сверх лимита, пояснение к статусу. */
export function rowNotes(row) {
  const notes = [];
  if (row.detail) notes.push(row.detail);
  if (row.other) notes.push(`Других сундуков (не трогали): ${row.other}`);
  if (row.truncated) notes.push(`Сверх лимита за запуск: ${row.truncated} — запустите ещё раз`);
  if (row.status === 'unknown') notes.push('Проверьте инвентарь на сайте; автоматически эти сундуки повторно не открываются вслепую');
  if (row.status === 'challenge') notes.push('Сайт показал «Проверку безопасности»: пройдите её в окне персонажа и повторите');
  return notes;
}

/** Строка про один сундук для подробного списка и журнала. */
export function chestLine(c) {
  const parts = [`${chestStateLabel(c.state)} №${c.cartId}`];
  if (c.until) parts.push(`до ${c.until}`);
  if (c.items?.length) parts.push(`предметов: ${c.items.length}`);
  if (c.error) parts.push(caravanErrorText(c.error));
  return parts.join(' · ');
}

/** Сводка по набору строк. */
export function summarize(rows) {
  const count = (pred) => rows.filter(pred).length;
  const sum = (key) => rows.reduce((n, r) => n + (r[key] || 0), 0);
  return {
    total: rows.length,
    success: count(r => r.status === 'success'),
    partial: count(r => r.status === 'partial'),
    nothing: count(r => r.status === 'nothing'),
    dry: count(r => r.status === 'dry_run'),
    noLogin: count(r => r.status === 'not_logged_in'),
    challenge: count(r => r.status === 'challenge'),
    unknown: count(r => r.status === 'unknown'),
    failed: count(r => r.status === 'error'),
    notRun: count(r => r.status === 'cancelled' || r.status === 'not_run'),
    found: sum('found'),
    opened: sum('opened'),
    rerun: count(isRerunnable)
  };
}

/** Итог одной строкой для журнала задач и подзаголовка окна. */
export function summaryText(rows, { dry = false, stopped = false } = {}) {
  const s = summarize(rows);
  const head = stopped ? 'Остановлено. ' : '';
  if (dry) {
    return `${head}Пробный запуск: сундуков караванщика ${s.found} у ${s.dry} из ${s.total} перс.${s.nothing ? `; пусто у ${s.nothing}` : ''}${s.noLogin ? `; без входа: ${s.noLogin}` : ''}${s.failed + s.challenge ? `; проблем: ${s.failed + s.challenge}` : ''}. Ничего не открыто`;
  }
  const bits = [`Открыто сундуков: ${s.opened}`];
  if (s.nothing) bits.push(`без сундуков: ${s.nothing} перс.`);
  if (s.partial) bits.push(`открыто не всё: ${s.partial}`);
  if (s.noLogin) bits.push(`без входа: ${s.noLogin}`);
  if (s.challenge) bits.push(`проверка безопасности: ${s.challenge}`);
  if (s.unknown) bits.push(`не проверено: ${s.unknown}`);
  if (s.failed) bits.push(`ошибок: ${s.failed}`);
  if (s.notRun) bits.push(`не выполнено: ${s.notRun}`);
  return `${head}${bits.join('; ')}`;
}

/** Уровень итоговой записи в журнале задач: `done`, если всё прошло гладко, иначе `warn`. */
export const taskLevel = (rows) => {
  const s = summarize(rows);
  return s.partial || s.noLogin || s.challenge || s.unknown || s.failed || s.notRun ? 'warn' : 'done';
};
