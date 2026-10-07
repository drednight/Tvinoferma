import { openOverlay } from '../modules/marathons/overlay.js';
import { escapeHtml } from '../core/utils.js';
import { GUIDE_CATEGORIES, GUIDES, guideSearchText } from './guideData.js';

const byId = new Map(GUIDES.map(guide => [guide.id, guide]));
const categoryLabel = id => GUIDE_CATEGORIES.find(category => category.id === id)?.label || '';
const plural = new Intl.PluralRules('ru');
const countText = count => `${count} ${({ one: 'инструкция', few: 'инструкции', many: 'инструкций', other: 'инструкции' })[plural.select(count)]}`;

function screenshotHtml(screen) {
  if (!screen) return '';
  return `<details class="guide-image-details">
    <summary>Посмотреть скриншот интерфейса</summary>
    <figure class="guide-screenshot">
      <button type="button" class="guide-screenshot-button" data-guide-image="${escapeHtml(screen.src)}" data-guide-label="${escapeHtml(screen.alt)}" aria-label="Увеличить скриншот: ${escapeHtml(screen.alt)}">
        <img src="${escapeHtml(screen.src)}" alt="${escapeHtml(screen.alt)}" loading="lazy" decoding="async" />
        <span class="guide-image-zoom">Увеличить</span>
      </button>
      <figcaption>${escapeHtml(screen.alt)}. Снимок на вымышленных данных.</figcaption>
    </figure>
  </details>`;
}

function articleHtml(guide) {
  const notice = guide.notice;
  return `<article class="guide-article">
    <header class="guide-article-head">
      <div class="guide-meta"><span>${escapeHtml(categoryLabel(guide.category))}</span><span>${guide.steps.length} ${({ one: 'шаг', few: 'шага', many: 'шагов', other: 'шага' })[plural.select(guide.steps.length)]}</span>${guide.desktop ? '<span>Для установленного приложения</span>' : ''}</div>
      <h3 id="guide-reader-title">${escapeHtml(guide.title)}</h3>
      <p class="guide-intro">${escapeHtml(guide.summary)}</p>
    </header>
    <div class="guide-route"><strong>Где открыть</strong><p>${escapeHtml(guide.where)}</p></div>
    ${guide.before ? `<aside class="guide-callout is-info"><strong>Перед началом</strong><p>${escapeHtml(guide.before)}</p></aside>` : ''}
    <section class="guide-steps-section" aria-label="Пошаговая инструкция">
      <h4>Как сделать</h4>
      <ol class="guide-steps">${guide.steps.map(item => `<li><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></li>`).join('')}</ol>
    </section>
    <aside class="guide-callout is-result"><strong>Что получится</strong><p>${escapeHtml(guide.result)}</p></aside>
    ${notice ? `<aside class="guide-callout is-${notice.tone}"><strong>${notice.tone === 'danger' || notice.tone === 'warning' ? '⚠ ' : ''}${escapeHtml(notice.title)}</strong><p>${escapeHtml(notice.text)}</p></aside>` : ''}
    ${guide.trouble?.length ? `<section class="guide-trouble"><h4>Если не получилось</h4>${guide.trouble.map(item => `<div><strong>${escapeHtml(item.problem)}</strong><p>${escapeHtml(item.solution)}</p></div>`).join('')}</section>` : ''}
    ${screenshotHtml(guide.screen)}
    ${guide.related?.length ? `<footer class="guide-related"><h4>Дальше по теме</h4><div>${guide.related.map(id => `<button type="button" data-guide-open="${id}">${escapeHtml(byId.get(id).title)} <span aria-hidden="true">→</span></button>`).join('')}</div></footer>` : ''}
  </article>`;
}

