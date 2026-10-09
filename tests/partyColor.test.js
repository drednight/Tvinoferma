// Цвет пати (js/modules/parties/color.js + state.js):
// пользователь выбирает его сам кнопкой 🎨, без выбора работает оттенок по названию.
import { describe, it, expect } from 'vitest';

import {
  PARTY_COLORS,
  partyHue,
  hexToHsl,
  hslToHex,
  partyColorCss,
  partyStyleVars
} from '../js/modules/parties/color.js';
import { normalizePartyColor, normalizeState } from '../js/core/state.js';
import { NO_PARTY_LABEL } from '../js/modules/parties/membership.js';

describe('выбор цвета пати', () => {
  it('палитра состоит из корректных hex-цветов и без повторов', () => {
    expect(PARTY_COLORS.length).toBeGreaterThanOrEqual(12);
    for (const color of PARTY_COLORS) {
      expect(hexToHsl(color), color).not.toBeNull();
    }
    expect(new Set(PARTY_COLORS).size).toBe(PARTY_COLORS.length);
  });

  it('hex разбирается в HSL, пригодный для hsl() в CSS', () => {
    expect(hexToHsl('#ff0000')).toEqual({ h: 0, s: 100, l: 50 });
    expect(hexToHsl('#00ff00')).toEqual({ h: 120, s: 100, l: 50 });
    expect(hexToHsl('#0000ff')).toEqual({ h: 240, s: 100, l: 50 });
    // Серый: насыщенность нулевая, оттенок всё равно число — иначе hsl() невалиден
    expect(hexToHsl('#808080')).toEqual({ h: 0, s: 0, l: 50 });
  });

  it('не-цвет не разбирается и не ломает разметку', () => {
    expect(hexToHsl('')).toBeNull();
    expect(hexToHsl(null)).toBeNull();
    expect(hexToHsl('нет')).toBeNull();
    expect(hexToHsl('#12345')).toBeNull();
    expect(hexToHsl('rgb(1,2,3)')).toBeNull();
    // Регистр и отсутствие решётки не мешают
    expect(hexToHsl('5865F2')).toEqual(hexToHsl('#5865f2'));
  });

  it('hex → HSL → hex возвращает практически тот же цвет', () => {
    // `hexToHsl` округляет компоненты до целых (иначе в CSS попадают длинные дробные значения),
    // поэтому обратный переход смещается. Ошибка в 1/255 по HSL даёт до ~3/255 по каналу RGB,
    // поэтому сверяем «на глаз»: расхождение меньше 2% диапазона.
    const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    for (const color of PARTY_COLORS) {
      const back = hslToHex(hexToHsl(color));
      expect(hexToHsl(back), color).not.toBeNull();
      for (const i of [0, 1, 2]) {
        expect(Math.abs(channel(color, i) - channel(back, i)), `${color} канал ${i}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('выбранный цвет важнее оттенка по названию', () => {
    const withColor = partyStyleVars('Пати', { color: '#ff0000' });
    const auto = partyStyleVars('Пати', { color: null });
    expect(withColor).not.toBe(auto);
    // Выбранный красный даёт оттенок 0 — иначе он бы не применился
    expect(withColor).toContain('--pt-h:0;');
    expect(partyHue('Пати')).not.toBe(0);
  });

  it('без выбранного цвета остаётся прежний вид: оттенок по названию', () => {
    expect(partyStyleVars('Пати', { color: null })).toBe(`--pt-h:${partyHue('Пати')};--pt-s:70%;--pt-l:65%`);
    expect(partyStyleVars('Пати', null)).toBe(partyStyleVars('Пати', { color: null }));
    // Битый цвет в файле не должен ломать карточку — уходим на оттенок по названию
    expect(partyStyleVars('Пати', { color: 'мусор' })).toBe(partyStyleVars('Пати', { color: null }));
  });

  it('«Без пати» всегда нейтральная: её нельзя покрасить', () => {
    expect(partyStyleVars(NO_PARTY_LABEL, { color: '#ff0000' })).toBe('--pt-h:220;--pt-s:8%;--pt-l:42%');
    expect(partyColorCss({ name: NO_PARTY_LABEL, color: '#ff0000' })).toBe('');
  });

  it('цвет для бейджа на карточке персонажа', () => {
    expect(partyColorCss({ name: 'Пати', color: '#57F287' })).toBe('hsl(139 86% 65%)');
    expect(partyColorCss({ name: 'Пати', color: null })).toBe(`hsl(${partyHue('Пати')} 70% 65%)`);
    expect(partyColorCss(null)).toBe('');
  });

  it('нормализация принимает только #rrggbb и приводит к нижнему регистру', () => {
    expect(normalizePartyColor('#AABBCC')).toBe('#aabbcc');
    expect(normalizePartyColor('  #aabbcc  ')).toBe('#aabbcc');
    expect(normalizePartyColor('#abc')).toBeNull();
    expect(normalizePartyColor('aabbcc')).toBeNull();
    expect(normalizePartyColor('')).toBeNull();
    expect(normalizePartyColor(null)).toBeNull();
    expect(normalizePartyColor('red; background: url(x)')).toBeNull();
  });

  it('цвет пати переживает загрузку и нормализацию состояния', () => {
    const st = normalizeState({
      schemaVersion: 8,
      parties: [{ id: 'p1', name: 'Пати', order: 1, color: '#57F287' }],
      characters: []
    });
    expect(st.parties[0].color).toBe('#57f287');
    // Старая пати без цвета остаётся рабочей: цвет пустой, карточка красится по названию
    const old = normalizeState({
      schemaVersion: 8,
      parties: [{ id: 'p1', name: 'Пати', order: 1 }],
      characters: []
    });
    expect(old.parties[0].color).toBeNull();
    // Испорченный цвет из файла отбрасывается, а не попадает в разметку
    const broken = normalizeState({
      schemaVersion: 8,
      parties: [{ id: 'p1', name: 'Пати', order: 1, color: '"><script>' }],
      characters: []
    });
    expect(broken.parties[0].color).toBeNull();
  });
});
