// demo/guides/guides-app.js
// Логика прототипа раздела «Гайды»: фильтры, поиск, закладки, действия со ссылками.
// Модуль подключается из index.html через <script type="module">.

import { GUIDES, GUIDE_CATEGORIES, PASS_FILTERS, STAGE_TAGS } from './guides-data.js';

// --- Состояние ---
const state = {
  activeCategory: null, // null = все категории
  activeClass: null, // название класса или null
  activePass: null, // 'weapon' | 'armor' | 'relic' | null
  activeStage: null, // ключ этапа или null
  searchQuery: '',
  bookmarks: new Set(), // множество id закладок
  viewMode: 'grid' // 'grid' | 'list'
};

// --- DOM элементы ---
const els = {
  sidebarCategories: document.getElementById('guides-sidebar-categories'),
  bookmarksList: document.getElementById('guides-bookmarks-list'),
  bookmarksEmpty: document.getElementById('guides-bookmarks-empty'),
  searchInput: document.getElementById('guides-search'),
  filterClass: document.getElementById('guides-filter-class'),
  filterPass: document.getElementById('guides-filter-pass'),
  filterStage: document.getElementById('guides-filter-stage'),
  guidesGrid: document.getElementById('guides-guides-grid'),
  guidesList: document.getElementById('guides-guides-list'),
  resultCount: document.getElementById('guides-result-count'),
  viewGridBtn: document.getElementById('guides-view-grid'),
  viewListBtn: document.getElementById('guides-view-list'),
  toast: document.getElementById('guides-copy-toast')
};

// --- Инициализация ---
function init() {
  loadBookmarks();
  renderSidebar();
  renderFilters();
  renderGuides();
  bindEvents();
}

function bindEvents() {
  // Поиск
  els.searchInput.addEventListener('input', e => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    renderGuides();
  });

  // Переключение вида
  els.viewGridBtn.addEventListener('click', () => setView('grid'));
  els.viewListBtn.addEventListener('click', () => setView('list'));
}

function setView(mode) {
  state.viewMode = mode;
  els.viewGridBtn.classList.toggle('is-active', mode === 'grid');
  els.viewListBtn.classList.toggle('is-active', mode === 'list');
  els.guidesGrid.hidden = mode !== 'grid';
  els.guidesList.hidden = mode !== 'list';
  renderGuides();
}

// --- Закладки (isolated localStorage) ---
const STORAGE_KEY = 'tvinoferma_guides_bookmarks';

function loadBookmarks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.bookmarks = new Set(parsed);
      }
    }
  } catch {
    // Игнорируем ошибки хранилища — закладки просто не будут персистировать
    state.bookmarks = new Set();
  }
}

function saveBookmarks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.bookmarks]));
  } catch {
    // Игнорируем
  }
}

function isBookmarked(id) {
  return state.bookmarks.has(id);
}

function toggleBookmark(id) {
  if (state.bookmarks.has(id)) {
    state.bookmarks.delete(id);
  } else {
    state.bookmarks.add(id);
  }
  saveBookmarks();
  renderSidebar();
  renderGuides();
}

// --- Фильтрация ---
function filterGuides() {
  return GUIDES.filter(guide => {
    // Категория
    if (state.activeCategory !== null && guide.category !== state.activeCategory) {
      return false;
    }
    // Класс
    if (state.activeClass !== null) {
      if (guide.class !== state.activeClass) {
        return false;
      }
    }
    // Тип прохода данжа
    if (state.activePass !== null) {
      if (guide.passType !== state.activePass) {
        return false;
      }
    }
    // Этап прогресса
    if (state.activeStage !== null) {
      if (guide.stage !== state.activeStage) {
        return false;
      }
    }
    // Поиск
    if (state.searchQuery) {
      const haystack = [guide.title, guide.description, ...guide.tags, guide.source].join(' ').toLowerCase();
      if (!haystack.includes(state.searchQuery)) {
        return false;
      }
    }
    return true;
  });
}

