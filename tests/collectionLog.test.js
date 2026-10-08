// Журнал запусков «Коллекции» в приложении (Issue #72): отчёты из окна недоверенные, дубли не нужны, вид логов и итоги.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeReport, recordCollectionReports, loadCollectionLog, clearCollectionLog, totalsOf, share, LOG_KEY, LOG_MAX
} from '../js/modules/automation/collectionStore.js';
import { collectionLogSource, detailsHtml, tableHtml, fmtDuration } from '../js/modules/automation/collectionLogView.js';
import { collectLogs } from '../js/core/logHub.js';

const report = (over = {}) => ({
  v: 1, id: 'abc12345', start: '2026-10-08T10:00:00.000Z', end: '2026-10-08T10:05:00.000Z', ms: 300000,
  target: 3, above: 'stop', maxCards: 0, opened: 40, unknown: 0,
  drops: { 1: 20, 2: 10, 3: 6, 4: 3, 5: 1 },
  claimed: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0, 6: 0 },
  promoted: { 1: 3, 2: 1, 3: 0, 4: 0, 5: 0 },
  left: 100, code: 'limit', kind: 'ok', message: 'Достигнут лимит запуска: 40 карт.', ...over
});

beforeEach(() => localStorage.clear());

describe('normalizeReport: отчёт из окна проверяется', () => {
  it('нормальный отчёт сохраняется как есть, ник добавляется приложением', () => {
    const e = normalizeReport(report(), 'Тёмный_Маг');
    expect(e).toMatchObject({ id: 'abc12345', at: '2026-10-08T10:00:00.000Z', nick: 'Тёмный_Маг', target: 3, above: 'stop', opened: 40, left: 100, kind: 'ok' });
    expect(e.drops).toEqual({ 1: 20, 2: 10, 3: 6, 4: 3, 5: 1 });
    expect(e.claimed[3]).toBe(1);
  });

  it.each([
    ['не объект', 'строка'],
    ['массив', []],
    ['нет id', report({ id: '' })],
    ['id с символами', report({ id: '../../x' })],
    ['нет даты', report({ start: 'вчера' })],
    ['цель вне 1–6', report({ target: 9 })]
  ])('отбрасывает: %s', (_n, raw) => {
    expect(normalizeReport(raw)).toBeNull();
  });

  it('числа ограничиваются, отрицательные и мусор становятся нулём; 6-я категория в выпадениях не хранится', () => {
    const e = normalizeReport(report({ opened: -5, drops: { 1: '7', 2: -3, 3: 'x', 4: 1e12, 5: 2, 6: 99 }, ms: 'много', maxCards: 1e9 }));
    expect(e.drops).toEqual({ 1: 7, 2: 0, 3: 0, 4: 1000000, 5: 2 });
    expect(e.drops[6]).toBeUndefined();
    expect(e.opened).toBeGreaterThanOrEqual(1000009);
    expect(e.ms).toBe(0);
    expect(e.maxCards).toBe(100000);
  });

  it('строки обрезаются, управляющие символы убираются, неизвестный kind становится ok', () => {
    const e = normalizeReport(report({ message: 'a\u0000b\n'.repeat(200), kind: 'hack', code: 'x<script>' }), 'N'.repeat(200));
    expect(e.message.length).toBeLessThanOrEqual(200);
    expect([...e.message].some(ch => ch.charCodeAt(0) < 32)).toBe(false);
    expect(e.kind).toBe('ok');
    expect(e.code).toBe('xscript');
    expect(e.nick.length).toBe(60);
  });
});

