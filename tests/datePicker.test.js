import { describe, it, expect, beforeEach } from 'vitest';
import { enhanceDateInputs, monthGrid, formatDateRu } from '../js/core/datePicker.js';

describe('календарь выбора даты (как у ручных отметок марафона)', () => {
  it('сетка месяца: неделя с понедельника', () => {
    const g = monthGrid(2026, 9);                  // октябрь 2026: 1-е — четверг
    expect(g.firstDow).toBe(3);
    expect(g.days).toHaveLength(31);
    expect(g.days[0]).toBe('2026-10-01');
    expect(monthGrid(2024, 1).days).toHaveLength(29);   // февраль високосного года
    expect(monthGrid(2026, 5).firstDow).toBe(0);        // 1 июня 2026 — понедельник
  });
  it('формат дд.мм.гггг', () => {
    expect(formatDateRu('2026-04-25')).toBe('25.04.2026');
    expect(formatDateRu('')).toBe('');
    expect(formatDateRu('мусор')).toBe('');
  });

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"><input class="input" type="date" data-f="startDate" value="2026-04-25"/><input class="input" type="date" data-f="endDate" value=""/></div>';
  });

  it('input[type=date] заменяется скрытым полем с тем же data-f и кнопкой с датой', () => {
    enhanceDateInputs(document.getElementById('root'));
    expect(document.querySelector('input[type="date"]')).toBeNull();
    const hidden = document.querySelector('input[data-f="startDate"]');
    expect(hidden.type).toBe('hidden');
    expect(hidden.value).toBe('2026-04-25');
    const btns = document.querySelectorAll('[data-dp-btn]');
    expect(btns[0].textContent).toContain('25.04.2026');
    expect(btns[1].textContent).toContain('Выберите дату');
  });

  it('выбор дня в календаре пишет ГГГГ-ММ-ДД в поле и вызывает input/change', () => {
    enhanceDateInputs(document.getElementById('root'));
    const hidden = document.querySelector('input[data-f="startDate"]');
    const events = [];
    hidden.addEventListener('input', () => events.push('input'));
    hidden.addEventListener('change', () => events.push('change'));
    document.querySelectorAll('[data-dp-btn]')[0].click();
    const pop = document.querySelector('.tf-dp-pop');
    expect(pop.textContent).toContain('Апрель 2026');
    expect(pop.querySelector('.mr-cal-day.is-marked').dataset.dpDay).toBe('2026-04-25');   // выбранный день подсвечен как «отмечено»
    pop.querySelector('[data-dp-nav="1"]').click();                                        // следующий месяц
    expect(document.querySelector('.tf-dp-pop').textContent).toContain('Май 2026');
    document.querySelector('[data-dp-day="2026-05-17"]').click();
    expect(hidden.value).toBe('2026-05-17');
    expect(events).toEqual(['input', 'change']);
    expect(document.querySelector('.tf-dp-pop')).toBeNull();                               // календарь закрылся
    expect(document.querySelectorAll('[data-dp-btn]')[0].textContent).toContain('17.05.2026');
  });

  it('Escape закрывает календарь без изменений', () => {
    enhanceDateInputs(document.getElementById('root'));
    document.querySelectorAll('[data-dp-btn]')[0].click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.tf-dp-pop')).toBeNull();
    expect(document.querySelector('input[data-f="startDate"]').value).toBe('2026-04-25');
  });
});
