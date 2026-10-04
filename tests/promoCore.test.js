// Чистая логика активации промокодов (Issue #25): разбор списка кодов, статусы, итоги, CSV.
import { describe, it, expect } from 'vitest';
import {
  validateCode, parseCodes, MAX_CODES, rowFromPayload, plainRow, canAutoRetry, isTransient, isRerunnable,
  summarize, summarizeByCode, isOk, isInvalid, rowLabel, statusInfo, cleanRewards, rewardText, csvCell, toCsv
} from '../js/modules/automation/promoCore.js';

const char = { id: 'c1', nick: 'Ник' };
const NOW = new Date('2026-01-02T03:04:05Z');
const row = (over = {}) => ({ code: 'ABCD1234', charId: 'c1', nick: 'Ник', status: 'error', error: null, detail: null, clicked: false, dryRun: false, skipped: false, rewards: null, at: NOW.toISOString(), ...over });

describe('validateCode', () => {
  it('принимает обычные коды и обрезает пробелы', () => {
    expect(validateCode('  PWZNANIYA26 ')).toEqual({ ok: true, code: 'PWZNANIYA26', error: null });
    expect(validateCode('a-b_c1').ok).toBe(true);
  });
  it('отклоняет пустой, короткий, длинный и с лишними символами (код идёт в адрес)', () => {
    for (const bad of ['', 'abc', 'A'.repeat(41), 'AB CD', 'ABCD/../x', 'ABCD?x=1', 'ABCDé']) expect(validateCode(bad).ok, bad).toBe(false);
  });
});

describe('parseCodes: несколько кодов в одном поле', () => {
  it('запятая, точка с запятой, пробел и перенос строки', () => {
    expect(parseCodes('PWZNANIYA26, PWMIZAR2026HB;ABCD1234\nEFGH5678  IJKL9012').codes)
      .toEqual(['PWZNANIYA26', 'PWMIZAR2026HB', 'ABCD1234', 'EFGH5678', 'IJKL9012']);
  });
  it('повторы (без учёта регистра) убираются и считаются', () => {
    const p = parseCodes('ABCD1234, abcd1234, ABCD1234');
    expect(p.codes).toEqual(['ABCD1234']);
    expect(p.duplicates).toBe(2);
  });
  it('неподходящие куски попадают в invalid, а не молча теряются', () => {
    const p = parseCodes('ABCD1234, абвгд, x, ABC/DEF');
    expect(p.codes).toEqual(['ABCD1234']);
    expect(p.invalid).toEqual(['абвгд', 'x', 'ABC/DEF']);
  });
  it(`больше ${MAX_CODES} кодов: лишние не берутся, но их число известно`, () => {
    const raw = Array.from({ length: MAX_CODES + 3 }, (_, i) => `CODE${1000 + i}`).join(',');
    const p = parseCodes(raw);
    expect(p.codes).toHaveLength(MAX_CODES);
    expect(p.extra).toBe(3);
  });
  it('пустой ввод', () => {
    expect(parseCodes('  ,, \n ')).toEqual({ codes: [], invalid: [], duplicates: 0, extra: 0 });
    expect(parseCodes(null).codes).toEqual([]);
  });
});

describe('статусы', () => {
  it('«Уже введён» считается успехом, недействительные — отдельная группа', () => {
    expect(isOk('success') && isOk('already_used')).toBe(true);
    expect(isOk('unknown') || isOk('error') || isOk('expired')).toBe(false);
    expect(isInvalid('invalid_code') && isInvalid('expired')).toBe(true);
    expect(isInvalid('error')).toBe(false);
  });
  it('подписи', () => {
    expect(statusInfo('success').label).toBe('Введён');
    expect(statusInfo('nope').label).toBe('Ошибка');
    expect(rowLabel(row({ status: 'already_used', skipped: true }))).toBe('Уже введён ранее');
    expect(rowLabel(row({ status: 'already_used' }))).toBe('Уже введён');
    expect(rowLabel(row({ status: 'not_run', detail: 'Сайт не принял этот код у других персонажей — здесь он не вводился' }))).toContain('Сайт не принял этот код');
    expect(rowLabel(row({ status: 'not_run' }))).toBe('Пропущен');
  });
});

