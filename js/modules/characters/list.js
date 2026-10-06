// js/modules/characters/list.js

import { state, normalizeTags } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml } from '../../core/utils.js';
import { formatCoins, needsCoinRecheck } from '../../core/coins.js';
import { toast, showModal, confirmModal } from '../../core/ui.js';
import { renderParties } from '../parties/index.js';

// Импортируем константы
import { PASS_TYPES, getClassIconSrc } from '../../core/constants.js';

// Импортируем модульную систему персонажей
import { openCharacterProfile, openCharacterForm } from './index.js';

// НОВЫЕ ИМПОРТЫ ДЛЯ СИНХРОНИЗАЦИИ
import { hasGameCenterPath } from '../launcher/launch.js';
import { refreshAllBalances, refreshAllLoginStatuses, openSyncHelper } from '../sync/syncManager.js';
import { getAuthView, authDetails } from '../sync/authStatus.js';
import { fillClassFilter, fillPartyFilter, filterCharacters } from './filters.js';
import { onboardingHtml } from './onboarding.js';
import {
  NO_PARTY_LABEL, partyById, hasNoParty, setMembership, setMainParty, createPartyWith, mainPartyName, additionalPartiesOf, totalCoins as totalCoinsOf
} from '../parties/membership.js';

// Персонажи, видимые после фильтров (для «выбрать все»)
let visibleIds = [];

/**
 * Хелпер для маскирования текста
 */
function maskText(text, length = 8) {
  if (!text) return '';
  const str = String(text);
  if (str.length <= 4) return '••••';
  return str.substring(0, 2) + '•'.repeat(Math.min(length, str.length - 4)) + str.substring(str.length - 2);
}

const EYE_SVG_OPEN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_SVG_CLOSED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

export function renderCharacters() {
  // 1. Сначала обновляем состояние кнопок синхронизации (навешиваем обработчики)
  initSyncButtons(); 
  
  // 2. Затем рендерим сетку с учетом фильтров
  renderFilteredGrid(); 
}

/**
 * Инициализация фильтров (Поиск, Класс, Пати, Авторизация)
 */
function initFilters() {
  const searchInput = document.getElementById('search-input');
  const classSelect = document.getElementById('class-filter');
  const partySelect = document.getElementById('party-filter');
  const authSelect = document.getElementById('auth-filter'); 
  const tagSelect = document.getElementById('tag-filter');

  if (!searchInput || !classSelect || !partySelect || !authSelect) return;

  // Классы и пати (при каждой отрисовке списка пересобираются заново — см. renderFilteredGrid)
  fillClassFilter(classSelect, state.characters);
  fillPartyFilter(partySelect, state.parties);

  // ЗАПОЛНЕНИЕ АВТОРИЗАЦИИ (СТАТИЧЕСКИЙ СПИСОК)
  authSelect.innerHTML = `
    <option value="">Все статусы</option>
    <option value="online">🟢 Только авторизованные</option>
    <option value="offline">🔴 Только не авторизованные</option>
  `;

  if (tagSelect) {
    tagSelect.onchange = () => renderFilteredGrid();
    fillTagFilter(tagSelect);
  }

  const applyFilters = () => {
    renderFilteredGrid();
  };

  searchInput.oninput = applyFilters;
  classSelect.onchange = applyFilters;
  partySelect.onchange = applyFilters;
  authSelect.onchange = applyFilters; 

  // «Сбросить»: заметно, когда хотя бы один фильтр включён; одним нажатием возвращает весь список
  const clearBtn = document.getElementById('filters-clear');
  if (clearBtn) {
    clearBtn.onclick = () => {
      searchInput.value = '';
      classSelect.value = '';
      partySelect.value = '';
      authSelect.value = '';
      if (tagSelect) tagSelect.value = '';
      renderFilteredGrid();
      searchInput.focus();
    };
  }
  updateClearButton();
}

/** Показывает кнопку сброса, только если есть активный фильтр (иначе она занимает место зря). */
function updateClearButton() {
  const btn = document.getElementById('filters-clear');
  if (!btn) return;
  const active = ['search-input', 'class-filter', 'party-filter', 'auth-filter', 'tag-filter']
    .some(id => (document.getElementById(id)?.value || '') !== '');
  btn.hidden = !active;
}

