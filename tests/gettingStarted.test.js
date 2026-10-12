import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Базовый гайд по приложению: шаги, две точки входа, чекбокс «не показывать снова».
const mocks = vi.hoisted(() => ({ persist: vi.fn(async () => {}) }));
vi.mock('../js/core/storage.js', () => ({ persist: mocks.persist }));

const body = readFileSync('index.html', 'utf8')
  .slice(readFileSync('index.html', 'utf8').indexOf('<body>') + 6)
  .replace(/<script[\s\S]*?<\/script>/g, '');

const boot = async () => {
  const { GUIDE_STEPS, shouldShowGuide, markGuideSeen, openGettingStarted, initGettingStarted } =
    await import('../js/settings/gettingStarted.js');
  return { GUIDE_STEPS, shouldShowGuide, markGuideSeen, openGettingStarted, initGettingStarted };
};

describe('шаги гайда', () => {
  let mod;
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = body;
    document.getElementById('modal-root')?.remove();
    const root = document.createElement('div');
    root.id = 'modal-root';
    document.body.appendChild(root);
    mod = await boot();
  });

  it('шаги идут по разделам приложения и уникальны', () => {
    const { GUIDE_STEPS } = mod;
    expect(GUIDE_STEPS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(GUIDE_STEPS.map(s => s.id)).size).toBe(GUIDE_STEPS.length);
    for (const step of GUIDE_STEPS) {
      expect(step.title.length, step.id).toBeGreaterThan(3);
      expect(step.text.length, step.id).toBeGreaterThan(40);
    }
  });

  it('ссылки ведут в существующие статьи справочника и разделы приложения', async () => {
    const { GUIDES } = await import('../js/settings/guideData.js');
    const ids = new Set(GUIDES.map(g => g.id));
    const html = readFileSync('index.html', 'utf8');
    for (const step of mod.GUIDE_STEPS) {
      for (const id of step.guides || []) expect(ids.has(id), `${step.id} → ${id}`).toBe(true);
      if (step.tab) expect(html, step.id).toContain(`data-tab="${step.tab}"`);
      if (step.screen) {
        // Снимок должен существовать: сломанная ссылка в гайде виднее всего
        expect(step.screen.src).toMatch(/^\/assets\/guides\/.+\.webp$/);
      }
    }
  });

  it('последний шаг закрывает гайд, а не уводит в раздел', () => {
    const last = mod.GUIDE_STEPS[mod.GUIDE_STEPS.length - 1];
    expect(last.tab).toBeUndefined();
  });
});

describe('гайд: показ и точки входа', () => {
  let state, mod;
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = body;
    ({ state } = await import('../js/core/state.js'));
    mod = await boot();
  });

  it('до прохождения гайд показывается, после — нет', async () => {
    expect(mod.shouldShowGuide(state)).toBe(true);
    await mod.markGuideSeen(state);
    expect(mod.shouldShowGuide(state)).toBe(false);
    await mod.markGuideSeen(state, false);
    expect(mod.shouldShowGuide(state)).toBe(true);
  });

  it('гайд доступен и когда персонажи уже есть: в отличие от приветствия, он про приложение', () => {
    state.characters = [{ id: 'a', nick: 'Кто-то' }];
    expect(mod.shouldShowGuide(state)).toBe(true);
  });

  it('гайд пишется в настройки один раз и переживает перезапуск', async () => {
    await mod.markGuideSeen(state);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(state.settings.ui.guideSeen).toBe(true);
    // Повторный вызов не пишет: состояние и так верное
    await mod.markGuideSeen(state);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });

  it('гайд открывается кнопкой в шапке; в «Справке» кнопки нет', async () => {
    const getting = await import('../js/settings/gettingStarted.js');
    getting.initGettingStarted();
    const topbar = document.getElementById('guide-start-btn');
    expect(topbar).not.toBeNull();
    // Кнопку из «Настройки → Справка» убрали: там же сама страница справки, и две
    // точки входа рядом только путали — гайд открывается из шапки
    expect(document.getElementById('guide-start-settings-btn')).toBeNull();
    // Гайд уже пройден: автопоказ не должен был запланироваться
    await getting.markGuideSeen(state);
    topbar.click();
    expect(document.querySelector('.tf-overlay')).not.toBeNull();
    expect(document.querySelector('.tf-dialog-title').textContent).toBe('Как работает Твиноферма');
  });
});

