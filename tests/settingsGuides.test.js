import { readFileSync, existsSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { bindGuides } from '../js/settings/guides.js';
import { GUIDE_CATEGORIES, GUIDES, guideSearchText } from '../js/settings/guideData.js';

const source = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
const $ = selector => document.querySelector(selector);
const search = query => { $('#guide-search').value = query; $('#guide-search').dispatchEvent(new Event('input', { bubbles: true })); };
const open = id => $(`[data-guide-open="${id}"], [data-guide-id="${id}"]`).click();

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>' + source.getElementById('guide-library').outerHTML;
});

describe('данные справки', () => {
  it('все инструкции полные, категории и связанные статьи существуют, снимки включены в проект', () => {
    const categories = new Set(GUIDE_CATEGORIES.map(category => category.id));
    const ids = new Set(GUIDES.map(guide => guide.id));
    expect(ids.size).toBe(GUIDES.length);
    expect(GUIDES.length).toBeGreaterThanOrEqual(25);
    for (const guide of GUIDES) {
      expect(categories.has(guide.category)).toBe(true);
      for (const field of ['title', 'summary', 'where', 'result']) expect(guide[field].length).toBeGreaterThan(10);
      expect(guide.steps.length).toBeGreaterThanOrEqual(3);
      expect(guide.steps.length).toBeLessThanOrEqual(6);
      for (const item of guide.steps) { expect(item.title.length).toBeGreaterThan(5); expect(item.text.length).toBeGreaterThan(30); }
      for (const id of guide.related || []) { expect(ids.has(id)).toBe(true); expect(id).not.toBe(guide.id); }
      if (guide.notice) expect(['info', 'warning', 'danger']).toContain(guide.notice.tone);
      if (guide.screen) {
        expect(guide.screen.src).toMatch(/^\/assets\/guides\/.+\.webp$/);
        expect(existsSync(`public${guide.screen.src}`)).toBe(true);
        expect(guide.screen.alt.length).toBeGreaterThan(10);
      }
    }
    for (const category of categories) expect(GUIDES.some(guide => guide.category === category)).toBe(true);
  });

  it('гайды скриптов показывают сами диалоги или выполнение задачи, не страницу персонажей', () => {
    const expected = { 'sync-data': 'sync-task', promo: 'promo-dialog', transfer: 'transfer-dialog', shop: 'shop-dialog' };
    for (const [id, image] of Object.entries(expected)) {
      expect(GUIDES.find(guide => guide.id === id).screen.src).toBe(`/assets/guides/${image}.webp`);
    }
  });

  it('важные ограничения описаны прямо, а не заменены общими советами', () => {
    const text = id => guideSearchText(GUIDES.find(guide => guide.id === id));
    expect(text('danger-reset')).toContain('сброс удаляет и резервные копии');
    expect(text('calendar-entry')).toContain('нет отдельной кнопки редактирования');
    expect(text('gamecenter')).toContain('запомните вход');
    expect(text('marathon-progress')).toContain('большее');
    expect(text('security')).toContain('открыто в state.json');
    expect(text('updates')).toContain('через пять секунд');
    expect(text('export-import')).toContain('заменить все');
    expect(text('move-computer')).toContain('куки браузеров не переносятся');
  });
});

