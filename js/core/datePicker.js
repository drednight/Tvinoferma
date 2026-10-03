// js/core/datePicker.js
// Календарь выбора даты в том же виде, что и календарь ручных отметок марафона (.mr-cal / .mr-cal-day).
// Вместо системного <input type="date"> подставляется кнопка с датой «дд.мм.гггг» и скрытое поле
// с датой в формате ГГГГ-ММ-ДД: остальной код по-прежнему читает input.value, как и раньше.

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const pad = (n) => String(n).padStart(2, '0');
export const toIso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;          // m — 0..11
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const todayIso = () => { const t = new Date(); return toIso(t.getFullYear(), t.getMonth(), t.getDate()); };

/** «2026-10-02» → «02.10.2026» (пусто, если даты нет). */
export const formatDateRu = (iso) => isIso(iso) ? `${iso.slice(8)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';

/** Сетка месяца: сколько пустых ячеек до 1-го числа (неделя с понедельника) и список дат. */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const firstDow = (first.getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  return { firstDow, days: Array.from({ length: count }, (_, i) => toIso(year, month, i + 1)) };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

let openPopup = null;
function closePopup() { openPopup?.remove(); openPopup = null; }

function showPopup(anchor, hidden, onPick) {
  closePopup();
  const selected = isIso(hidden.value) ? hidden.value : '';
  const base = selected ? new Date(selected + 'T00:00:00') : new Date();
  let year = base.getFullYear(), month = base.getMonth();

  const pop = document.createElement('div');
  pop.className = 'tf-dp-pop';
  openPopup = pop;
  const draw = () => {
    const { firstDow, days } = monthGrid(year, month);
    const today = todayIso();
    pop.innerHTML = `
      <div class="tf-dp-head">
        <button type="button" class="btn small" data-dp-nav="-1" title="Предыдущий месяц">‹</button>
        <strong>${MONTHS[month]} ${year}</strong>
        <button type="button" class="btn small" data-dp-nav="1" title="Следующий месяц">›</button>
      </div>
      <div class="mr-cal">
        ${DOW.map(d => `<div class="mr-cal-dow">${d}</div>`).join('')}
        ${'<div></div>'.repeat(firstDow)}
        ${days.map(d => `<button type="button" class="mr-cal-day is-normal ${d === selected ? 'is-marked' : ''} ${d === today ? 'is-today' : ''}" data-dp-day="${d}"><span>${Number(d.slice(8))}</span></button>`).join('')}
      </div>
      <div class="tf-dp-foot"><button type="button" class="btn small ghost" data-dp-today>Сегодня</button></div>`;
    pop.querySelectorAll('[data-dp-nav]').forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      month += Number(b.dataset.dpNav);
      if (month < 0) { month = 11; year--; } else if (month > 11) { month = 0; year++; }
      draw();
    });
    pop.querySelectorAll('[data-dp-day]').forEach(b => b.onclick = (e) => { e.stopPropagation(); onPick(b.dataset.dpDay); closePopup(); });
    pop.querySelector('[data-dp-today]').onclick = (e) => { e.stopPropagation(); onPick(todayIso()); closePopup(); };
  };
  draw();
  document.body.appendChild(pop);

  // позиция под кнопкой (или над ней, если снизу не помещается)
  const r = anchor.getBoundingClientRect();
  const h = pop.offsetHeight || 300, w = pop.offsetWidth || 280;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  pop.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;

  const off = (e) => {
    if (!document.body.contains(pop)) { document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', esc2, true); return; }
    if (!pop.contains(e.target) && e.target !== anchor) { closePopup(); document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', esc2, true); }
  };
  const esc2 = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopup(); document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', esc2, true); } };
  document.addEventListener('mousedown', off, true);
  document.addEventListener('keydown', esc2, true);
}

/**
 * Заменяет все input[type=date] внутри root на кнопку-календарь.
 * Скрытое поле сохраняет атрибуты (data-f и т.д.) и значение; при выборе даты на нём вызываются `input` и `change`.
 */
export function enhanceDateInputs(root) {
  root.querySelectorAll('input[type="date"]').forEach(inp => {
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    [...inp.attributes].forEach(a => { if (a.name !== 'type' && a.name !== 'class') hidden.setAttribute(a.name, a.value); });
    hidden.value = inp.value;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'input tf-dp-btn';
    btn.setAttribute('data-dp-btn', '');
    const paint = () => { btn.innerHTML = `<span>${esc(formatDateRu(hidden.value) || 'Выберите дату')}</span><span aria-hidden="true">📅</span>`; };
    paint();
    btn.onclick = () => {
      if (openPopup) { closePopup(); return; }
      showPopup(btn, hidden, (iso) => {
        hidden.value = iso; paint();
        hidden.dispatchEvent(new Event('input', { bubbles: true }));
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    inp.replaceWith(hidden, btn);
  });
}