/** Все теги персонажей (без учёта регистра), по алфавиту. */
export function allTags() {
  const map = new Map();
  state.characters.forEach(c => (c.tags || []).forEach(t => { if (!map.has(t.toLowerCase())) map.set(t.toLowerCase(), t); }));
  return [...map.values()].sort((a, b) => a.localeCompare(b, 'ru'));
}

function fillTagFilter(select) {
  const current = select.value;
  const tags = allTags();
  select.innerHTML = '<option value="">Все теги</option><option value="__none__">Без тегов</option>' +
    tags.map(t => `<option value="${escapeHtml(t)}">#${escapeHtml(t)}</option>`).join('');
  select.value = tags.includes(current) || current === '__none__' ? current : '';
}

/**
 * Рендер сетки с учетом активных фильтров
 */
function renderFilteredGrid() {
  const gridEl = document.getElementById('character-grid');
  if (!gridEl) return;

  // Варианты фильтров собираем из актуального state.characters при каждой отрисовке:
  // новый класс/пати/тег сразу появляется в списке, исчезнувший — сбрасывает фильтр (issue #2)
  const selectedClass = fillClassFilter(document.getElementById('class-filter'), state.characters);
  const selectedParty = fillPartyFilter(document.getElementById('party-filter'), state.parties);
  const selectedAuth = document.getElementById('auth-filter')?.value || '';
  const tagSelect = document.getElementById('tag-filter');
  if (tagSelect) fillTagFilter(tagSelect);
  const selectedTag = tagSelect?.value || '';

  const filteredChars = filterCharacters(state.characters, {
    search: document.getElementById('search-input')?.value || '',
    tag: selectedTag,
    cls: selectedClass,
    party: selectedParty,
    auth: selectedAuth
  });

  updateClearButton();
  // ОБНОВЛЯЕМ KPI НА ОСНОВЕ ОТФИЛЬТРОВАННЫХ ДАННЫХ
  updateKPIs(filteredChars);
  visibleIds = filteredChars.map(c => c.id);
  renderBulkBar();

  if (filteredChars.length === 0) {
    // Подсказка первых шагов — только когда персонажей нет вовсе. Если данные есть, но фильтр
    // ничего не нашёл, показываем именно это: иначе пользователь решит, что данные пропали.
    const onb = onboardingHtml(state);
    gridEl.innerHTML = onb || '<div class="empty-state">Ничего не найдено по заданным фильтрам.<br/><small class="muted">Измените условия или нажмите «Сбросить».</small></div>';
    bindOnboardingEvents(gridEl);
    return;
  }

  // Сортировка: Сначала онлайн, потом по алфавиту
  const sortedChars = [...filteredChars].sort((a, b) => {
      const aOnline = a.isLoggedIn ? 1 : 0;
      const bOnline = b.isLoggedIn ? 1 : 0;

      if (aOnline !== bOnline) {
          return bOnline - aOnline; // Онлайн выше
      }

      return a.nick.localeCompare(b.nick, 'ru');
  });

  gridEl.innerHTML = sortedChars.map(generateCardHTML).join('');

  bindCharacterEvents(gridEl);
}

/**
 * Генерация HTML одной карточки персонажа
 */
