import { describe, it, expect, beforeEach, vi } from 'vitest';

// Дымовой тест интерфейса описаний на странице марафона (issue #3).
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/sync/authStatus.js', () => ({ getAuthView: () => ({ icon: '' }) }));
vi.mock('../js/modules/marathons/siteSync.js', () => ({
  syncMarathons: vi.fn(), marathonUrlOf: () => null, SITE_PAGES: [], customPages: () => [], rememberCustomPage: vi.fn(),
  scanTitles: vi.fn(), parseMarathonPage: vi.fn(), pickScannerCharacter: () => null, loadNewsPage: vi.fn(), isNewsUrl: () => false
}));

const LONG = 'Пройти одно из подземелий ★★★★ уровня сложности и получить за него сундук(и) 25 раз. ' + 'Список подземелий: Остров рыцарей, Гробница шепотов и сложный режим Террасы снов. '.repeat(3);

let page, state, model;
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="marathon-list"></div><div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  model = await import('../js/modules/marathons/model.js');
  page = await import('../js/modules/marathons/page.js');
  const m = model.createMarathon({
    title: 'Тест', startDate: '2026-08-01', endDate: '2026-08-30',
    tasks: [
      model.createTask({ id: 't1', title: 'Покоритель подземелий', description: LONG, descriptionSource: 'news' }),
      model.createTask({ id: 't2', title: 'Без описания' })
    ]
  });
  state.characters = [];
  state.marathons = [m];
  page.openMarathon(m.id);
});

describe('описания заданий на странице марафона', () => {
  it('блок «Описания заданий» показывает короткий текст, источник и счётчик', () => {
    const box = document.querySelector('.mr-descs');
    expect(box).not.toBeNull();
    expect(box.textContent).toContain('(1 из 2)');
    expect(box.textContent).toContain('из новости');
    expect(box.querySelector('[data-desc-task="t1"] .mr-desc-text').textContent.endsWith('…')).toBe(true);
    expect(box.querySelector('[data-desc-task="t2"]').textContent).toContain('Описания нет');
  });

  it('«Показать полностью» раскрывает и сворачивает описание', () => {
    document.querySelector('[data-desc-toggle]').click();
    expect(document.querySelector('[data-desc-task="t1"] .mr-desc-text').textContent).toBe(LONG);
    expect(document.querySelector('[data-desc-toggle]').textContent).toBe('Свернуть');
    document.querySelector('[data-desc-toggle]').click();
    expect(document.querySelector('[data-desc-task="t1"] .mr-desc-text').textContent.endsWith('…')).toBe(true);
  });

  it('в блоке нет кнопок правки: описание меняется в редакторе марафона', () => {
    const box = document.querySelector('.mr-descs');
    expect(box.querySelector('[data-desc-edit], [data-desc-save], textarea')).toBeNull();
    expect(box.textContent).not.toContain('Изменить');
    expect(box.querySelector('[data-desc-task="t2"]').textContent).toContain('Редактировать');
  });

  it('в заголовке столбца нет строки «цель … · до 🪙…»', () => {
    state.characters = [{ id: 'c1', nick: 'Ник', party: null, class: '' }];
    state.marathons[0].participantIds = ['c1'];
    state.marathons[0].assignments = { c1: ['t1', 't2'] };
    page.renderMarathons();
    expect(document.querySelector('.mr-matrix thead').textContent).not.toMatch(/цель/);
  });

  it('подсказка заголовка столбца содержит описание', () => {
    state.characters = [{ id: 'c1', nick: 'Ник', party: null, class: '' }];
    state.marathons[0].participantIds = ['c1'];
    state.marathons[0].assignments = { c1: ['t1', 't2'] };
    page.renderMarathons();
    const th = [...document.querySelectorAll('.mr-matrix th')].find(x => x.textContent.includes('Покоритель'));
    expect(th.getAttribute('title')).toContain('Пройти одно из подземелий');
    expect(th.querySelector('.mr-th-info')).not.toBeNull();
  });
});