describe('журнал: запись, дубли, порядок, предел', () => {
  it('добавляет новые и пропускает уже записанные (окно может прислать отчёт повторно)', () => {
    expect(recordCollectionReports([report()])).toBe(1);
    expect(recordCollectionReports([report(), report({ id: 'second02', start: '2026-10-08T11:00:00.000Z' })])).toBe(1);
    expect(loadCollectionLog().map((e) => e.id)).toEqual(['second02', 'abc12345']);
  });

  it('ник берётся по id персонажа из окна; без ника остаётся id', () => {
    recordCollectionReports([{ ...report(), char: 'Temnyy_Mag' }, { ...report({ id: 'other123' }), char: 'Unknown' }], (id) => (id === 'Temnyy_Mag' ? 'Тёмный Маг' : ''));
    const byId = Object.fromEntries(loadCollectionLog().map((e) => [e.id, e.nick]));
    expect(byId).toEqual({ abc12345: 'Тёмный Маг', other123: 'Unknown' });
  });

  it('битые элементы не мешают остальным; не массив — ноль записей', () => {
    expect(recordCollectionReports([null, 5, 'x', report()])).toBe(1);
    expect(recordCollectionReports('мусор')).toBe(0);
  });

  it(`хранит не больше ${LOG_MAX} последних запусков`, () => {
    const many = Array.from({ length: LOG_MAX + 30 }, (_, i) => report({ id: `run${String(i).padStart(5, '0')}`, start: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    for (let i = 0; i < many.length; i += 50) recordCollectionReports(many.slice(i, i + 50));
    const log = loadCollectionLog();
    expect(log).toHaveLength(LOG_MAX);
    expect(log[0].id).toBe(`run${String(LOG_MAX + 29).padStart(5, '0')}`);
  });

  it('повреждённое хранилище не ломает чтение; очистка удаляет всё', () => {
    localStorage.setItem(LOG_KEY, '{не json');
    expect(loadCollectionLog()).toEqual([]);
    recordCollectionReports([report()]);
    clearCollectionLog();
    expect(loadCollectionLog()).toEqual([]);
  });

  it('запись нового отчёта сообщает об изменении журнала', () => {
    let n = 0;
    const off = collectionLogSource.subscribe(() => { n++; });
    recordCollectionReports([report()]);
    clearCollectionLog();
    off();
    expect(n).toBe(2);
  });
});

describe('totalsOf: итоги по прошлым запускам', () => {
  it('складывает категории, призы, обмены и время; скорость — карт в минуту', () => {
    const a = normalizeReport(report());
    const b = normalizeReport(report({ id: 'second02', opened: 20, ms: 100000, drops: { 1: 10, 2: 5, 3: 3, 4: 1, 5: 1 }, claimed: { 5: 1 }, promoted: { 5: 2 } }));
    const t = totalsOf([a, b]);
    expect(t.runs).toBe(2);
    expect(t.opened).toBe(60);
    expect(t.drops).toEqual({ 1: 30, 2: 15, 3: 9, 4: 4, 5: 2 });
    expect(t.claimed[3]).toBe(1);
    expect(t.claimed[5]).toBe(1);
    expect(t.promoted[5]).toBe(2);
    expect(t.ms).toBe(400000);
    expect(t.perMinute).toBe(9);
  });

  it('пустой набор и доли без деления на ноль', () => {
    const t = totalsOf([]);
    expect(t.opened).toBe(0);
    expect(t.perMinute).toBeNull();
    expect(share(0, 0)).toBe('0.0');
    expect(share(1, 4)).toBe('25.0');
  });
});

describe('вид логов «Коллекция»', () => {
  it('записи попадают в единый журнал: заголовок, ник, выпадения, призы, статус по итогу', () => {
    recordCollectionReports([
      { ...report(), char: 'Mag' },
      { ...report({ id: 'warn0001', start: '2026-10-08T12:00:00.000Z', opened: 0, drops: {}, kind: 'warn', message: 'проверка' }), char: 'Mag' }
    ], () => 'Маг');
    const { items, counts } = collectLogs({ source: 'collection' });
    expect(counts.collection).toBe(2);
    expect(items[0]).toMatchObject({ key: 'warn0001', status: 'warn', who: 'Маг' });
    expect(items[1]).toMatchObject({ key: 'abc12345', status: 'ok', title: 'Цель 3 · 40 карт' });
    expect(items[1].summary).toContain('1×20 · 2×10 · 3×6 · 4×3 · 5×1');
    expect(items[1].summary).toContain('3-я ×1');
  });

  it('подробности: таблица категорий, 6-я только обменом, ник экранируется', () => {
    const e = normalizeReport(report({ promoted: { 5: 2 } }), '<img src=x onerror=alert(1)>');
    const html = detailsHtml(e);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html).toContain('Открыто карточек: 40');
    expect(html).toContain('50.0%');
    expect(html).toContain('с карточек не падает');
    expect(html).toContain('получено 2');
    expect(tableHtml(totalsOf([e]))).toContain('обмен 5→6 ×2');
  });

  it('кнопка итогов недоступна при пустом журнале и открывается с записями', () => {
    expect(collectionLogSource.actions()[0].disabled).toBe(true);
    recordCollectionReports([report()]);
    expect(collectionLogSource.actions()[0].disabled).toBe(false);
    collectionLogSource.actions()[0].run();
    expect(document.body.textContent).toContain('Итоги по всем запускам');
  });

  it('длительность форматируется чч:мм:сс', () => {
    expect(fmtDuration(3723000)).toBe('01:02:03');
    expect(fmtDuration(-5)).toBe('00:00:00');
  });
});
