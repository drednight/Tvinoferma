// js/modules/servers/mskClock.js
// Часы по Москве «ЧЧ:ММ:СС» над плашкой «Статус серверов».
// Время считается через js/core/msk.js (Intl, пояс Europe/Moscow), поэтому не зависит от часового пояса
// компьютера. Разметка рисуется один раз, затем раз в секунду меняется только текст цифр:
// без перерисовки и без мерцания. Тик выровнен по границе секунды, чтобы секунды шли точно.

import { mskTimeSeconds } from '../../core/msk.js';

/** Разметка часов: подпись, смещение пояса и три группы цифр. */
export function mskClockHtml(value = new Date()) {
  const [h, m, s] = (mskTimeSeconds(value) || '--:--:--').split(':');
  return `<div class="msk-clock-head"><span class="msk-clock-dot" aria-hidden="true"></span>`
    + `<span class="msk-clock-label">Московское время</span><span class="msk-clock-zone">UTC+3</span></div>`
    + `<div class="msk-clock-time" aria-label="Московское время">`
    + `<b data-part="h">${h}</b><i aria-hidden="true">:</i><b data-part="m">${m}</b><i aria-hidden="true">:</i><b data-part="s">${s}</b></div>`;
}

/**
 * Рисует часы в элемент и обновляет их каждую секунду.
 * @param {HTMLElement|null} el
 * @param {{ now?: () => Date }} [opts]
 * @returns {() => void} остановка
 */
export function mountMskClock(el, { now = () => new Date() } = {}) {
  if (!el) return () => {};
  el.innerHTML = mskClockHtml(now());
  const parts = {
    h: el.querySelector('[data-part="h"]'),
    m: el.querySelector('[data-part="m"]'),
    s: el.querySelector('[data-part="s"]')
  };
  let timer = 0;
  const tick = () => {
    const d = now();
    const [h, m, s] = (mskTimeSeconds(d) || '--:--:--').split(':');
    if (parts.h.textContent !== h) parts.h.textContent = h;
    if (parts.m.textContent !== m) parts.m.textContent = m;
    if (parts.s.textContent !== s) parts.s.textContent = s;
    timer = setTimeout(tick, 1000 - (d.getTime() % 1000) + 5);
  };
  tick();
  return () => clearTimeout(timer);
}