// --- Рендер ---
function renderSidebar() {
  // Категории
  els.sidebarCategories.innerHTML = '';
  for (const cat of GUIDE_CATEGORIES) {
    const count = GUIDES.filter(g => g.category === cat.key).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `guides-category-btn ${state.activeCategory === cat.key ? 'is-active' : ''}`;
    btn.innerHTML = `
      <span class="guides-category-icon">${cat.icon}</span>
      <span class="guides-category-title">${cat.label}</span>
      <span class="guides-category-count">${count}</span>
    `;
    btn.addEventListener('click', () => {
      state.activeCategory = state.activeCategory === cat.key ? null : cat.key;
      // Сбрасываем связанные фильтры при смене категории
      if (state.activeCategory !== null) {
        state.activeClass = null;
        state.activePass = null;
        state.activeStage = null;
        renderFilters();
      }
      renderGuides();
    });
    els.sidebarCategories.appendChild(btn);
  }

  // Закладки
  const bookmarked = GUIDES.filter(g => state.bookmarks.has(g.id));
  els.bookmarksEmpty.hidden = bookmarked.length > 0;
  els.bookmarksList.innerHTML = '';
  for (const guide of bookmarked) {
    const item = document.createElement('div');
    item.className = 'guides-bookmark-item';
    item.title = guide.title;
    item.innerHTML = `
      <span class="guides-bookmark-star">★</span>
      <span class="guides-bookmark-title" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(guide.title)}</span>
      <button type="button" class="guides-bookmark-remove" title="Удалить из закладок">✕</button>
    `;
    item.addEventListener('click', e => {
      if (e.target.classList.contains('guides-bookmark-remove') || e.target.closest('.guides-bookmark-remove')) {
        e.stopPropagation();
        toggleBookmark(guide.id);
        return;
      }
      state.activeCategory = guide.category;
      renderSidebar();
      renderFilters();
      renderGuides();
      // Прокрутить к карточке
      const card = document.getElementById(`guide-${guide.id}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    els.bookmarksList.appendChild(item);
  }
}

function renderFilters() {
  // Фильтр классов
  const CLASS_ORDER = [
    'Оборотень',
    'Друид',
    'Странник',
    'Воин',
    'Маг',
    'Стрелок',
    'Жрец',
    'Лучник',
    'Паладин',
    'Убийца',
    'Шаман',
    'Бард',
    'Мистик',
    'Страж',
    'Дух Крови',
    'Жнец',
    'Призрак',
    'Канглонг'
  ];
  const CLASS_ICON_FILES = {
    Оборотень: 'tank.webp',
    Друид: 'dru.webp',
    Странник: 'mk.webp',
    Воин: 'var.webp',
    Маг: 'mag.webp',
    Стрелок: 'gan.webp',
    Жрец: 'prist.webp',
    Лучник: 'luk.webp',
    Паладин: 'pal.webp',
    Убийца: 'sin.webp',
    Шаман: 'sham.webp',
    Бард: 'bard.webp',
    Мистик: 'mist.webp',
    Страж: 'sik.webp',
    'Дух Крови': 'dk.webp',
    Жнец: 'kosa.webp',
    Призрак: 'gost.webp',
    Канглонг: 'canglong.webp'
  };

  els.filterClass.innerHTML = `
    <div class="guides-chip ${state.activeClass === null ? 'is-active' : ''}" data-filter="class" data-value="">
      Все классы
    </div>
  `;
  for (const className of CLASS_ORDER) {
    const iconFile = CLASS_ICON_FILES[className];
    const hasGuides = GUIDES.some(g => g.class === className);
    const chip = document.createElement('div');
    chip.className = `guides-chip ${state.activeClass === className ? 'is-active' : ''} ${!hasGuides ? 'opacity-50' : ''}`;
    chip.dataset.filter = 'class';
    chip.dataset.value = className;
    chip.innerHTML = `
      <img src="/assets/icons/classes/${iconFile}" alt="${className}" class="guides-chip-icon" onerror="this.style.display='none'">
      <span>${escapeHtml(className)}</span>
    `;
    if (!hasGuides) {
      chip.style.opacity = '0.5';
      chip.style.cursor = 'default';
    } else {
      chip.addEventListener('click', () => {
        state.activeClass = state.activeClass === className ? null : className;
        renderGuides();
      });
    }
    els.filterClass.appendChild(chip);
  }

  // Фильтр типов проходов
  els.filterPass.innerHTML = `
    <div class="guides-chip ${state.activePass === null ? 'is-active' : ''}" data-filter="pass" data-value="">
      Все типы
    </div>
  `;
  for (const pass of PASS_FILTERS) {
    const hasGuides = GUIDES.some(g => g.passType === pass.key);
    const chip = document.createElement('div');
    chip.className = `guides-chip ${state.activePass === pass.key ? 'is-active' : ''} ${!hasGuides ? 'opacity-50' : ''}`;
    chip.dataset.filter = 'pass';
    chip.dataset.value = pass.key;
    chip.innerHTML = `
      <img src="/assets/icons/dungeons/pass-${pass.key}.webp" alt="${pass.label}" class="guides-chip-icon" onerror="this.style.display='none'">
      <span>${escapeHtml(pass.label)}</span>
    `;
    if (!hasGuides) {
      chip.style.opacity = '0.5';
      chip.style.cursor = 'default';
    } else {
      chip.addEventListener('click', () => {
        state.activePass = state.activePass === pass.key ? null : pass.key;
        renderGuides();
      });
    }
    els.filterPass.appendChild(chip);
  }

  // Фильтр этапов
  els.filterStage.innerHTML = `
    <div class="guides-chip ${state.activeStage === null ? 'is-active' : ''}" data-filter="stage" data-value="">
      Все этапы
    </div>
  `;
  for (const stage of STAGE_TAGS) {
    const chip = document.createElement('div');
    chip.className = `guides-chip ${state.activeStage === stage.key ? 'is-active' : ''}`;
    chip.dataset.filter = 'stage';
    chip.dataset.value = stage.key;
    chip.style.setProperty('--stage-color', stage.color);
    chip.innerHTML = `
      <span style="color: var(--stage-color)">●</span>
      <span>${escapeHtml(stage.label)}</span>
    `;
    chip.addEventListener('click', () => {
      state.activeStage = state.activeStage === stage.key ? null : stage.key;
      renderGuides();
    });
    els.filterStage.appendChild(chip);
  }
}

function renderGuides() {
  const filtered = filterGuides();
  els.resultCount.textContent = `Найдено: ${filtered.length} из ${GUIDES.length}`;

  // Сетка
  els.guidesGrid.innerHTML = '';
  for (const guide of filtered) {
    const card = document.createElement('article');
    card.id = `guide-${guide.id}`;
    card.className = `guides-card ${isBookmarked(guide.id) ? 'is-pinned' : ''}`;
    card.innerHTML = buildCardHtml(guide);
    els.guidesGrid.appendChild(card);

    // Привязка событий после вставки
    bindCardEvents(card, guide);
  }

  // Список
  els.guidesList.innerHTML = '';
  for (const guide of filtered) {
    const item = document.createElement('div');
    item.className = `guides-card ${isBookmarked(guide.id) ? 'is-pinned' : ''} guides-card-list`;
    item.innerHTML = buildCardHtml(guide, true);
    els.guidesList.appendChild(item);

    bindCardEvents(item, guide);
  }
}

function buildCardHtml(guide, isList = false) {
  const pinned = isBookmarked(guide.id);
  const classIcon = guide.class ? `/assets/icons/classes/${classIconFile(guide.class)}` : null;
  const passIcon = guide.passType ? `/assets/icons/dungeons/pass-${guide.passType}.webp` : null;

  const badges = [];
  if (guide.source) {
    badges.push(`<span class="guides-badge source">${escapeHtml(guide.source)}</span>`);
  }
  if (guide.external) {
    badges.push(`<span class="guides-badge external">Внешняя ссылка</span>`);
  }
  if (guide.pinned) {
    badges.push(`<span class="guides-badge pinned">От редакции</span>`);
  }
  if (guide.class) {
    badges.push(`<span class="guides-badge class">${escapeHtml(guide.class)}</span>`);
  }
  if (guide.passType) {
    const pass = PASS_FILTERS.find(p => p.key === guide.passType);
    badges.push(
      `<span class="guides-badge pass">${passIcon ? `<img src="${passIcon}" width="12" height="12" alt="">` : ''}${escapeHtml(pass.label)}</span>`
    );
  }
  if (guide.stage) {
    const stage = STAGE_TAGS.find(s => s.key === guide.stage);
    if (stage) {
      badges.push(
        `<span class="guides-badge stage" style="color: var(--stage-color)">${escapeHtml(stage.label)}</span>`
      );
    }
  }
  if (guide.badge) {
    badges.push(
      `<span class="guides-badge" style="background: var(--warning-soft); border-color: var(--warning); color: var(--warning)">${escapeHtml(guide.badge)}</span>`
    );
  }

  const tagsHtml = guide.tags.map(t => `<span class="guides-tag">${escapeHtml(t)}</span>`).join('');

  const updatedHtml = guide.updated ? `<span>Обновлён: ${escapeHtml(guide.updated)}</span>` : '';

  return `
    <div class="guides-card-header">
      <h3 class="guides-card-title">${escapeHtml(guide.title)}</h3>
      <div class="guides-card-badges">${badges.join('')}</div>
    </div>
    <p class="guides-card-description">${escapeHtml(guide.description)}</p>
    <div class="guides-card-meta">
      <div class="guides-card-tags">${tagsHtml}</div>
      <div>${updatedHtml}</div>
    </div>
    <div class="guides-card-actions">
      <button type="button" class="guides-action-btn primary" data-action="open" data-url="${escapeHtml(guide.url)}">
        <span class="btn-icon">↗</span>Открыть
      </button>
      <button type="button" class="guides-action-btn secondary" data-action="copy" data-url="${escapeHtml(guide.url)}" data-title="${escapeHtml(guide.title)}">
        <span class="btn-icon">📋</span>Копировать
      </button>
      <button type="button" class="guides-action-btn secondary" data-action="bookmark" data-id="${escapeHtml(guide.id)}">
        <span class="btn-icon">${pinned ? '★' : '☆'}</span>
      </button>
    </div>
  `;
}

function bindCardEvents(card, guide) {
  // Открыть ссылку
  const openBtn = card.querySelector('[data-action="open"]');
  if (openBtn) {
    openBtn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      openExternalLink(guide.url);
    });
  }

  // Копировать ссылку
  const copyBtn = card.querySelector('[data-action="copy"]');
  if (copyBtn) {
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      copyToClipboard(guide.url, guide.title, copyBtn);
    });
  }

  // Закладка
  const bookmarkBtn = card.querySelector('[data-action="bookmark"]');
  if (bookmarkBtn) {
    bookmarkBtn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      toggleBookmark(guide.id);
    });
  }

  // Клик по карточке — подсвечивает, но не открывает (открытие только по кнопке)
  // card.addEventListener('click', () => { ... })
}

function classIconFile(className) {
  const map = {
    Оборотень: 'tank.webp',
    Друид: 'dru.webp',
    Странник: 'mk.webp',
    Воин: 'var.webp',
    Маг: 'mag.webp',
    Стрелок: 'gan.webp',
    Жрец: 'prist.webp',
    Лучник: 'luk.webp',
    Паладин: 'pal.webp',
    Убийца: 'sin.webp',
    Шаман: 'sham.webp',
    Бард: 'bard.webp',
    Мистик: 'mist.webp',
    Страж: 'sik.webp',
    'Дух Крови': 'dk.webp',
    Жнец: 'kosa.webp',
    Призрак: 'gost.webp',
    Канглонг: 'canglong.webp'
  };
  return map[className] || 'var.webp';
}

// --- Действия ---
function openExternalLink(url) {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // Fallback
    window.location.href = url;
  }
}

function copyToClipboard(url, title, btn) {
  navigator.clipboard
    .writeText(url)
    .then(() => {
      showToast(btn);
      const icon = btn.querySelector('.btn-icon');
      const original = icon.textContent;
      icon.textContent = '✓';
      setTimeout(() => {
        icon.textContent = original;
      }, 1200);
    })
    .catch(() => {
      // Fallback для старых браузеров
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showToast(btn);
      } catch {
        alert('Не удалось скопировать ссылку.');
      }
      document.body.removeChild(textarea);
    });
}

function showToast(btn) {
  const toast = document.getElementById('guides-copy-toast');
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 1500);
}

// --- Утилиты ---
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Запуск
init();