/** Каталог ничего не запускает и не меняет настройки: кнопки ведут только к инструкциям. */
export function bindGuides() {
  const library = document.getElementById('guide-library');
  const list = document.getElementById('guide-list');
  const filters = document.getElementById('guide-categories');
  const search = document.getElementById('guide-search');
  const reader = document.getElementById('guide-reader');
  const status = document.getElementById('guide-status');
  const reset = document.getElementById('guide-reset');
  if (!library || !list || !filters || !search || !reader || !status || !reset || library.dataset.guideBound) return;
  library.dataset.guideBound = 'true';

  const st = { category: 'start', selected: 'first-character', query: '' };
  const searchIndex = new Map(GUIDES.map(guide => [guide.id, guideSearchText(guide)]));

  const render = () => {
    const words = st.query.toLocaleLowerCase('ru').replaceAll('ё', 'е').split(/\s+/).filter(Boolean);
    const matched = GUIDES.filter(guide => words.every(word => searchIndex.get(guide.id).includes(word)));
    const visible = matched.filter(guide => st.category === 'all' || guide.category === st.category);
    const categories = [{ id: 'all', label: 'Все темы' }, ...GUIDE_CATEGORIES];
    filters.innerHTML = categories.map(category => {
      const count = category.id === 'all' ? matched.length : matched.filter(guide => guide.category === category.id).length;
      return `<button type="button" class="guide-category${st.category === category.id ? ' is-active' : ''}" data-category="${category.id}" aria-pressed="${st.category === category.id}">${escapeHtml(category.label)} <span class="guide-category-count">${count}</span></button>`;
    }).join('');
    status.textContent = `${st.query ? 'Найдено: ' : ''}${countText(visible.length)}${st.category === 'all' ? ' во всех темах' : ` · ${categoryLabel(st.category)}`}`;
    reset.hidden = !st.query && st.category === 'start';
    if (!visible.length) {
      list.innerHTML = '<p class="guide-empty">В этой теме нет подходящих инструкций.</p>';
      reader.innerHTML = '<div class="guide-empty-state"><h3 id="guide-reader-title">Ничего не найдено</h3><p>Попробуйте другое слово или выберите «Все темы». Поиск учитывает не только названия, но и шаги инструкции.</p><button type="button" class="btn" data-guide-reset>Сбросить поиск и фильтры</button></div>';
      return;
    }
    if (!visible.some(guide => guide.id === st.selected)) st.selected = visible[0].id;
    list.innerHTML = visible.map(guide => `<button type="button" class="guide-index-item${guide.id === st.selected ? ' is-active' : ''}" data-guide-id="${guide.id}"${guide.id === st.selected ? ' aria-current="page"' : ''}>
      <strong>${escapeHtml(guide.title)}</strong><span>${escapeHtml(guide.summary)}</span>
    </button>`).join('');
    reader.innerHTML = articleHtml(byId.get(st.selected));
  };

  const focusReader = () => {
    reader.focus({ preventScroll: true });
    if (window.innerWidth <= 760) reader.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  };
  const openGuide = id => {
    const guide = byId.get(id);
    if (!guide) return;
    st.category = guide.category;
    st.selected = guide.id;
    st.query = '';
    search.value = '';
    render();
    focusReader();
  };
  const resetFilters = () => {
    st.category = 'start'; st.selected = 'first-character'; st.query = ''; search.value = '';
    render(); search.focus();
  };

  library.addEventListener('click', event => {
    const target = event.target.closest?.('button');
    if (!target || !library.contains(target)) return;
    if (target.hasAttribute('data-guide-reset')) { resetFilters(); return; }
    if (target.dataset.guideImage) {
      const ov = openOverlay({ title: target.dataset.guideLabel, wide: true, onClose: () => target.focus() });
      ov.body.innerHTML = `<div class="guide-image-viewport" tabindex="0" aria-label="Скриншот: ${escapeHtml(target.dataset.guideLabel)}"><img class="guide-screenshot-full" src="${escapeHtml(target.dataset.guideImage)}" alt="${escapeHtml(target.dataset.guideLabel)}" /></div><p class="guide-image-hint">Для мелких подписей включите «Масштаб 100%» и прокручивайте изображение.</p>`;
      ov.foot.classList.add('guide-image-actions');
      ov.foot.innerHTML = '<button type="button" class="btn" data-guide-zoom aria-pressed="false">Масштаб 100%</button><button type="button" class="btn primary" data-close>Закрыть</button>';
      const viewport = ov.body.querySelector('.guide-image-viewport');
      const zoom = ov.foot.querySelector('[data-guide-zoom]');
      zoom.onclick = () => {
        const enlarged = viewport.classList.toggle('is-zoomed');
        zoom.setAttribute('aria-pressed', String(enlarged));
        zoom.textContent = enlarged ? 'Вписать в окно' : 'Масштаб 100%';
        viewport.scrollTop = 0; viewport.scrollLeft = 0;
      };
      ov.foot.querySelector('[data-close]').onclick = () => ov.close();
      ov.foot.querySelector('[data-close]').focus();
      return;
    }
    if (target.dataset.guideOpen) { openGuide(target.dataset.guideOpen); return; }
    if (target.dataset.guideId) {
      st.selected = target.dataset.guideId; render(); focusReader(); return;
    }
    if (target.dataset.category) {
      st.category = target.dataset.category; render();
      filters.querySelector(`[data-category="${st.category}"]`)?.focus();
    }
  });
  search.addEventListener('input', () => {
    st.query = search.value.trim();
    // Поиск начинается по всей библиотеке; после ввода его можно сузить кнопкой темы.
    st.category = 'all';
    render();
  });
  render();
}
