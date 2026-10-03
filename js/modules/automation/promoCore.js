// js/modules/automation/promoCore.js
// Активация промокодов (Issue #25): чистая логика без интерфейса — проверка кода, статусы,
// защита от повторного запуска, история и CSV. Диалог и запуск: promo.js.

/** Допустимые символы кода: он подставляется в адрес /pin/<КОД>. Длина: поле на сайте `maxlength=40`. */
export const CODE_RE = /^[A-Za-z0-9_-]{4,40}$/;

export const normalizeCode = (raw) => String(raw ?? '').trim();

/** @returns {{ ok: boolean, code: string, error: string|null }} */
export function validateCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return { ok: false, code, error: 'Введите промокод' };
  if (!CODE_RE.test(code)) {
    return { ok: false, code, error: 'Код может содержать только латинские буквы, цифры, «-» и «_» (4–40 символов)' };
  }
  return { ok: true, code, error: null };
}

/** Как показывать каждый итог. `final` — исход известен, повторять не нужно. */
export const STATUS_INFO = {
  success: { icon: '✅', label: 'Успех', level: 'ok' },
  already_used: { icon: '♻️', label: 'Код уже использован', level: 'warn' },
  invalid_code: { icon: '⛔', label: 'Недействительный код', level: 'warn' },
  not_logged_in: { icon: '🔴', label: 'Нет входа', level: 'warn' },
  challenge: { icon: '🛡️', label: 'Нужна проверка безопасности', level: 'warn' },
  needs_choice: { icon: '❔', label: 'Нужно выбрать аккаунт вручную', level: 'warn' },
  dry_run: { icon: '👁', label: 'Пробный запуск: кнопка найдена, не нажата', level: 'info' },
  unknown: { icon: '❓', label: 'Результат не распознан — проверьте вручную', level: 'warn' },
  error: { icon: '❌', label: 'Ошибка', level: 'error' },
  cancelled: { icon: '⏹', label: 'Не выполнено (отмена)', level: 'info' }
};

export const statusInfo = (status) => STATUS_INFO[status] || STATUS_INFO.error;

/**
 * Строка результата из ответа Rust-команды `activate_promo` (или из ошибки вызова).
 * @param {{ id: string, nick: string }} char
 */
export function rowFromPayload(char, payload, error, now = new Date()) {
  const at = now.toISOString();
  if (error || !payload) {
    return { charId: char.id, nick: char.nick, status: 'error', error: String(error?.message || error || 'no_response'), detail: null, clicked: false, dryRun: false, at };
  }
  return {
    charId: char.id,
    nick: char.nick,
    status: STATUS_INFO[payload.status] ? payload.status : 'error',
    error: payload.error || null,
    detail: payload.detail || null,
    clicked: !!payload.clicked,
    dryRun: !!payload.dryRun,
    at
  };
}

/**
 * Можно ли безопасно запустить заново: кнопка НЕ была нажата (иначе код мог примениться),
 * а причина — временная (сайт, вход, проверка безопасности, окно) или запуск не состоялся.
 */
export function isRetryable(row) {
  if (!row || row.clicked || row.dryRun) return false;
  if (row.status === 'cancelled' || row.status === 'challenge' || row.status === 'not_logged_in') return true;
  if (row.status === 'error') return !['bad_code', 'bad_char', 'button_ambiguous'].includes(row.error);
  return false;
}

/** Итог по набору строк: { success, alreadyUsed, failed, unknown, ... }. */
export function summarize(rows) {
  const count = (pred) => rows.filter(pred).length;
  return {
    total: rows.length,
    success: count(r => r.status === 'success'),
    alreadyUsed: count(r => r.status === 'already_used'),
    unknown: count(r => r.status === 'unknown'),
    dryRun: count(r => r.status === 'dry_run'),
    retryable: count(isRetryable),
    failed: count(r => !['success', 'already_used', 'dry_run'].includes(r.status))
  };
}

/* ------------------------------------------------------------------ */
/*  Защита от повторного запуска в течение сессии                       */
/* ------------------------------------------------------------------ */

/** Исходы, после которых код на этом персонаже считается уже отправленным. */
const SENT = new Set(['success', 'already_used', 'unknown']);

export function createSessionGuard() {
  /** @type {Map<string, Map<string, string>>} код (в нижнем регистре) → { charId → статус } */
  const runs = new Map();
  const key = (code) => normalizeCode(code).toLowerCase();
  return {
    /** Запоминает итог настоящего запуска (пробные не считаются). */
    record(code, rows) {
      const k = key(code);
      if (!runs.has(k)) runs.set(k, new Map());
      rows.filter(r => !r.dryRun && r.clicked && SENT.has(r.status)).forEach(r => runs.get(k).set(r.charId, r.status));
    },
    /** Какие из персонажей этим кодом уже пользовались в этой сессии. */
    alreadySent(code, charIds) {
      const m = runs.get(key(code));
      return m ? charIds.filter(id => m.has(id)) : [];
    },
    clear() { runs.clear(); }
  };
}

/* ------------------------------------------------------------------ */
/*  История (локально, в localStorage)                                  */
/* ------------------------------------------------------------------ */

export const HISTORY_KEY = 'tf_promo_history_v1';
export const HISTORY_MAX = 300;

const store = () => { try { return window.localStorage; } catch { return null; } };

export function loadHistory() {
  try { const v = JSON.parse(store()?.getItem(HISTORY_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function clearHistory() { store()?.removeItem(HISTORY_KEY); }


/** Добавляет строки в историю. Промокод не секретный, поэтому хранится целиком. */
export function addHistory(code, rows) {
  const shown = normalizeCode(code);
  const entries = rows.filter(r => !r.dryRun).map(r => ({ at: r.at, code: shown, charId: r.charId, nick: r.nick, status: r.status, error: r.error || null }));
  if (!entries.length) return loadHistory();
  const next = [...entries.reverse(), ...loadHistory()].slice(0, HISTORY_MAX);
  try { store()?.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* квота: история не критична */ }
  return next;
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

/** CSV для русского Excel: разделитель «;», в начале BOM.  */
export function resultsToCsv(rows) {
  const head = ['Персонаж', 'Результат', 'Подробности', 'Время'];
  const lines = rows.map(r => [r.nick, statusInfo(r.status).label, r.error || r.detail || '', r.at].map(csvCell).join(';'));
  return '\ufeff' + [head.join(';'), ...lines].join('\r\n');
}
