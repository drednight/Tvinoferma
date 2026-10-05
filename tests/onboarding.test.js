// Подсказка первых шагов на пустых данных (Issue #45, js/modules/characters/onboarding.js).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../js/core/state.js', () => ({ state: { characters: [] } }));

import { shouldShowOnboarding, onboardingHtml, ONBOARDING_STEPS } from '../js/modules/characters/onboarding.js';

describe('когда показывать подсказку', () => {
  it('на пустых данных — да', () => {
    expect(shouldShowOnboarding({ characters: [] })).toBe(true);
    expect(shouldShowOnboarding({})).toBe(true);
  });

  it('как только появился персонаж — нет', () => {
    expect(shouldShowOnboarding({ characters: [{ id: 'a' }] })).toBe(false);
  });
});

describe('разметка подсказки', () => {
  it('на пустых данных содержит шаги и кнопки', () => {
    const html = onboardingHtml({ characters: [] });
    expect(html).toContain('С чего начать');
    expect(html).toContain('Добавьте персонажа');
    expect(html).toContain('Соберите пати');
    expect(html).toContain('data-onb="new-character"');
    expect(html).toContain('data-onb="new-party"');
  });

  it('когда персонажи есть — пустая строка, а не подсказка', () => {
    expect(onboardingHtml({ characters: [{ id: 'a' }] })).toBe('');
  });

  it('в каждом шаге есть название, объяснение и кнопка', () => {
    const html = onboardingHtml({ characters: [] });
    for (const step of ONBOARDING_STEPS) {
      expect(html).toContain(step.title);
      expect(step.text.length).toBeGreaterThan(30);   // объяснение, а не «нажмите кнопку»
      expect(html).toContain(`data-onb="${step.action}"`);
    }
  });

  it('подсказка не обещает лишнего: говорит о локальном хранении данных', () => {
    expect(onboardingHtml({ characters: [] })).toContain('только на этом компьютере');
  });
});