function generateCardHTML(char) {
    const iconSrc = getClassIconSrc(char.class);
    const avatarContent = iconSrc 
      ? `<img src="${iconSrc}" alt="${escapeHtml(char.class)}" style="width:100%; height:100%; object-fit:contain;" />`
      : `<span style="font-size:1rem; font-weight:bold; color:var(--muted);">${(char.class || '?')[0]}</span>`;

    const skyInfo = char.sky?.name ? `${escapeHtml(char.sky.name)}${char.sky.level ? ` (Ур.${char.sky.level})` : ''}` : 'Небо не выбрано';
    
    const stats = char.stats || {};
    const fmtStat = (val) => val > 0 ? val : '-';

    const emailMasked = maskText(char.contacts?.email);
    const passMasked = maskText(char.contacts?.password);
    const hasEmail = !!char.contacts?.email;
    const hasPass = !!char.contacts?.password;

    const passes = char.dungeonPasses || {};
    const passesHtml = PASS_TYPES.map(pt => {
      const count = passes[pt.key] || 0;
      const imgPath = pt.img; 
      return `
        <div class="pass-item" title="${pt.label}: ${count}" style="display:flex; align-items:center; gap:4px; background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px; font-size:0.75rem;">
          <img src="${imgPath}" alt="${pt.label}" style="width:16px; height:16px; object-fit:contain;" onerror="this.style.display='none'"/>
          <span>${count}</span>
        </div>
      `;
    }).join('');

    const coinsDisplay = formatCoins(char.ancientCoins || 0) + (needsCoinRecheck(char) ? ' <span title="Баланс записан до исправления разбора (28,5 → 285). Откройте профиль и нажмите «Перепроверить»." style="color:#f7768e; cursor:help;">⚠</span>' : '');
    const mainName = mainPartyName(char, state.parties);
    const extraNames = additionalPartiesOf(char, state.parties).map(p => p.name);
    const partyLabel = mainName
      ? `${escapeHtml(mainName)}${extraNames.length ? ` <span title="Дополнительные: ${escapeHtml(extraNames.join(', '))}">+${extraNames.length}</span>` : ''}`
      : NO_PARTY_LABEL;

    // ЛОГИКА ИНДИКАТОРА СТАТУСА
    const authView = getAuthView(char);
    const statusColor = authView.color;
    const statusText = authView.text;
    const statusTitle = escapeHtml(`${authView.title}. ${authDetails(char)}`);

    const tagsHtml = (char.tags || []).length
      ? `<div class="tag-list">${char.tags.map(t => `<span class="tag-chip" data-tag="${escapeHtml(t)}" title="Показать всех с тегом">#${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    const selecting = state.ui.selectionMode;
    const selected = selecting && state.ui.selection.has(char.id);
    const selectBox = selecting
      ? `<span class="select-box" title="Выбрать"><input type="checkbox" class="char-select" tabindex="-1" ${selected ? 'checked' : ''}/></span>`
      : '';

    return `
      <article class="card character-card clickable-card${selected ? ' is-selected' : ''}" data-char-id="${char.id}" style="--state-c:${statusColor}">

        <header class="card-header">
          <div class="card-head-main">
            ${selectBox}
            <div class="char-avatar">
              ${avatarContent}
            </div>
            <div class="char-ident">
              <h3 class="char-nick">${escapeHtml(char.nick)}</h3>
              <small class="muted char-sub">${escapeHtml(char.class)} • Ур. ${char.level}</small>
              <small class="muted char-sub">${skyInfo}</small>
            </div>
          </div>

          <div class="card-head-side">
             <!-- ИНДИКАТОР СТАТУСА -->
             <div class="state ${authView.cls}" title="${statusTitle}">
                <span class="state-dot"></span><span>${statusText}</span>
             </div>

             <span class="badge party card-party">${partyLabel}</span>

             <!-- БЛОК МОНЕТ (БЕЗ ДАТЫ СИНХРОНИЗАЦИИ) -->
             <div class="badge coins card-coins">
               <span aria-hidden="true">🪙</span><strong>${coinsDisplay}</strong>
             </div>
          </div>
        </header>

        <div class="card-body">
           ${tagsHtml}

           <div class="card-stats">
              <div><span class="muted">HP</span><strong>${fmtStat(stats.hp)}</strong></div>
              <div><span class="muted">PA</span><strong>${fmtStat(stats.pa)}</strong></div>
              <div><span class="muted">PZ</span><strong>${fmtStat(stats.pz)}</strong></div>
              <div><span class="muted">PvE-PA</span><strong>${fmtStat(stats.pvePa)}</strong></div>
              <div><span class="muted">PvE-PZ</span><strong>${fmtStat(stats.pvePz)}</strong></div>
           </div>

           <div class="card-contacts">
              <div class="contact-row-mini">
                 <span class="muted contact-key">EMAIL</span>
                 <div class="contact-row-actions">
                    <span class="contact-value mini-copy-trigger" data-type="email" title="Нажмите, чтобы скопировать" data-original="${escapeHtml(char.contacts?.email || '')}">${hasEmail ? emailMasked : '-'}</span>
                    <button class="icon-btn mini-toggle-eye" data-target="email" style="pointer-events:${hasEmail ? 'auto' : 'none'};" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
                 </div>
              </div>

              <div class="contact-row-mini">
                 <span class="muted contact-key">PASS</span>
                 <div class="contact-row-actions">
                    <span class="contact-value mini-copy-trigger" data-type="password" title="Нажмите, чтобы скопировать" data-original="${escapeHtml(char.contacts?.password || '')}">${hasPass ? passMasked : '-'}</span>
                    <button class="icon-btn mini-toggle-eye" data-target="password" style="pointer-events:${hasPass ? 'auto' : 'none'};" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
                 </div>
              </div>
           </div>
        </div>

        <footer class="card-footer">
           <!-- Левая часть: Проходки -->
           <div class="card-passes">
              ${passesHtml}
           </div>

           <!-- Правая часть: компактные кнопки — запуск игры и вход на сайт (подписи — во всплывающих подсказках) -->
           <div class="card-actions">
              <button class="card-act play${hasGameCenterPath(char) ? '' : ' is-unset'}"
                      type="button"
                      aria-label="Играть"
                      title="${hasGameCenterPath(char) ? 'Играть: запустить игру для этого персонажа' : 'Играть: сначала укажите GameCenter (откроется карточка)'}"
                      onclick="event.stopPropagation(); window.handleLaunchChar('${char.id}')">
                 <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>
              </button>
              <button id="btn-open-site-${char.id}"
                      class="card-act"
                      type="button"
                      aria-label="Открыть сайт"
                      style="${state.ui?.authCheck?.[char.id] === 'checking' ? 'cursor:not-allowed;' : ''}"
                      title="${state.ui?.authCheck?.[char.id] === 'checking' ? 'Идёт проверка входа — дождитесь окончания' : 'Открыть сайт: браузер персонажа для входа'}"
                      ${state.ui?.authCheck?.[char.id] === 'checking' ? 'disabled' : ''}
                      onclick="event.stopPropagation(); window.handleOpenSite('${char.id}')">🌐</button>
           </div>
        </footer>
      </article>
    `;
}