describe('каталог и область чтения', () => {
  it('начинает с первых шагов, показывает одну инструкцию и отдельные темы', () => {
    bindGuides();
    expect(document.querySelectorAll('.guide-category')).toHaveLength(GUIDE_CATEGORIES.length + 1);
    expect($('[data-category="start"]').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('.guide-index-item')).toHaveLength(2);
    expect(document.querySelectorAll('.guide-article')).toHaveLength(1);
    expect($('#guide-reader-title').textContent).toBe('Начать с первого персонажа');
    expect($('.guide-route').textContent).toContain('Где открыть');
    expect($('.guide-callout.is-result').textContent).toContain('Что получится');
    expect($('.guide-image-details').open).toBe(false);
    expect($('.guide-screenshot img').getAttribute('loading')).toBe('lazy');
    expect($('.guide-meta').textContent).toContain('4 шага');
  });

  it('категория обновляет список; выбор статьи показывает её шаги и устанавливает фокус', () => {
    bindGuides();
    $('[data-category="parties"]').click();
    expect(document.querySelectorAll('.guide-index-item')).toHaveLength(GUIDES.filter(guide => guide.category === 'parties').length);
    $('[data-guide-id="gamecenter"]').click();
    expect($('#guide-reader-title').textContent).toContain('GameCenter');
    expect($('.guide-meta').textContent).toContain('5 шагов');
    expect($('.guide-meta').textContent).toContain('Для установленного приложения');
    expect(document.activeElement.id).toBe('guide-reader');
    expect($('[data-guide-id="gamecenter"]').getAttribute('aria-current')).toBe('page');
  });

  it('поиск глобальный, учитывает шаги, несколько слов и ё/е; можно сузить темой', () => {
    bindGuides();
    search('запомнить вход');
    expect($('[data-category="all"]').getAttribute('aria-pressed')).toBe('true');
    expect($('[data-guide-id="gamecenter"]')).not.toBeNull();
    search('резервные копии');
    $('[data-category="data"]').click();
    expect($('[data-guide-id="danger-reset"]')).not.toBeNull();
    expect(document.querySelectorAll('.guide-index-item').length).toBeGreaterThan(1);
    search('все с входом');
    expect($('[data-guide-id="promo"]')).not.toBeNull();
    expect($('#guide-status').textContent).toContain('Найдено:');
  });

  it('быстрые карточки и связанные инструкции сбрасывают поиск и открывают нужную тему', () => {
    bindGuides(); search('что-то неизвестное');
    open('gamecenter');
    expect($('#guide-search').value).toBe('');
    expect($('[data-category="parties"]').getAttribute('aria-pressed')).toBe('true');
    expect($('#guide-reader-title').textContent).toContain('GameCenter');
    open('party-launch');
    expect($('#guide-reader-title').textContent).toBe('Запустить игру для всей пати');
  });

  it('нет результатов: понятное сообщение и работающий сброс', () => {
    bindGuides(); search('несуществующее_слово');
    expect($('#guide-reader-title').textContent).toBe('Ничего не найдено');
    expect($('#guide-status').textContent).toContain('0 инструкций');
    expect(document.querySelectorAll('.guide-index-item')).toHaveLength(0);
    $('.guide-empty-state [data-guide-reset]').click();
    expect($('#guide-search').value).toBe('');
    expect($('#guide-reader-title').textContent).toBe('Начать с первого персонажа');
    expect(document.activeElement.id).toBe('guide-search');
  });

  it('снимок открывается крупно, закрывается и возвращает фокус', () => {
    bindGuides(); $('.guide-image-details').open = true;
    const button = $('[data-guide-image]'); button.click();
    expect($('.guide-screenshot-full').getAttribute('src')).toBe('/assets/guides/characters.webp');
    expect(document.querySelectorAll('.tf-overlay')).toHaveLength(1);
    $('[data-guide-zoom]').click();
    expect($('.guide-image-viewport').classList.contains('is-zoomed')).toBe(true);
    expect($('[data-guide-zoom]').getAttribute('aria-pressed')).toBe('true');
    expect($('[data-guide-zoom]').textContent).toBe('Вписать в окно');
    $('[data-guide-zoom]').click();
    expect($('.guide-image-viewport').classList.contains('is-zoomed')).toBe(false);
    $('[data-close]').click();
    expect($('.guide-screenshot-full')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('повторная инициализация не дублирует обработчики', () => {
    bindGuides(); bindGuides(); $('.guide-image-details').open = true;
    $('[data-guide-image]').click();
    expect(document.querySelectorAll('.tf-overlay')).toHaveLength(1);
    $('[data-close]').click();
  });

  it('все статьи доступны, все переходы ведут к правильному заголовку', () => {
    bindGuides();
    for (const guide of GUIDES) {
      $('[data-category="all"]').click();
      $(`[data-guide-id="${guide.id}"]`).click();
      expect($('#guide-reader-title').textContent).toBe(guide.title);
      expect(document.querySelectorAll('.guide-steps li')).toHaveLength(guide.steps.length);
      expect($('.guide-article-head').textContent).not.toContain('шагаов');
    }
  });
});
