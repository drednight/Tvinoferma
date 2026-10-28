// @ts-check
// js/modules/parties/color.js
// Цвет карточки пати: автоматический оттенок по названию и цвет, выбранный пользователем.
//
// Модуль без DOM и без импорта state — поэтому его можно использовать и из рендера пати,
// и из списка персонажей, и из окон настроек, без циклических зависимостей.

import { NO_PARTY_LABEL } from './membership.js';

/**
 * Палитра для выбора цвета пати.
 *
 * Подобрана под тёмную тему приложения: цвета насыщенные (их видно на полоске карточки и на
 * значке), но не светят и не сливаются с тёмным фоном. Свой цвет можно выбрать и вручную —
 * кнопкой «Свой цвет» открывается системный выбор.
 */
export const PARTY_COLORS = [
  '#5865F2',
  '#57F287',
  '#FEE75C',
  '#EB459E',
  '#ED4245',
  '#FF7043',
  '#00BCD4',
  '#AB47BC',
  '#26A69A',
  '#9CCC65',
  '#FFB300',
  '#F06292',
  '#7986CB',
  '#4DD0E1',
  '#BA68C8',
  '#A1887F'
];

/** Светлота, которая была у автоматического оттенка до появления выбора цвета. */
const AUTO_L = 65;
/** Насыщенность автоматического оттенка. */
const AUTO_S = 70;

/** Оттенок пати (0–359) по названию: у каждой пати свой стабильный цвет полоски и значка. */
export function partyHue(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/**
 * `#rrggbb` → компоненты HSL, которыми оформлена карточка (`--pt-h`, `--pt-s`, `--pt-l`).
 *
 * Зачем конвертация: стили карточки построены на `hsl(var(--pt-h) var(--pt-s) …)`. Пользователь
 * выбирает обычный hex, поэтому здесь он переводится в те же компоненты, и выбранный цвет попадает
 * ровно в те же места, что и автоматический оттенок (полоска слева, значок, подсветка, кнопка
 * запуска) — вид карточки не меняется.
 *
 * @param {string} hex
 * @returns {{ h: number, s: number, l: number } | null} `null` — значение не цвет
 */
export function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  // Серая точка: насыщенность 0, оттенок не имеет значения (но должен быть числом для hsl())
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** HSL → `#rrggbb`. */
export function hslToHex(hsl) {
  const h = Number(hsl?.h) || 0;
  const s = (Number(hsl?.s) || 0) / 100;
  const l = (Number(hsl?.l) || 0) / 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const v = l - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Цвет пати в виде готового CSS-значения: сначала выбранный пользователем, иначе оттенок по названию.
 *
 * @param {{ name?: string, color?: string | null } | null} party
 * @returns {string} `hsl(...)` или пустая строка, если пати нет или это «Без пати»
 */
export function partyColorCss(party) {
  if (!party || party.name === NO_PARTY_LABEL) return '';
  const chosen = hexToHsl(party.color);
  if (chosen) return `hsl(${chosen.h} ${chosen.s}% ${chosen.l}%)`;
  return autoColorCss(party.name);
}

/** Автоматический оттенок по названию пати в виде CSS-значения. */
export function autoColorCss(name) {
  if (!name || name === NO_PARTY_LABEL) return '';
  return `hsl(${partyHue(name)} ${AUTO_S}% ${AUTO_L}%)`;
}

/**
 * Стиль карточки пати: свой цвет пользователя, если он выбран, иначе оттенок по названию.
 * «Без пати» — всегда нейтральный серый: это не пати, и красить её незачем.
 *
 * @param {string} name название группы (может быть NO_PARTY_LABEL)
 * @param {{ color?: string | null } | null} party объект пати
 * @returns {string} значение атрибута style
 */
export function partyStyleVars(name, party) {
  if (name === NO_PARTY_LABEL) return '--pt-h:220;--pt-s:8%;--pt-l:42%';
  const chosen = party ? hexToHsl(party.color) : null;
  if (chosen) return `--pt-h:${chosen.h};--pt-s:${chosen.s}%;--pt-l:${chosen.l}%`;
  return `--pt-h:${partyHue(name)};--pt-s:${AUTO_S}%;--pt-l:${AUTO_L}%`;
}