/**
 * Обновление KPI на основе переданного массива отфильтрованных персонажей
 */
function updateKPIs(charsToCount) {
  // Если массив пуст, ставим нули
  if (!charsToCount || charsToCount.length === 0) {
      document.getElementById('kpi-total-chars').textContent = '0';
      document.getElementById('kpi-active-parties').textContent = '0';
      document.getElementById('kpi-no-party').textContent = '0';
      document.getElementById('kpi-coins').textContent = '0';
      document.getElementById('kpi-online-count').textContent = '0';
      document.getElementById('kpi-offline-count').textContent = '0';
      return;
  }

  // 1. Всего персонажей в выборке
  const totalChars = charsToCount.length;
  document.getElementById('kpi-total-chars').textContent = totalChars;

  // 2. Активные пати (уникальные основные пати среди отфильтрованных)
  const uniquePartiesSet = new Set(charsToCount.map(c => c.mainPartyId).filter(id => partyById(state.parties, id)));
  document.getElementById('kpi-active-parties').textContent = uniquePartiesSet.size;

  // 3. Без пати
  const noPartyCount = charsToCount.filter(c => hasNoParty(c, state.parties)).length;
  document.getElementById('kpi-no-party').textContent = noPartyCount;

  // 4. Сумма древних монет
  document.getElementById('kpi-coins').textContent = formatCoins(totalCoinsOf(charsToCount));

  // 5. Онлайн (Авторизовано)
  const onlineCount = charsToCount.filter(c => c.isLoggedIn === true).length;
  const onlineEl = document.getElementById('kpi-online-count');
  if(onlineEl) {
    onlineEl.textContent = onlineCount;
    onlineEl.style.color = '#9ece6a'; // Зеленый
  }

  // 6. Оффлайн (Требуется вход)
  const offlineCount = charsToCount.filter(c => c.isLoggedIn !== true).length;
  const offlineEl = document.getElementById('kpi-offline-count');
  if(offlineEl) {
    offlineEl.textContent = offlineCount;
    offlineEl.style.color = '#f7768e'; // Красный
  }
}

/**
 * Инициализация кнопок синхронизации в UI
 */