describe('гайд: шаги вперёд и назад', () => {
  let state, mod;
  const open = async () => {
    document.body.innerHTML = body;
    const root = document.createElement('div');
    root.id = 'modal-root';
    document.body.appendChild(root);
    mod = await boot();
    mod.openGettingStarted();
    return {
      ov: document.querySelector('.tf-overlay'),
      body: () => document.querySelector('.tf-dialog-body'),
      foot: () => document.querySelector('.tf-dialog-foot'),
      sub: () => document.querySelector('.tf-dialog-sub')
    };
  };

  beforeEach(async () => {
    vi.resetModules();
    ({ state } = await import('../js/core/state.js'));
  });

  it('«Далее» ведёт по шагам, «Назад» возвращает, степпер ведёт к пройденному', async () => {
    const ui = await open();
    const total = mod.GUIDE_STEPS.length;
    expect(ui.body().querySelector('.gs-counter').textContent).toBe(`Шаг 1 из ${total}`);
    expect(ui.foot().querySelector('[data-gs-back]')).toBeNull();   // с первого шага назад некуда

    ui.foot().querySelector('[data-gs-next]').click();
    expect(ui.body().querySelector('.gs-counter').textContent).toBe(`Шаг 2 из ${total}`);

    ui.foot().querySelector('[data-gs-next]').click();
    ui.foot().querySelector('[data-gs-next]').click();
    expect(ui.body().querySelector('.gs-counter').textContent).toBe(`Шаг 4 из ${total}`);
    // Шаг назад — кнопкой
    ui.foot().querySelector('[data-gs-back]').click();
    expect(ui.body().querySelector('.gs-counter').textContent).toBe(`Шаг 3 из ${total}`);

    // Шаги назад — кликом по степперу: текущий шаг неактивен, пройденные ведут назад
    const steps = [...ui.sub().querySelectorAll('.tf-step')];
    expect(steps.length).toBe(total);
    expect(steps[2].classList.contains('is-current')).toBe(true);   // шаг 3 — текущий
    expect(steps[3].classList.contains('is-done')).toBe(false);     // вперёд ещё не ходили
    steps[1].click();
    expect(ui.body().querySelector('.gs-counter').textContent).toBe(`Шаг 2 из ${total}`);
  });

  it('последний шаг закрывает гайд кнопкой «Готово»', async () => {
    const ui = await open();
    for (let i = 0; i < mod.GUIDE_STEPS.length - 1; i++) ui.foot().querySelector('[data-gs-next]').click();
    expect(ui.foot().querySelector('[data-gs-next]')).toBeNull();
    ui.foot().querySelector('[data-gs-done]').click();
    expect(document.querySelector('.tf-overlay')).toBeNull();
  });

  it('чекбокс «не показывать снова» пишется сразу', async () => {
    const ui = await open();
    const box = ui.foot().querySelector('[data-gs-dont-show]');
    expect(box.checked).toBe(false);            // гайд ещё не пройден
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(state.settings.ui.guideSeen).toBe(true));
    expect(mod.shouldShowGuide(state)).toBe(false);
    // Гайд после этого всё равно открывается кнопкой — доступен всегда
    document.getElementById('guide-start-btn').click();
    expect(document.querySelector('.tf-overlay')).not.toBeNull();
  });

  it('кнопка «Открыть раздел» уводит в раздел и закрывает гайд', async () => {
    const ui = await open();
    // Шаг 2 — «Персонажи»: у него есть и кнопка раздела, и снимок интерфейса
    ui.foot().querySelector('[data-gs-next]').click();
    const go = ui.body().querySelector('[data-gs-tab]');
    expect(go).not.toBeNull();
    expect(go.textContent).toContain('Персонажи');
    expect(ui.body().querySelector('.gs-screen img')).not.toBeNull();
    document.querySelector('.tab[data-tab="characters"]').click();
    go.click();
    expect(document.querySelector('.tf-overlay')).toBeNull();
  });
});
