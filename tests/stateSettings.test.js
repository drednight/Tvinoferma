// tests/stateSettings.test.js
// Настройки не должны «теряться по дороге».
//
// Правило размазано по двум файлам: умолчания живут в DEFAULT_SETTINGS (js/core/constants.js),
// а приведение к схеме — в mergeSettings (js/core/state/settings.js). Группа там начинается
// со spread'а умолчаний, и это создаёт ловушку: стоит забыть явную строку для группы с
// вложенным объектом, как сохранённый кусок (`tray: { minimize: true }`) затрёт остальные
// умолчания группы (`tray: { icon: true, ... }`) — без ошибки и без предупреждения.
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../js/core/constants.js';
import { normalizeState } from '../js/core/state.js';

/** Ключи группы, которые задаёт сама нормализация, а не слияние с умолчаниями. */
const isFlat = (group) => Object.values(group).every(v => v === null || typeof v !== 'object');

describe('настройки переживают нормализацию', () => {
  it('пустой state.json даёт полный набор настроек', () => {
    const s = normalizeState({});
    for (const group of Object.keys(DEFAULT_SETTINGS)) {
      expect(s.settings[group], `группа настроек «${group}» пропала`).toBeDefined();
    }
  });

  it('каждая группа на месте, даже если в файле вместо неё мусор', () => {
    // Худший случай: битый state.json. Настройки должны вернуться к умолчаниям,
    // а не исчезнуть вместе с мусором
    const junk = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(g => [g, 'не объект']));
    const s = normalizeState({ settings: junk });
    for (const group of Object.keys(DEFAULT_SETTINGS)) {
      expect(s.settings[group], `группа настроек «${group}» потерялась на мусоре`).toBeDefined();
    }
  });

  it('сохранённый ключ не затирает остальные умолчания своей группы', () => {
    // Главная проверка. В файле у каждой группы оставлен один ключ — как если бы
    // человек поменял одну галочку. Все остальные ключи группы должны остаться умолчаниями.
    for (const [name, def] of Object.entries(DEFAULT_SETTINGS)) {
      const keys = Object.keys(def);
      if (!keys.length) continue;
      const [first] = keys;
      const s = normalizeState({ settings: { [name]: { [first]: '☐ сломанное значение' } } });
      const got = s.settings[name];
      expect(got && typeof got === 'object', `группа «${name}» не пережила нормализацию`).toBeTruthy();
      const lost = keys.filter(k => !(k in got));
      expect(lost, `«${name}» потерял ключи: ${lost.join(', ')}`).toEqual([]);
      // Для групп с вложенными объектами проверяем и их: потеряется и второй уровень
      if (!isFlat(def)) {
        for (const [k, v] of Object.entries(def)) {
          if (v && typeof v === 'object') {
            expect(Object.keys(v).filter(x => !(x in (got[k] || {}))),
              `«${name}.${k}» потерял вложенные ключи`).toEqual([]);
          }
        }
      }
    }
  });

  it('нормализация дважды подряд не ломает первый результат', () => {
    const once = normalizeState({ settings: { launcher: { notify: false } } });
    const twice = normalizeState(JSON.parse(JSON.stringify(once)));
    expect(twice.settings.launcher.notify).toBe(false);
    expect(Object.keys(once.settings).sort()).toEqual(Object.keys(twice.settings).sort());
  });
});