// Кнопок может не быть в разметке (запуск скриптов идёт через меню «Скрипты»), тогда ничего не делаем.
function initSyncButtons() {
    // Кнопка "Проверить авторизацию"
    const checkBtn = document.getElementById('btn-check-auth-status');
    if(checkBtn) {
        console.log('[SYNC BUTTONS] Found Auth Check button.');
        
        // Проверяем, не навешен ли уже обработчик (чтобы не дублировать события)
        if(!checkBtn.dataset.bound) {
            checkBtn.onclick = async () => {
                console.log('[ACTION] Clicked: Check Authorization');
                checkBtn.disabled = true;
                const originalText = checkBtn.innerHTML;
                checkBtn.innerHTML = '⏳ Проверка...';
                
                try {
                    await refreshAllLoginStatuses();
                    toast('Статусы авторизации обновлены.', 'success');
                } catch (err) {
                    console.error(err);
                    toast('Ошибка проверки статусов', 'error');
                } finally {
                    setTimeout(() => {
                        checkBtn.disabled = false;
                        checkBtn.innerHTML = originalText;
                    }, 1000);
                }
            };
            checkBtn.dataset.bound = "true";
        }
    }

    // Кнопка "Обновить балансы"
    const balanceBtn = document.getElementById('btn-refresh-balances');
    if(balanceBtn) {
        console.log('[SYNC BUTTONS] Found Balance Refresh button.');
        
        if(!balanceBtn.dataset.bound) {
            balanceBtn.onclick = async () => {
                console.log('[ACTION] Clicked: Update Balances');
                balanceBtn.disabled = true;
                const originalText = balanceBtn.innerHTML;
                balanceBtn.innerHTML = '⏳ Обновление...';
                
                try {
                    await refreshAllBalances();
                } catch (err) {
                    console.error(err);
                    toast('Ошибка обновления балансов', 'error');
                } finally {
                    setTimeout(() => {
                        balanceBtn.disabled = false;
                        balanceBtn.innerHTML = originalText;
                    }, 1000);
                }
            };
            balanceBtn.dataset.bound = "true";
        }
    }
}

/**
 * Действия кнопок экрана «Сегодня»: проверка входа, обновление баланса, переходы.
 * @param {string} action
 * @param {any} payload
 */
export async function runTodayAction(action, payload) {
  if (action === 'check-auth-one') {
    const char = state.characters.find(c => c.id === payload);
    if (char) await refreshAllLoginStatuses([char]);
    return;
  }
  if (action === 'balance-one') {
    const char = state.characters.find(c => c.id === payload);
    if (char) await refreshAllBalances([char]);
    return;
  }
  if (action === 'open-marathon') {
    document.querySelector('.tab[data-tab="marathons"]')?.click();
    const { openMarathon } = await import('../marathons/page.js');
    openMarathon(payload);
    return;
  }
  if (action === 'open-party') {
    document.querySelector('.tab[data-tab="parties"]')?.click();
    return;
  }
}

/**
 * Кнопки подсказки первых шагов: ведут к нужному действию.
 * Разметка подсказки перерисовывается вместе с сеткой, поэтому обработчик навешивается каждый раз.
 */function bindOnboardingEvents(container) {
  container.querySelectorAll('[data-onb]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = /** @type {HTMLElement} */ (btn).dataset.onb;
      if (action === 'new-character') { openCharacterForm(null); return; }
      if (action === 'new-party') {
        const { openCreatePartyModal } = await import('../parties/manager.js');
        openCreatePartyModal();
        return;
      }
      if (action === 'open-help') {
        showModal({
          title: 'Как войти на сайт игры',
          content: `
            <ol class="onb-help">
              <li>Откройте карточку персонажа и заполните Email и пароль — они сразу уходят в защищённое хранилище учётных данных ОС.</li>
              <li>Нажмите <b>«🌐 Открыть сайт»</b>: откроется окно браузера персонажа с отдельной сессией, поэтому аккаунты не мешают друг другу.</li>
              <li>Войдите на сайте игры обычным способом — приложение ничего не нажимает за вас.</li>
              <li>Сессия сохранится. Дальше кнопка <b>«🔐 Проверить вход»</b> покажет, кто ещё авторизован, а кто требует повторного входа.</li>
            </ol>
            <p class="muted">Если сессия истекла, приложение подскажет это в карточке персонажа и в фильтре «Все статусы».</p>`,
          submitText: null,
          cancelText: 'Понятно'
        });
      }
    });
  });
}

