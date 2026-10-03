// js/modules/automation/promoCore.js
// Активация промокодов (Issue #25): чистая логика без интерфейса — разбор списка кодов, статусы, итоги.
// Журнал и архив: promoLog.js. Запуск: promoRunner.js. Диалог: promo.js.

/** Допустимые символы кода: он подставляется в адрес /pin/<КОД>. Длина: поле на сайте `maxlength=40`. */
export const CODE_RE = /^[A-Za-z0-9_-]{4,40}$/;
/** Сколько разных кодов можно ввести за один запуск. */
export const MAX_CODES = 10;

export const normalizeCode = (raw) => String(raw ?? '').trim();
export const codeKey = (code) => normalizeCode(code).toLowerCase();

/** @returns {{ ok: boolean, code: string, error: string|null }} */
export function validateCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return { ok: false, code, error: 'Введите промокод' };
  if (!CODE_RE.test(code)) {
    return { ok: false, code, error: 'Код может содержать только латинские буквы, цифры, «-» и «_» (4–40 символов)' };
  }
  return { ok: true, code, error: null };
}

/**
 * Список кодов из одного поля: через запятую, точку с запятой, пробел или с новой строки.
 * @returns {{ codes: string[], invalid: string[], duplicates: number, extra: number }}
 *   invalid — куски, которые не похожи на код; extra — сколько кодов не поместилось в лимит.
 */
export function parseCodes(raw, max = MAX_CODES) {
  const tokens = String(raw ?? '').split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
  const codes = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;
  for (const t of tokens) {
    if (!CODE_RE.test(t)) { invalid.push(t); continue; }
    const k = codeKey(t);
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k);
    codes.push(t);
  }
  return { codes: codes.slice(0, max), invalid, duplicates, extra: Math.max(0, codes.length - max) };
}

/** Как показывать каждый итог. */
export const STATUS_INFO = {
  success: { icon: '✅', label: 'Введён', level: 'ok' },
  already_used: { icon: '✅', label: 'Уже введён', level: 'ok' },
  invalid_code: { icon: '⛔', label: 'Недействительный код', level: 'warn' },
  expired: { icon: '⌛', label: 'Срок действия кода истёк', level: 'warn' },
  not_logged_in: { icon: '🔴', label: 'Нет входа', level: 'warn' },
  challenge: { icon: '🛡️', label: 'Нужна проверка безопасности', level: 'warn' },
  needs_choice: { icon: '❔', label: 'Нужно выбрать аккаунт вручную', level: 'warn' },
  dry_run: { icon: '👁', label: 'Пробный запуск: кнопка найдена, не нажата', level: 'info' },
  unknown: { icon: '❓', label: 'Результат не распознан — проверьте вручную', level: 'warn' },
  error: { icon: '❌', label: 'Ошибка', level: 'error' },
  cancelled: { icon: '⏹', label: 'Остановлено', level: 'info' },
  not_run: { icon: '⏭', label: 'Не выполнено', level: 'info' }
};

export const statusInfo = (status) => STATUS_INFO[status] || STATUS_INFO.error;

/** Подпись строки результата: «Уже введён ранее» для пропущенных по журналу. */
export const rowLabel = (row) => (row?.skipped && isOk(row.status) ? 'Уже введён ранее' : statusInfo(row?.status).label);

/** Введён (или сайт сообщил, что уже введён) — для пользователя это успех. */
export const isOk = (status) => status === 'success' || status === 'already_used';
/** Ответ сайта про сам код: такой код нигде не сохраняется. */
export const isInvalid = (status) => status === 'invalid_code' || status === 'expired';

/** Строка награды: «Метеорит ×100». */
export const rewardLine = (r) => `${r.name}${r.qty > 1 ? ` ×${r.qty}` : ''}`;
export const rewardText = (reward) => (Array.isArray(reward) ? reward.map(rewardLine).join('; ') : '');

/** Награды из ответа Rust: оставляем только понятные поля. */
export function cleanRewards(list) {
  if (!Array.isArray(list)) return null;
  const out = list
    .filter(r => r && typeof r.name === 'string' && r.name.trim())
    .map(r => ({ name: r.name.trim().slice(0, 120), qty: Number(r.qty) > 0 ? Number(r.qty) : 1, id: r.id ? String(r.id) : null, bound: !!r.bound }));
  return out.length ? out : null;
}

