import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STATS_HISTORY_LIMIT, rememberStatsBefore, previousStat, statChange, statsDiff, statsChangeLog, statsHistory
} from '../js/modules/characters/statsHistory.js';
import { normalizeState } from '../js/core/state.js';

// История характеристик: снимок «до изменения» + разница, которую видно в профиле и в форме
const stats = (over = {}) => ({ hp: 100, mp: 50, strength: 10, ...over });
const charWith = (current, history = []) => ({ stats: current, statsHistory: history });

describe('история характеристик', () => {
  it('запоминает значения, которые были до изменения', () => {
    const char = charWith(stats({ hp: 120 }), []);
    rememberStatsBefore(char, stats({ hp: 100 }), '2026-10-01T10:00:00Z');
    expect(char.statsHistory).toHaveLength(1);
    expect(char.statsHistory[0].at).toBe('2026-10-01T10:00:00Z');
    expect(char.statsHistory[0].stats.hp).toBe(100);
    expect(char.statsHistory[0].stats.mp).toBe(50);
  });

  it('если ничего не поменялось — снимка нет (иначе история забивалась бы пустыми записями)', () => {
    const char = charWith(stats());
    rememberStatsBefore(char, stats());
    expect(statsHistory(char)).toEqual([]);
  });

  it('снимков не больше лимита, новые сверху', () => {
    const char = charWith(stats({ hp: 100 + STATS_HISTORY_LIMIT }), []);
    const day = (n) => `2026-10-${String(n).padStart(2, '0')}T10:00:00Z`;
    for (let i = 1; i <= STATS_HISTORY_LIMIT + 5; i++) {
      rememberStatsBefore(char, stats({ hp: i }), day(i));
    }
    expect(char.statsHistory).toHaveLength(STATS_HISTORY_LIMIT);
    // новейший снимок — самый свежий, он в начале
    expect(char.statsHistory[0].at).toBe(day(STATS_HISTORY_LIMIT + 5));
  });

  it('разница считается от ближайшего снимка, где значение отличается', () => {
    // Меняли два раза: 100 → 80 → 95. Для «сейчас» прошлым было 80, а не 100
    const char = charWith(stats({ hp: 95 }), [
      { at: '2026-10-02T10:00:00Z', stats: stats({ hp: 80 }) },
      { at: '2026-10-01T10:00:00Z', stats: stats({ hp: 100 }) }
    ]);
    expect(statChange(char, 'hp')).toMatchObject({ current: 95, previous: 80, delta: 15 });
    // Неизменённая характеристика разницы не показывает
    expect(statChange(char, 'mp')).toBeNull();
    expect(previousStat(char, 'strength')).toBeNull();
  });

  it('уменьшение значения даёт отрицательную разницу', () => {
    const char = charWith(stats({ hp: 70 }), [{ at: '2026-10-01T10:00:00Z', stats: stats({ hp: 100 }) }]);
    expect(statChange(char, 'hp').delta).toBe(-30);
  });

  it('истории нет — показывать нечего', () => {
    expect(statChange(charWith(stats()), 'hp')).toBeNull();
    expect(statsHistory(charWith(stats()))).toEqual([]);
    // Мусор в state.json не ломает чтение
    expect(statsHistory(charWith(stats(), ['строка', null, { stats: stats({ hp: 1 }) }])).length).toBe(1);
  });

  it('список изменений собирается по датам: что и на сколько', () => {
    // Два изменения подряд: сначала просели 20 здоровья и выросла сила на 2, потом вернулось 15 здоровья
    const char = charWith(stats({ hp: 95, strength: 12 }), [
      { at: '2026-10-02T10:00:00Z', stats: stats({ hp: 80, strength: 12 }) },
      { at: '2026-10-01T10:00:00Z', stats: stats({ hp: 100, strength: 10 }) }
    ]);
    const log = statsChangeLog(char);
    expect(log[0].at).toBe('2026-10-02T10:00:00Z');
    expect(log[0].changes).toEqual([{ key: 'hp', from: 80, to: 95, delta: 15 }]);
    // Второй снимок: от 100 до 80 = −20 по здоровью, сила выросла на 2
    expect(log[1].changes).toEqual([
      { key: 'hp', from: 100, to: 80, delta: -20 },
      { key: 'strength', from: 10, to: 12, delta: 2 }
    ]);
    expect(statsDiff({ a: 1 }, { a: 1 })).toEqual([]);
    // Характеристика, которой нет в одном из наборов, не считается изменившейся
    expect(statsDiff({ a: 1 }, { b: 2 })).toEqual([]);
  });

  it('история переживает перезапуск: нормализация настроек её сохраняет', () => {
    const s = normalizeState({
      characters: [],
      settings: {},
      archivedCharacters: [{
        id: 'c1', nick: 'Герой',
        stats: stats({ hp: 95 }),
        statsHistory: [{ at: '2026-10-02T10:00:00Z', stats: stats({ hp: 80 }) }, 'мусор']
      }]
    });
    expect(s.archivedCharacters[0].statsHistory).toHaveLength(1);
    expect(s.archivedCharacters[0].statsHistory[0].stats.hp).toBe(80);
    // Приведённые к числам: в state.json могли прийти строками
    expect(normalizeState({ characters: [], archivedCharacters: [{ id: 'c2', statsHistory: [{ at: null, stats: { hp: '95' } }] }] })
      .archivedCharacters[0].statsHistory[0].stats.hp).toBe(95);
    // Старые файлы без истории остаются рабочими
    expect(normalizeState({ characters: [], archivedCharacters: [{ id: 'c3', stats: stats() }] })
      .archivedCharacters[0].statsHistory).toEqual([]);
  });
});