function bindCharacterEvents(container) {  container.onclick = async (e) => {
    const target = e.target;

    // 0. Режим выбора: клик по карточке переключает выбор
    if (state.ui.selectionMode) {
      const card = target.closest('.clickable-card');
      if (card && !target.closest('button') && !target.closest('.contact-value')) {
        toggleSelected(card.dataset.charId);
        return;
      }
    }

    // 0a. Клик по тегу — фильтр по этому тегу
    const chip = target.closest('.tag-chip');
    if (chip) {
      e.stopPropagation();
      const tagSelect = document.getElementById('tag-filter');
      if (tagSelect) { fillTagFilter(tagSelect); tagSelect.value = chip.dataset.tag; renderFilteredGrid(); }
      return;
    }

    // 1. Мини-глазик
    const eyeBtn = target.closest('.mini-toggle-eye');
    if (eyeBtn) {
      e.stopPropagation();
      const row = eyeBtn.closest('.contact-row-mini');
      const valueSpan = row.querySelector('.mini-copy-trigger');
      
      if (valueSpan && valueSpan.dataset.original) {
        const originalVal = valueSpan.dataset.original;
        const isCurrentlyMasked = valueSpan.textContent.includes('•');
        
        if (isCurrentlyMasked) {
           valueSpan.textContent = originalVal;
           eyeBtn.innerHTML = EYE_SVG_CLOSED;
           eyeBtn.style.opacity = '1';
        } else {
           valueSpan.textContent = maskText(originalVal);
           eyeBtn.innerHTML = EYE_SVG_OPEN;
           eyeBtn.style.opacity = '0.4';
        }
      }
      return;
    }

    // 2. Мини-копирование
    const contactVal = target.closest('.mini-copy-trigger');
    if (contactVal && contactVal.dataset.original) {
       e.stopPropagation();
       navigator.clipboard.writeText(contactVal.dataset.original).then(() => {
         toast('Скопировано!', 'success');
         const oldBg = contactVal.style.background;
         contactVal.style.background = 'rgba(76, 175, 80, 0.3)';
         setTimeout(() => contactVal.style.background = oldBg, 300);
       });
       return;
    }

    // 3. Клик по карточке -> Открыть ПРОФИЛЬ
    const card = target.closest('.clickable-card');
    if (card && !target.closest('button') && !target.closest('.contact-value')) {
       const id = card.dataset.charId;
       const char = state.characters.find(c => c.id === id);
       if (char) {
         openCharacterProfile(char); // Вызываем функцию из модуля
       }
    }
  };
}

// Глобальная функция для вызова из inline onclick кнопки "Открыть сайт"
window.handleOpenSite = (charId) => {
    const char = state.characters.find(c => c.id === charId);
    if (char) {
        openSyncHelper(charId);
    } else {
        toast('Персонаж не найден', 'error');
    }
};

// Кнопка «▶ Играть» на карточке
window.handleLaunchChar = async (charId) => {
    const char = state.characters.find(c => c.id === charId);
    if (!char) { toast('Персонаж не найден', 'error'); return; }
    const { launchOne } = await import('../launcher/partyLaunch.js');
    launchOne(char);
};

export function bindCharacters() {
  const addBtn = document.getElementById('add-character-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openCharacterForm(null);
    });
  }

  document.getElementById('btn-select-mode')?.addEventListener('click', () => setSelectionMode(!state.ui.selectionMode));
  document.getElementById('bulk-bar')?.addEventListener('click', onBulkAction);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.ui.selectionMode && !document.querySelector('.modal-overlay')) setSelectionMode(false);
  });
  
  // ВАЖНО: Сначала инициализируем фильтры, потом рендерим
  initFilters(); 
  renderCharacters(); 
}

// --- ЭКСПОРТ ДЛЯ ДРУГИХ МОДУЛЕЙ ---
export { openCharacterProfile, openCharacterForm };
/* ------------------------------------------------------------------ */
/*  Режим выбора и массовые действия                                   */
/* ------------------------------------------------------------------ */

export function setSelectionMode(on) {
  state.ui.selectionMode = !!on;
  if (!on) state.ui.selection.clear();
  document.getElementById('btn-select-mode')?.classList.toggle('active', !!on);
  renderFilteredGrid();
}

function toggleSelected(id) {
  const sel = state.ui.selection;
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  const card = document.querySelector(`.character-card[data-char-id="${CSS.escape(id)}"]`);
  card?.classList.toggle('is-selected', sel.has(id));
  const box = card?.querySelector('.char-select');
  if (box) box.checked = sel.has(id);
  renderBulkBar();
}

/** Выбрать всех, кто виден после фильтров (повторный вызов снимает выбор). */
export function selectAllVisible() {
  if (!state.ui.selectionMode) setSelectionMode(true);
  const sel = state.ui.selection;
  const allSelected = visibleIds.length && visibleIds.every(id => sel.has(id));
  if (allSelected) visibleIds.forEach(id => sel.delete(id));
  else visibleIds.forEach(id => sel.add(id));
  renderFilteredGrid();
}

