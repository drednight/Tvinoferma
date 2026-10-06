// Приветственное окно и подсказка первых шагов на пустых данных
// (Issue #45, js/modules/characters/onboarding.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ persist: vi.fn(async () => {}) }));
vi.mock('../js/core/state.js', () => ({ state: { characters: [] } }));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));

import {
  shouldShowOnboarding, onboardingHtml, onboardingModalHtml, markOnboardingSeen,
  ONBOARDING_STEPS, ONBOARDING_INTRO
} from '../js/modules/characters/onboarding.js';

beforeEach(() => { mocks.persist.mockClear(); });

describe('когда показывать подсказку', () => {
  it('на пустых данных — да', () => {
    expect(shouldShowOnboarding({ characters: [] })).toBe(true);
    expect(shouldShowOnboarding({})).toBe(true);
  });

  it('как только появился персонаж — нет', () => {
    expect(shouldShowOnboarding({ characters: [{ id: 'a' }] })).toBe(false);
  });

  it('после первого показа само окно не возвращается', () => {
    // Иначе приветствие всплывало бы при каждом запуске, пока нет персонажей
    expect(shouldShowOnboarding({ characters: [], settings: { ui: { onboardingSeen: true } } })).toBe(false);
    expect(shouldShowOnboarding({ characters: [], settings: { ui: { onboardingSeen: false } } })).toBe(true);
  });
});

describe('приветственное окно', () => {
  it('три шага карточками, а не списком строк', () => {
    const html = onboardingModalHtml();
    expect(html).toContain('onb-cards');
    expect((html.match(/class="onb-card"/g) || []).length).toBe(ONBOARDING_STEPS.length);
    // Карточки не должны иметь класс строчного списка — это разные виды
    expect(html).not.toContain('onb-steps');
  });

  it('объясняет, что это за приложение', () => {
    const html = onboardingModalHtml();
    expect(html).toContain(ONBOARDING_INTRO);
    expect(ONBOARDING_INTRO).toContain('Perfect World');
  });

  it('в каждой карточке есть номер, иконка, название, объяснение и кнопка', () => {
    const html = onboardingModalHtml();
    for (const step of ONBOARDING_STEPS) {
      expect(html).toContain(step.title);
      expect(html).toContain(`data-onb="${step.action}"`);
      expect(html).toContain(step.icon);
    }
    expect((html.match(/onb-num/g) || []).length).toBe(ONBOARDING_STEPS.length);
  });

  it('подсказывает, что окно можно открыть снова', () => {
    expect(onboardingModalHtml()).toContain('С чего начать');
    expect(onboardingModalHtml()).toContain('открыть снова');
  });
});

describe('отметка о показе', () => {
  it('записывается один раз и сохраняется', async () => {
    const appState = { settings: { ui: {} } };
    await markOnboardingSeen(appState);
    expect(appState.settings.ui.onboardingSeen).toBe(true);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    // Повторный вызов ничего не пишет: состояние уже отмечено
    await markOnboardingSeen(appState);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });

  it('не падает, если раздела ui ещё нет', async () => {
    const appState = { settings: {} };
    await markOnboardingSeen(appState);
    expect(appState.settings.ui.onboardingSeen).toBe(true);
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
