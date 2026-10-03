// Чистая логика активации промокодов (Issue #25): проверка кода, строки результата, защита от повторов, история, CSV.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateCode, rowFromPayload, isRetryable, summarize, createSessionGuard,
  addHistory, loadHistory, clearHistory, csvCell, resultsToCsv, statusInfo, HISTORY_MAX
} from '../js/modules/automation/promoCore.js';

const char = { id: 'c1', nick: 'Ник' };
const NOW = new Date('2026-01-02T03:04:05Z');
const row = (over = {}) => ({ charId: 'c1', nick: 'Ник', status: 'error', error: null, detail: null, clicked: false, dryRun: false, at: NOW.toISOString(), ...over });

describe('validateCode', () => {
  it('принимает обычные коды и обрезает пробелы', () => {
    expect(validateCode('  PWZNANIYA26 ')).toEqual({ ok: true, code: 'PWZNANIYA26', error: null });
    expect(validateCode('a-b_c1').ok).toBe(true);
  });
  it('отклоняет пустой, короткий, длинный и с лишними символами (код идёт в адрес)', () => {
    expect(validateCode('').ok).toBe(false);
    expect(validateCode('abc').ok).toBe(false);
    expect(validateCode('A'.repeat(41)).ok).toBe(false);
    expect(validateCode('AB CD').ok).toBe(false);
    expect(validateCode('ABCD/../x').ok).toBe(false);
    expect(validateCode('ABCD?x=1').ok).toBe(false);
    expect(validateCode('ABCDé').ok).toBe(false);
  });
});

describe('rowFromPayload', () => {
  it('переносит ответ Rust-команды', () => {
    const r = rowFromPayload(char, { status: 'success', clicked: true, detail: 'ok' }, null, NOW);
    expect(r).toMatchObject({ charId: 'c1', nick: 'Ник', status: 'success', clicked: true, detail: 'ok', dryRun: false, at: NOW.toISOString() });
  });
  it('ошибка вызова или пустой ответ — статус error, кнопка не нажата', () => {
    expect(rowFromPayload(char, null, new Error('boom'), NOW)).toMatchObject({ status: 'error', error: 'boom', clicked: false });
    expect(rowFromPayload(char, undefined, undefined, NOW)).toMatchObject({ status: 'error', error: 'no_response' });
  });
  it('неизвестный статус превращается в error', () => {
    expect(rowFromPayload(char, { status: 'weird' }, null, NOW).status).toBe('error');
  });
  it('у каждого статуса есть подпись', () => {
    expect(statusInfo('success').label).toBe('Успех');
    expect(statusInfo('nope').label).toBe('Ошибка');
  });
});

describe('isRetryable: повторять можно, только если кнопка не нажата', () => {
  it('нажатая кнопка — никогда', () => {
    expect(isRetryable(row({ status: 'error', clicked: true }))).toBe(false);
    expect(isRetryable(row({ status: 'unknown', clicked: true }))).toBe(false);
  });
  it('временные причины — можно', () => {
    expect(isRetryable(row({ status: 'challenge' }))).toBe(true);
    expect(isRetryable(row({ status: 'not_logged_in' }))).toBe(true);
    expect(isRetryable(row({ status: 'cancelled' }))).toBe(true);
    expect(isRetryable(row({ status: 'error', error: 'timeout' }))).toBe(true);
  });
  it('окончательные исходы и ошибки ввода — нельзя', () => {
    for (const status of ['success', 'already_used', 'invalid_code', 'unknown', 'dry_run', 'needs_choice']) {
      expect(isRetryable(row({ status }))).toBe(false);
    }
    expect(isRetryable(row({ status: 'error', error: 'bad_code' }))).toBe(false);
    expect(isRetryable(row({ status: 'error', error: 'button_ambiguous' }))).toBe(false);
    expect(isRetryable(row({ status: 'success', dryRun: true }))).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe('summarize', () => {
  it('считает итоги', () => {
    const rows = [
      row({ status: 'success', clicked: true }),
      row({ status: 'already_used', clicked: true }),
      row({ status: 'unknown', clicked: true }),
      row({ status: 'challenge' }),
      row({ status: 'dry_run', dryRun: true })
    ];
    expect(summarize(rows)).toEqual({ total: 5, success: 1, alreadyUsed: 1, unknown: 1, dryRun: 1, retryable: 1, failed: 2 });
  });
});

describe('createSessionGuard', () => {
  it('помнит отправленные коды без учёта регистра и не считает пробные и ненажатые', () => {
    const g = createSessionGuard();
    g.record('Code1234', [
      row({ charId: 'a', status: 'success', clicked: true }),
      row({ charId: 'b', status: 'challenge' }),
      row({ charId: 'c', status: 'dry_run', dryRun: true }),
      row({ charId: 'd', status: 'unknown', clicked: true })
    ]);
    expect(g.alreadySent('CODE1234', ['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'd']);
    expect(g.alreadySent('other-code', ['a'])).toEqual([]);
    g.clear();
    expect(g.alreadySent('code1234', ['a'])).toEqual([]);
  });
});

describe('история', () => {
  beforeEach(() => { window.localStorage.clear(); });
  it('код хранится целиком, пробные запуски не сохраняются; очистка работает', () => {
    addHistory('PWZNANIYA26', [row({ status: 'success', clicked: true }), row({ charId: 'c2', status: 'dry_run', dryRun: true })]);
    const h = loadHistory();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ code: 'PWZNANIYA26', nick: 'Ник', status: 'success' });
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
  it('история ограничена по длине, новые записи сверху', () => {
    const many = Array.from({ length: HISTORY_MAX + 20 }, (_, i) => row({ charId: `c${i}`, status: 'success', clicked: true }));
    addHistory('ABCD1234', many);
    expect(loadHistory()).toHaveLength(HISTORY_MAX);
    addHistory('ABCD1234', [row({ charId: 'new', status: 'success', clicked: true })]);
    expect(loadHistory()[0].charId).toBe('new');
  });
  it('повреждённые данные не ломают загрузку', () => {
    window.localStorage.setItem('tf_promo_history_v1', '{oops');
    expect(loadHistory()).toEqual([]);
  });
});

describe('CSV', () => {
  it('экранирует кавычки, разделители и формулы', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell(null)).toBe('');
  });
  it('таблица: BOM, заголовок, строки', () => {
    const csv = resultsToCsv([row({ nick: '=cmd', status: 'success', clicked: true, detail: 'ok' }), row({ nick: 'Б', status: 'challenge' })]);
    expect(csv.startsWith('\ufeffПерсонаж;Результат;Подробности;Время')).toBe(true);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("'=cmd;Успех;ok;2026-01-02T03:04:05.000Z");
    expect(lines[2]).toContain('Нужна проверка безопасности');
  });
});
