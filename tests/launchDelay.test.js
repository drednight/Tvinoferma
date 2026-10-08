import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { launchCharacters, launchDelayMs, DEFAULT_LAUNCH_DELAY_MS } from '../js/modules/launcher/launch.js';
import { normalizeState } from '../js/core/state.js';

describe('пауза между запусками окон', () => {
  it('по умолчанию 3 секунд, берётся из настроек и ограничена 0–120 с', () => {
    expect(DEFAULT_LAUNCH_DELAY_MS).toBe(3000);
    expect(launchDelayMs({})).toBe(3000);
    expect(launchDelayMs({ launcher: { delaySec: 0 } })).toBe(0);
    expect(launchDelayMs({ launcher: { delaySec: 1.5 } })).toBe(1500);
    expect(launchDelayMs({ launcher: { delaySec: 999 } })).toBe(120000);
    expect(launchDelayMs({ launcher: { delaySec: -4 } })).toBe(0);
    expect(launchDelayMs({ launcher: { delaySec: 'мусор' } })).toBe(3000);
    expect(launchDelayMs({ launcher: { delaySec: '' } })).toBe(3000);
  });

  it('нормализация состояния чинит значение и сохраняет ноль', () => {
    const get = (launcher) => normalizeState({ characters: [], settings: { launcher } }).settings.launcher.delaySec;
    expect(normalizeState({ characters: [], settings: {} }).settings.launcher.delaySec).toBe(3);
    expect(get({ delaySec: 0 })).toBe(0);
    expect(get({ delaySec: 7 })).toBe(7);
    expect(get({ delaySec: 500 })).toBe(120);
    expect(get({ delaySec: 'abc' })).toBe(3);
    expect(get({ delaySec: null })).toBe(3);
  });

  it('явно переданная пауза главнее настройки; последнее окно не ждёт', async () => {
    const calls = [];
    const invoke = async (cmd, args) => { calls.push(args.charId); return {}; };
    const ch = (id) => ({ id, nick: id, class: '', launch: { gcPath: `D:\\${id}` } });
    const t0 = Date.now();
    await launchCharacters([ch('a'), ch('b')], { delayMs: 0 }, { invoke, loadIcon: async () => null, icons: false });
    expect(calls).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('поле есть в настройках запуска игры', () => {
    expect(readFileSync('index.html', 'utf8')).toContain('data-setting="launcher.delaySec"');
  });
});