function selectedChars() {
  return state.characters.filter(c => state.ui.selection.has(c.id));
}

function renderBulkBar() {
  const bar = document.getElementById('bulk-bar');
  if (!bar) return;
  // Выбор не должен «помнить» удалённых персонажей
  const ids = new Set(state.characters.map(c => c.id));
  [...state.ui.selection].forEach(id => { if (!ids.has(id)) state.ui.selection.delete(id); });

  bar.hidden = !state.ui.selectionMode;
  if (!state.ui.selectionMode) return;
  const n = state.ui.selection.size;
  const dis = n ? '' : 'disabled';
  bar.innerHTML = `
    <strong class="bulk-count">Выбрано: ${n}</strong>
    <button class="btn ghost small" data-bulk="all">☑ Все по фильтру (${visibleIds.length})</button>
    <span class="bulk-sep"></span>
    <button class="btn secondary small" data-bulk="auth" ${dis}>🔐 Проверить вход</button>
    <button class="btn secondary small" data-bulk="balance" ${dis}>💰 Балансы</button>
    <button class="btn secondary small" data-bulk="promo" ${dis}>🎁 Промокод</button>
    <button class="btn secondary small" data-bulk="transfer" ${dis}>📦 Передать предметы</button>
    <button class="btn secondary small" data-bulk="launch" ${dis} title="Запустить игру для выбранных по очереди">▶ Запустить</button>
    <button class="btn secondary small" data-bulk="tag-add" ${dis}>🏷 Добавить тег</button>
    <button class="btn secondary small" data-bulk="tag-remove" ${dis}>🏷 Убрать тег</button>
    <button class="btn secondary small" data-bulk="party" ${dis}>👥 В пати</button>
    <button class="btn danger small" data-bulk="delete" ${dis}>🗑 Удалить</button>
    <button class="btn ghost small" data-bulk="close" title="Esc">✕ Готово</button>
  `;
}

async function saveAndRender(message) {
  await persist();
  renderCharacters();
  renderParties();
  if (message) toast(message, 'success');
}

function tagModal({ title, submitText, tags, onTag }) {
  const options = tags.map(t => `<option value="${escapeHtml(t)}"></option>`).join('');
  showModal({
    title,
    content: `
      <div class="field">
        <label>Тег (можно несколько через запятую)</label>
        <input class="input" name="tag" list="bulk-tag-list" autocomplete="off" autofocus />
        <datalist id="bulk-tag-list">${options}</datalist>
      </div>`,
    submitText,
    cancelText: 'Отмена',
    onSubmit(formData) {
      const list = normalizeTags(formData.get('tag'));
      if (!list.length) { toast('Введите тег', 'warning'); return false; }
      onTag(list);
    }
  });
}

