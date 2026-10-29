import { describe, expect, it } from 'vitest';
import { mergeSettings } from '../js/core/state/settings.js';
import { exportPortableSettings } from '../js/modules/cloudSync/settingsExport.js';

const source = () =>
  mergeSettings({
    ui: {
      theme: 'dark',
      plannerView: 'month',
      sections: {
        hidden: ['runes'],
        order: ['today', 'finance', 'characters', 'parties', 'marathons', 'runes', 'tools', 'settings']
      },
      guideSeen: true,
      onboardingSeen: true
    },
    google: { clientId: 'SECRET-CLOUD-ID' },
    launcher: { layoutDir: 'C:\\PRIVATE-PATH' },
    security: { useVault: false }
  });

describe('экспорт только выбранных настроек', () => {
  it('включает только разрешённые предпочтения, без локальных данных и служебных флагов', () => {
    const settings = source();
    const before = JSON.stringify(settings);
    const result = exportPortableSettings(settings, { selections: ['planner', 'appearance', 'navigation'] });
    expect(result).toEqual({
      schemaVersion: 1,
      selections: ['appearance', 'navigation', 'planner'],
      values: {
        appearance: { theme: 'dark' },
        navigation: {
          hidden: ['runes'],
          order: ['today', 'finance', 'characters', 'parties', 'marathons', 'runes', 'tools', 'settings']
        },
        planner: { view: 'month' }
      }
    });
    for (const privateText of [
      'SECRET-CLOUD-ID',
      'PRIVATE-PATH',
      'useVault',
      'guideSeen',
      'onboardingSeen',
      'google',
      'launcher'
    ])
      expect(JSON.stringify(result)).not.toContain(privateText);
    result.values.navigation.hidden.push('tools');
    expect(JSON.stringify(settings)).toBe(before);
  });
  it('пропускает невыбранные группы, не объявляя их удалёнными', () => {
    expect(exportPortableSettings(source(), { selections: ['planner'] })).toEqual({
      schemaVersion: 1,
      selections: ['planner'],
      values: { planner: { view: 'month' } }
    });
    const sensitive = {};
    Object.defineProperty(sensitive, 'ui', {
      enumerable: true,
      get() {
        throw new Error('not read');
      }
    });
    expect(exportPortableSettings(sensitive, { selections: [] })).toEqual({
      schemaVersion: 1,
      selections: [],
      values: {}
    });
  });
  it('отдельно переносит настройки напоминаний встроенных событий, не читая остальные уведомления', () => {
    const settings = source();
    settings.notifications.events['dynasty-battle'] = { enabled: false, leadMinutes: 30 };
    Object.defineProperty(settings, 'ui', {
      enumerable: true,
      get: () => {
        throw new Error('не читать ui');
      }
    });
    Object.defineProperty(settings.notifications, 'sound', {
      enumerable: true,
      get: () => {
        throw new Error('не читать звук');
      }
    });
    const result = exportPortableSettings(settings, { selections: ['eventReminders'] });
    expect(result.selections).toEqual(['eventReminders']);
    expect(result.values.eventReminders['dynasty-battle']).toEqual({ enabled: false, leadMinutes: 30 });
    expect(Object.keys(result.values.eventReminders)).toHaveLength(4);
    expect(JSON.stringify(result)).not.toMatch(/sound|launcher|SECRET|PRIVATE/);
    settings.notifications.events['future-event'] = { enabled: true, leadMinutes: 10 };
    expect(() => exportPortableSettings(settings, { selections: ['eventReminders'] })).toThrow();
  });

  it('не читает getters других групп и отказывает на getters выбранной группы', () => {
    const settings = source();
    let touched = false;
    Object.defineProperty(settings, 'launcher', {
      enumerable: true,
      get() {
        touched = true;
        return {};
      }
    });
    expect(exportPortableSettings(settings, { selections: ['planner'] }).values.planner.view).toBe('month');
    expect(touched).toBe(false);
    Object.defineProperty(settings.ui, 'plannerView', {
      enumerable: true,
      get() {
        touched = true;
        return 'week';
      }
    });
    expect(() => exportPortableSettings(settings, { selections: ['planner'] })).toThrow();
    expect(touched).toBe(false);
  });
  it('не выдаёт скрытые, дублирующиеся или неизвестные разделы за корректные настройки', () => {
    const settings = source();
    settings.ui.sections.hidden.push('settings');
    expect(() => exportPortableSettings(settings, { selections: ['navigation'] })).toThrow();
    settings.ui.sections.hidden = [];
    settings.ui.sections.order.push('newer-version-section');
    expect(() => exportPortableSettings(settings, { selections: ['navigation'] })).toThrow();
  });
  it('требует явного выбора и отвергает неизвестные или повторные группы и свойства ui', () => {
    expect(() => exportPortableSettings(source())).toThrow();
    expect(() => exportPortableSettings(source(), { selections: ['launcher'] })).toThrow();
    expect(() => exportPortableSettings(source(), { selections: ['planner', 'planner'] })).toThrow();
    const settings = source();
    settings.ui.newUnknownSetting = 'secret';
    expect(() => exportPortableSettings(settings, { selections: ['planner'] })).toThrow();
  });
});
