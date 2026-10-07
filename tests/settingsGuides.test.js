import { beforeEach, describe, expect, it } from 'vitest';
import { bindGuides } from '../js/settings/guides.js';

describe('каталог гайдов в настройках', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="guide-search" />
      <nav id="guide-categories"></nav>
      <div id="guide-list"></div>
    `;
  });

  it('показывает категории и инструкции без изображений-макетов', () => {
    bindGuides();
    expect(document.querySelectorAll('.guide-category').length).toBeGreaterThan(1);
    expect(document.querySelector('.guide-item-title').textContent).toBe('Быстрый старт');
    expect(document.querySelector('.guide-illustration')).toBeNull();
    expect(document.querySelector('.guide-content ol li').textContent).toContain('Персонажи');
  });

  it('фильтрует инструкции по категории и поисковому запросу', () => {
    bindGuides();
    document.querySelector('[data-category="parties"]').click();
    expect(document.querySelectorAll('.guide-item').length).toBe(3);
    expect(document.querySelector('.guide-item-title').textContent).toBe('Создание пати и состав');

    const search = document.getElementById('guide-search');
    search.value = 'архив';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.guide-item').length).toBe(1);
    expect(document.querySelector('.guide-item-title').textContent).toBe('Архив пати и архивные участники');
  });

  it('сообщает, если по запросу нет гайдов', () => {
    bindGuides();
    const search = document.getElementById('guide-search');
    search.value = 'несуществующий раздел';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelector('.guide-empty').textContent).toContain('ничего не найдено');
  });
});
