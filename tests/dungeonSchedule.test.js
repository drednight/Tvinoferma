// Циклический календарь данжей (js/modules/dungeons/schedule.js).
// Опора из игры: 10.06.2026 — «Оружие». Цикл: Реликвия → Оружие → Доспех → Реликвия → …
import { describe, it, expect } from 'vitest';

import {
  DUNGEON_CYCLE, ANCHOR_DATE, ANCHOR_DUNGEON, DUNGEON_COLORS,
  daysBetween, shiftDate, dungeonForDate, dungeonInfoForDate, dungeonStrip
} from '../js/modules/dungeons/schedule.js';

const day = (offset, base = ANCHOR_DATE) => shiftDate(base, offset);

describe('опора цикла', () => {
  it('10.06.2026 — день «Оружие»', () => {
    expect(ANCHOR_DUNGEON).toBe('weapon');
    expect(dungeonForDate(ANCHOR_DATE)).toBe('weapon');
  });

  it('цвета категорий: Оружие — красный, Доспех — зелёный, Реликвия — синий', () => {
    expect(DUNGEON_COLORS).toEqual({ weapon: 'red', armor: 'green', relic: 'blue' });
  });

  it('порядок цикла: Реликвия → Оружие → Доспех', () => {
    expect(DUNGEON_CYCLE).toEqual(['relic', 'weapon', 'armor']);
  });
});

describe('расписание на даты', () => {
  it('вперёд от опоры: 11.06 — Доспех, 12.06 — Реликвия, 13.06 — снова Оружие', () => {
    expect(dungeonForDate(day(1))).toBe('armor');
    expect(dungeonForDate(day(2))).toBe('relic');
    expect(dungeonForDate(day(3))).toBe('weapon');
    expect(dungeonForDate(day(4))).toBe('armor');
    expect(dungeonForDate(day(5))).toBe('relic');
  });

  it('назад от опоры: 09.06 — Реликвия, 08.06 — Доспех (цикл работает и в прошлое)', () => {
    expect(dungeonForDate(day(-1))).toBe('relic');
    expect(dungeonForDate(day(-2))).toBe('armor');
    expect(dungeonForDate(day(-3))).toBe('weapon');
    expect(dungeonForDate(day(-6))).toBe('weapon');
  });

  it('через месяц и год остаток деления не сбивается', () => {
    expect(dungeonForDate(day(30))).toBe(dungeonForDate(day(0)));   // 30 = 3×10, цикл целыми
    // 363 = 3×121 — снова Оружие; дальше цикл продолжается без сдвига
    expect(dungeonForDate(day(363))).toBe('weapon');
    expect(dungeonForDate(day(364))).toBe('armor');
    expect(dungeonForDate(day(365))).toBe('relic');
  });

  it('полоса на неделю: вчера → +5 дней, каждый день знает свой цвет', () => {
    const strip = dungeonStrip(day(-1), day(5));
    expect(strip).toHaveLength(7);
    expect(strip[0].date).toBe(day(-1));
    expect(strip[6].date).toBe(day(5));
    expect(strip.map(d => d.color)).toEqual(strip.map(d => DUNGEON_COLORS[d.key]));
  });

  it('битые даты дают null и не ломают полосу', () => {
    expect(dungeonForDate('')).toBeNull();
    expect(dungeonForDate('не дата')).toBeNull();
    expect(dungeonInfoForDate('')).toBeNull();
    expect(dungeonStrip('', day(1))).toEqual([]);
  });

  it('дни между датами и сдвиг считаются без часовых поясов', () => {
    expect(daysBetween('2026-06-10', '2026-06-11')).toBe(1);
    expect(daysBetween('2026-06-11', '2026-06-10')).toBe(-1);
    expect(shiftDate('2026-06-30', 1)).toBe('2026-07-01');   // через границу месяца
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');   // через границу года
    expect(shiftDate('2024-03-01', -1)).toBe('2024-02-29');  // високосный год
  });
});