/**
 * Строка результата из ответа Rust-команды `activate_promo` (или из ошибки вызова).
 * @param {{ id: string, nick: string }} char
 */
export function rowFromPayload(char, code, payload, error, now = new Date()) {
  const base = { code, charId: char.id, nick: char.nick, skipped: false, at: now.toISOString() };
  if (error || !payload) {
    return { ...base, status: 'error', error: String(error?.message || error || 'no_response'), detail: null, clicked: false, dryRun: false, rewards: null };
  }
  return {
    ...base,
    status: STATUS_INFO[payload.status] ? payload.status : 'error',
    error: payload.error || null,
    detail: payload.detail || null,
    clicked: !!payload.clicked,
    dryRun: !!payload.dryRun,
    rewards: cleanRewards(payload.rewards)
  };
}

/** Строка без запуска: пропущена по журналу, остановлена, не выполнялась. */
export const plainRow = (char, code, status, detail = null, extra = {}, now = new Date()) =>
  ({ code, charId: char.id, nick: char.nick, status, error: null, detail, clicked: false, dryRun: false, rewards: null, skipped: false, at: now.toISOString(), ...extra });

/**
 * Можно ли повторить запрос САМИ (без участия пользователя): кнопка не нажата, а причина временная —
 * сайт не успел ответить или показал «Проверку безопасности». «Нет входа» не повторяется: вход сам не появится.
 */
export function canAutoRetry(row, isTransientError = () => false) {
  if (!row || row.clicked || row.dryRun) return false;
  if (row.status === 'challenge') return true;
  return row.status === 'error' && isTransientError(row.error);
}

/** Ошибки команды, после которых имеет смысл подождать и повторить. */
export const TRANSIENT_ERRORS = new Set(['timeout', 'button_not_found', 'pending', 'click_failed']);
export const isTransient = (code) => !!code && (TRANSIENT_ERRORS.has(code) || String(code).startsWith('exception_'));

/** Строки, которые «Повторить ввод» запустит снова: не введены и это не «нажато, но результат неясен». */
export const isRerunnable = (row) => !!row && !isOk(row.status) && !(row.clicked && row.status === 'unknown') && !row.dryRun;

/** Общий итог по набору строк. */
export function summarize(rows) {
  const count = (pred) => rows.filter(pred).length;
  const ok = count(r => isOk(r.status));
  return {
    total: rows.length,
    ok,
    entered: count(r => r.status === 'success'),
    alreadyUsed: count(r => r.status === 'already_used' && !r.skipped),
    skipped: count(r => r.skipped && isOk(r.status)),
    invalid: count(r => isInvalid(r.status)),
    unknown: count(r => r.status === 'unknown'),
    notRun: count(r => r.status === 'not_run' || r.status === 'cancelled'),
    rerun: count(isRerunnable),
    failed: count(r => !isOk(r.status) && !isInvalid(r.status) && r.status !== 'unknown' && r.status !== 'not_run' && r.status !== 'cancelled')
  };
}

/** Итог по каждому коду: { code, ok, entered, invalid, failed, rewards, firstDetail }. */
export function summarizeByCode(rows, codes) {
  return codes.map(code => {
    const mine = rows.filter(r => codeKey(r.code) === codeKey(code));
    const s = summarize(mine);
    const rejected = mine.find(r => isInvalid(r.status));
    return {
      code,
      total: mine.length,
      ok: s.ok,
      entered: s.entered,
      alreadyUsed: s.alreadyUsed + s.skipped,
      invalid: s.invalid,
      rewards: mine.find(r => r.rewards?.length)?.rewards || null,
      rejected: s.ok === 0 && rejected ? { status: rejected.status, detail: rejected.detail, count: s.invalid } : null,
      other: s.total - s.ok - s.invalid
    };
  });
}

/* ------------------------------------------------------------------ */
/*  CSV                                                                 */
/* ------------------------------------------------------------------ */

/** Ячейка CSV: кавычки удваиваются, формулы Excel (=, +, -, @) нейтрализуются апострофом. */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV для русского Excel: разделитель «;», в начале BOM. */
export function toCsv(head, lines) {
  return '\ufeff' + [head, ...lines].map(row => row.map(csvCell).join(';')).join('\r\n');
}