describe('разница в профиле и в форме', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="modal-root"></div>';
  });

  it('в профиле рядом со значением показывается разница: вверх зелёная, вниз красная', async () => {
    vi.doMock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));
    const { openCharacterProfile } = await import('../js/modules/characters/profileView.js');
    openCharacterProfile({
      id: 'c1', nick: 'Ник', class: 'Маг', level: 10,
      stats: { hp: 120, mp: 40, strength: 10 },
      statsHistory: [{ at: new Date().toISOString(), stats: { hp: 100, mp: 50, strength: 10 } }]
    });
    await new Promise(r => setTimeout(r, 150));

    const row = [...document.querySelectorAll('.pf-stat')].find(r => r.textContent.includes('Здоровье'));
    expect(row.querySelector('.pf-stat-value').textContent).toBe('120');
    const up = row.querySelector('.pf-stat-delta');
    expect(up.textContent).toBe('+20');
    expect(up.classList.contains('is-up')).toBe(true);
    expect(row.getAttribute('title')).toContain('Прошлое значение: 100');

    // Упавшее значение — красным вниз
    const down = [...document.querySelectorAll('.pf-stat')].find(r => r.textContent.includes('Маг. энергия'))
      .querySelector('.pf-stat-delta');
    expect(down.textContent).toBe('−10');
    expect(down.classList.contains('is-down')).toBe(true);

    // Неизменённая характеристика разницы не показывает
    const same = [...document.querySelectorAll('.pf-stat')].find(r => r.textContent.includes('Сила'));
    expect(same.querySelector('.pf-stat-delta')).toBeNull();

    // Панель последних изменений перечисляет, что и на сколько поменялось
    const log = document.querySelector('.pf-changes');
    expect(log.textContent).toContain('Здоровье');
    expect(log.textContent).toContain('+20');
    expect(log.textContent).toContain('−10');
  });

  it('без истории показывается пояснение, а не пустая панель', async () => {
    const { openCharacterProfile } = await import('../js/modules/characters/profileView.js');
    openCharacterProfile({ id: 'c1', nick: 'Ник', stats: { hp: 10 } });
    await new Promise(r => setTimeout(r, 150));
    expect(document.querySelector('.pf-changes').textContent).toContain('Изменений пока не было');
    expect(document.querySelector('.pf-stat-delta')).toBeNull();
  });

  it('в форме под полем — прошлое значение, а разница пересчитывается при вводе', async () => {
    vi.doMock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}) }));
    const { openCharacterForm } = await import('../js/modules/characters/formEditor.js');
    openCharacterForm({
      id: 'c1', nick: 'Ник', contacts: {},
      stats: { hp: 120 },
      statsHistory: [{ at: '2026-10-02T10:00:00Z', stats: { hp: 100 } }]
    });
    const hint = document.querySelector('.cf-prev[data-prev="hp"]');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain('было 100');
    await new Promise(r => setTimeout(r, 20));   // разница считается при показе формы
    const input = document.querySelector('input[name="stat-hp"]');
    const delta = hint.querySelector('.cf-prev-delta');
    expect(delta.textContent).toBe('+20');
    expect(delta.classList.contains('is-up')).toBe(true);

    // Пользователь правит поле — разница меняется вместе со значением
    input.value = '90';
    input.dispatchEvent(new Event('input'));
    expect(delta.textContent).toBe('−10');
    expect(delta.classList.contains('is-down')).toBe(true);

    input.value = '100';
    input.dispatchEvent(new Event('input'));
    expect(delta.textContent).toBe('');   // вернулись к прошлому значению — разницы нет
  });
});