describe('rowFromPayload', () => {
  it('переносит ответ Rust-команды вместе с наградами', () => {
    const r = rowFromPayload(char, 'ABCD1234', { status: 'success', clicked: true, detail: 'ok', rewards: [{ name: ' Метеорит ', qty: 100, id: 47493, bound: true }, { name: '' }] }, null, NOW);
    expect(r).toMatchObject({ code: 'ABCD1234', charId: 'c1', nick: 'Ник', status: 'success', clicked: true, detail: 'ok', skipped: false, at: NOW.toISOString() });
    expect(r.rewards).toEqual([{ name: 'Метеорит', qty: 100, id: '47493', bound: true }]);
  });
  it('ошибка вызова или пустой ответ — статус error, кнопка не нажата', () => {
    expect(rowFromPayload(char, 'ABCD1234', null, new Error('boom'), NOW)).toMatchObject({ status: 'error', error: 'boom', clicked: false });
    expect(rowFromPayload(char, 'ABCD1234', undefined, undefined, NOW)).toMatchObject({ status: 'error', error: 'no_response' });
  });
  it('неизвестный статус превращается в error', () => {
    expect(rowFromPayload(char, 'ABCD1234', { status: 'weird' }, null, NOW).status).toBe('error');
  });
  it('награды: пустое и мусор → null', () => {
    expect(cleanRewards(null)).toBeNull();
    expect(cleanRewards([{ name: 5 }, null])).toBeNull();
    expect(rewardText([{ name: 'A', qty: 1 }, { name: 'B', qty: 5 }])).toBe('A; B ×5');
  });
});

describe('автоповтор и «Повторить ввод»', () => {
  it('автоповтор — только когда кнопка не нажата и причина временная', () => {
    expect(canAutoRetry(row({ status: 'challenge' }))).toBe(true);
    expect(canAutoRetry(row({ status: 'error', error: 'timeout' }), isTransient)).toBe(true);
    expect(canAutoRetry(row({ status: 'error', error: 'bad_code' }), isTransient)).toBe(false);
    expect(canAutoRetry(row({ status: 'not_logged_in' }), isTransient)).toBe(false);
    expect(canAutoRetry(row({ status: 'challenge', clicked: true }))).toBe(false);
    expect(canAutoRetry(row({ status: 'error', error: 'timeout', clicked: true }), isTransient)).toBe(false);
  });
  it('transient: таймаут и исключения скрипта', () => {
    expect(isTransient('timeout') && isTransient('exception_abc')).toBe(true);
    expect(isTransient('bad_code') || isTransient(null)).toBe(false);
  });
  it('«Повторить ввод» берёт неудачные, но не «нажато, ответ неясен»', () => {
    for (const status of ['error', 'challenge', 'not_logged_in', 'cancelled', 'not_run', 'invalid_code', 'expired']) expect(isRerunnable(row({ status })), status).toBe(true);
    expect(isRerunnable(row({ status: 'unknown', clicked: true }))).toBe(false);
    expect(isRerunnable(row({ status: 'success', clicked: true }))).toBe(false);
    expect(isRerunnable(row({ status: 'already_used', skipped: true }))).toBe(false);
  });
});

describe('summarize / summarizeByCode', () => {
  const rows = [
    row({ status: 'success', clicked: true, rewards: [{ name: 'A', qty: 1, id: null, bound: false }] }),
    row({ charId: 'c2', status: 'already_used', clicked: true }),
    row({ charId: 'c3', status: 'already_used', skipped: true }),
    row({ charId: 'c4', status: 'unknown', clicked: true }),
    row({ charId: 'c5', status: 'challenge' }),
    row({ charId: 'c6', status: 'not_run' }),
    row({ code: 'BAD00001', status: 'invalid_code', clicked: true, detail: 'Не добавлены бонусы' }),
    row({ code: 'BAD00001', charId: 'c2', status: 'invalid_code', clicked: true })
  ];
  it('общий итог', () => {
    expect(summarize(rows)).toEqual({ total: 8, ok: 3, entered: 1, alreadyUsed: 1, skipped: 1, invalid: 2, unknown: 1, notRun: 1, rerun: 4, dry: 0, failed: 1 });
  });
  it('итог по коду: награда и отклонение', () => {
    const [a, b] = summarizeByCode(rows, ['ABCD1234', 'BAD00001']);
    expect(a).toMatchObject({ ok: 3, entered: 1, alreadyUsed: 2, rejected: null });
    expect(a.rewards[0].name).toBe('A');
    expect(b).toMatchObject({ ok: 0, invalid: 2, rejected: { status: 'invalid_code', detail: 'Не добавлены бонусы', count: 2 } });
  });
  it('plainRow создаёт строку без запроса', () => {
    expect(plainRow(char, 'ABCD1234', 'cancelled', null, {}, NOW)).toMatchObject({ status: 'cancelled', clicked: false, skipped: false });
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
  it('toCsv: BOM, заголовок, строки', () => {
    const csv = toCsv(['A', 'B'], [['1', 'x;y']]);
    expect(csv).toBe('\ufeffA;B\r\n1;"x;y"');
  });
});