async function onBulkAction(e) {
  const btn = e.target.closest('[data-bulk]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.bulk;
  const chars = selectedChars();
  const now = new Date().toISOString();

  switch (action) {
    case 'all': selectAllVisible(); break;
    case 'close': setSelectionMode(false); break;
    case 'auth': await refreshAllLoginStatuses(chars); break;
    case 'balance': await refreshAllBalances(chars); break;
    case 'promo': {
      const { openPromoDialog } = await import('../automation/promo.js');
      openPromoDialog({ ids: chars.map(c => c.id) });
      break;
    }
    case 'transfer': {
      const { openTransferDialog } = await import('../automation/transfer.js');
      openTransferDialog({ ids: chars.map(c => c.id) });
      break;
    }
    case 'launch': {
      const { launchGroup } = await import('../launcher/partyLaunch.js');
      launchGroup(`Запуск игры: выбранные (${chars.length})`, chars);
      break;
    }
    case 'tag-add':
      tagModal({
        title: `Добавить тег (${chars.length} перс.)`, submitText: 'Добавить', tags: allTags(),
        onTag: (list) => {
          chars.forEach(c => { c.tags = normalizeTags([...(c.tags || []), ...list]); c.updatedAt = now; });
          saveAndRender(`Тег добавлен: ${chars.length} перс.`);
        }
      });
      break;
    case 'tag-remove': {
      const present = [...new Set(chars.flatMap(c => c.tags || []))].sort((a, b) => a.localeCompare(b, 'ru'));
      if (!present.length) { toast('У выбранных персонажей нет тегов', 'info'); break; }
      tagModal({
        title: `Убрать тег (${chars.length} перс.)`, submitText: 'Убрать', tags: present,
        onTag: (list) => {
          const drop = new Set(list.map(t => t.toLowerCase()));
          chars.forEach(c => { c.tags = (c.tags || []).filter(t => !drop.has(t.toLowerCase())); c.updatedAt = now; });
          saveAndRender(`Тег убран: ${chars.length} перс.`);
        }
      });
      break;
    }
    case 'party': {
      // Можно выбрать существующую пати или создать новую для выбранных персонажей
      const NEW = '__new__';
      const options = [...state.parties.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`),
        `<option value="${NEW}">➕ Создать новую пати…</option>`].join('');
      showModal({
        title: `Пати (${chars.length} перс.)`,
        content: `
          <div class="field"><label>Пати</label><select class="select" name="party" id="bulk-party-select">${options}</select></div>
          <div class="field" id="bulk-party-new"><label>Название новой пати</label>
            <input class="input" name="newName" id="bulk-party-name" placeholder="Например: Группа-2" maxlength="40" autocomplete="off" />
            <small class="muted">В неё попадут выбранные персонажи (${chars.length}).</small>
          </div>
          <div class="field"><label>Действие</label>
            <label class="switch-row"><input type="radio" name="op" value="main" checked /> Сделать основной (прежняя основная станет дополнительной)</label>
            <label class="switch-row"><input type="radio" name="op" value="add" /> Добавить как дополнительную (у кого нет пати — станет основной)</label>
            <label class="switch-row" data-existing-only><input type="radio" name="op" value="remove" /> Убрать из этой пати</label>
            <label class="switch-row" data-existing-only><input type="radio" name="op" value="clear" /> Убрать из всех пати</label>
          </div>`,
        submitText: 'Применить',
        cancelText: 'Отмена',
        onSubmit(formData, { setError }) {
          const partyId = String(formData.get('party') || '');
          const op = String(formData.get('op') || 'add');
          if (partyId === NEW) {
            const res = createPartyWith(state.parties, chars, String(formData.get('newName') || ''), { asMain: op !== 'add', now });
            if ('error' in res) { setError(res.error); return false; }
            saveAndRender(`Создана пати «${res.party.name}»: ${res.changed} перс.`);
            return;
          }
          const party = partyById(state.parties, partyId);
          if (op === 'clear') {
            chars.forEach(c => { c.partyIds = []; c.mainPartyId = null; c.updatedAt = now; });
            saveAndRender(`Убраны из всех пати: ${chars.length}`);
            return;
          }
          if (!party) return false;
          let changed = 0;
          chars.forEach(c => {
            const did = op === 'main' ? setMainParty(c, party.id) : setMembership(c, party.id, op === 'add');
            if (did) { c.updatedAt = now; changed++; }
          });
          const msg = { main: `Основная пати «${party.name}»`, add: `Добавлены в «${party.name}»`, remove: `Убраны из «${party.name}»` }[op];
          saveAndRender(`${msg}: ${changed}`);
        }
      });
      // «Создать новую» — показываем поле названия; «убрать из пати» к новой пати не относится
      const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('bulk-party-select'));
      const sync = () => {
        const isNew = sel?.value === NEW;
        const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };
        show(document.getElementById('bulk-party-new'), isNew);
        document.querySelectorAll('#modal-root [data-existing-only]').forEach(el => show(el, !isNew));
        if (isNew) {
          const keep = /** @type {HTMLInputElement | null} */ (document.querySelector('#modal-root input[name="op"][value="add"]'));
          const main = /** @type {HTMLInputElement | null} */ (document.querySelector('#modal-root input[name="op"][value="main"]'));
          if (main && !keep?.checked) main.checked = true;   // «убрать» к новой пати не относится
          document.getElementById('bulk-party-name')?.focus();
        }
      };
      sel?.addEventListener('change', sync);
      sync();
      break;
    }
    case 'delete': {
      const ok = await confirmModal({
        title: `Удалить персонажей: ${chars.length}?`,
        text: 'Действие необратимо. Вместе с персонажами удаляются их пароли в хранилище ОС, запомненные входы GameCenter и история монет.',
        okText: `Удалить (${chars.length})`,
        danger: true
      });
      if (ok) {
        const ids = new Set(chars.map(c => c.id));
        state.characters = state.characters.filter(c => !ids.has(c.id));
        state.ui.selection.clear();
        saveAndRender(`Удалено: ${ids.size}`);
      }
      break;
    }
  }
}
