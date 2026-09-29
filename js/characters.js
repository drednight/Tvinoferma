// js/characters.js

import { state } from './state.js';
import { persist } from './storage.js';
import { escapeHtml } from './utils.js';
import { toast } from './ui.js';
import { bindParties, renderParties } from './parties/index.js';

// Импортируем константы
import { CLASSES, CLASS_ICON_MAP, SKIES, SKY_LEVELS, PASS_TYPES, getClassIconSrc } from './constants.js';

// Импортируем модульную систему персонажей
import { bindCharactersModule, openCharacterProfile, openCharacterForm } from './characters/index.js';

// НОВЫЕ ИМПОРТЫ ДЛЯ СИНХРОНИЗАЦИИ
import { refreshAllBalances, refreshAllLoginStatuses, openSyncHelper } from './syncManager.js';

let expandedCharacterId = null;

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

  if (!searchInput || !classSelect || !partySelect || !authSelect) return;

  // Заполнение классов
  const uniqueClasses = [...new Set(state.characters.map(c => c.class).filter(Boolean))];
  uniqueClasses.sort((a, b) => a.localeCompare(b, 'ru'));

  classSelect.innerHTML = '<option value="">Все классы</option>' + 
    uniqueClasses.map(cls => `<option value="${escapeHtml(cls)}">${escapeHtml(cls)}</option>`).join('');

  // Заполнение пати
  const uniqueParties = [...new Set(state.characters.map(c => c.party).filter(Boolean))];
  uniqueParties.sort((a, b) => a.localeCompare(b, 'ru'));

  partySelect.innerHTML = '<option value="">Все пати</option><option value="__none__">Без пати</option>' + 
    uniqueParties.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');

  // ЗАПОЛНЕНИЕ АВТОРИЗАЦИИ (СТАТИЧЕСКИЙ СПИСОК)
  authSelect.innerHTML = `
    <option value="">Все статусы</option>
    <option value="online">🟢 Только авторизованные</option>
    <option value="offline">🔴 Только не авторизованные</option>
  `;

  const applyFilters = () => {
    renderFilteredGrid();
  };

  searchInput.oninput = applyFilters;
  classSelect.onchange = applyFilters;
  partySelect.onchange = applyFilters;
  authSelect.onchange = applyFilters; 
}

/**
 * Рендер сетки с учетом активных фильтров
 */
function renderFilteredGrid() {
  const gridEl = document.getElementById('character-grid');
  if (!gridEl) return;

  const searchTerm = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  const selectedClass = document.getElementById('class-filter')?.value || '';
  const selectedParty = document.getElementById('party-filter')?.value || '';
  const selectedAuth = document.getElementById('auth-filter')?.value || ''; 

  let filteredChars = state.characters;

  // 1. Поиск по нику
  if (searchTerm) {
    filteredChars = filteredChars.filter(c => c.nick.toLowerCase().includes(searchTerm));
  }

  // 2. Фильтр по классу
  if (selectedClass) {
    filteredChars = filteredChars.filter(c => c.class === selectedClass);
  }

  // 3. Фильтр по пати
  if (selectedParty) {
    if (selectedParty === '__none__') {
      filteredChars = filteredChars.filter(c => !c.party);
    } else {
      filteredChars = filteredChars.filter(c => c.party === selectedParty);
    }
  }

  // 4. НОВЫЙ ФИЛЬТР ПО АВТОРИЗАЦИИ
  if (selectedAuth === 'online') {
    filteredChars = filteredChars.filter(c => c.isLoggedIn === true);
  } else if (selectedAuth === 'offline') {
    filteredChars = filteredChars.filter(c => c.isLoggedIn !== true);
  }

  // ОБНОВЛЯЕМ KPI НА ОСНОВЕ ОТФИЛЬТРОВАННЫХ ДАННЫХ
  updateKPIs(filteredChars);

  if (filteredChars.length === 0) {
    gridEl.innerHTML = '<div class="empty-state">Ничего не найдено по заданным фильтрам.</div>';
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

    const coinsDisplay = char.ancientCoins ? char.ancientCoins.toLocaleString('ru-RU') : '0';
    const partyLabel = char.party ? escapeHtml(char.party) : 'Без пати';

    // ЛОГИКА ИНДИКАТОРА СТАТУСА
    const isOnline = char.isLoggedIn === true;
    const statusColor = isOnline ? '#9ece6a' : '#f7768e'; // Зеленый / Красный
    const statusIcon = isOnline ? '🟢' : '🔴';
    const statusText = isOnline ? 'Онлайн' : 'Оффлайн';
    const statusTitle = isOnline ? 'Аккаунт авторизован' : 'Требуется вход или истекла сессия';

    return `
      <article class="card character-card clickable-card" data-char-id="${char.id}" style="display:flex; flex-direction:column; height:auto; min-height:280px; overflow:hidden; cursor:pointer; transition: transform 0.2s, box-shadow 0.2s; border-left: 3px solid ${statusColor};">
        
        <header class="card-header" style="padding:12px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:flex-start; background:var(--panel-2);">
          <div style="display:flex; gap:10px; align-items:center; flex-grow:1;">
            <div style="width:36px; height:36px; background:rgba(255,255,255,0.05); border-radius:6px; display:flex; align-items:center; justify-content:center; overflow:hidden; border:1px solid var(--border); flex-shrink:0;">
              ${avatarContent}
            </div>
            <div style="overflow:hidden;">
              <h3 style="margin:0; font-size:1rem; color:var(--accent); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px;">${escapeHtml(char.nick)}</h3>
              <small class="muted" style="font-size:0.75rem; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(char.class)} • Ур. ${char.level}</small>
              <small class="muted" style="font-size:0.75rem; display:block; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${skyInfo}</small>
            </div>
          </div>
          
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0;">
             <!-- ИНДИКАТОР СТАТУСА -->
             <div style="display:flex; align-items:center; gap:4px; font-size:0.7rem; color:${statusColor}; margin-bottom:2px;" title="${statusTitle}">
                <span>${statusIcon}</span>
                <span>${statusText}</span>
             </div>

             <span class="badge muted" style="background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px; font-size:0.7rem; white-space:nowrap;">
               ${partyLabel}
             </span>
             
             <!-- БЛОК МОНЕТ (БЕЗ ДАТЫ СИНХРОНИЗАЦИИ) -->
             <div style="display:flex; align-items:center; gap:4px; background: rgba(255, 215, 0, 0.1); padding:2px 8px; border-radius:10px; border:1px solid rgba(255, 215, 0, 0.2);">
               <span style="color:gold; font-size:0.8rem;">🪙</span>
               <strong style="color:gold; font-size:0.85rem; font-weight:600;">${coinsDisplay}</strong>
             </div>
          </div>
        </header>

        <div class="card-body" style="flex-grow:1; padding:12px; display:flex; flex-direction:column; gap:12px;">
           
           <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:4px; text-align:center; font-size:0.75rem; background:rgba(0,0,0,0.15); padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
              <div><span class="muted">HP</span><br/><strong>${fmtStat(stats.hp)}</strong></div>
              <div><span class="muted">PA</span><br/><strong>${fmtStat(stats.pa)}</strong></div>
              <div><span class="muted">PZ</span><br/><strong>${fmtStat(stats.pz)}</strong></div>
              <div><span class="muted">PvE-PA</span><br/><strong>${fmtStat(stats.pvePa)}</strong></div>
              <div><span class="muted">PvE-PZ</span><br/><strong>${fmtStat(stats.pvePz)}</strong></div>
           </div>

           <div style="display:flex; flex-direction:column; gap:6px; font-size:0.8rem;">
              <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:4px;" class="contact-row-mini">
                 <span class="muted" style="font-size:0.7rem;">EMAIL:</span>
                 <div style="display:flex; align-items:center; gap:6px;">
                    <span class="contact-value mini-copy-trigger" data-type="email" data-original="${escapeHtml(char.contacts?.email || '')}" style="cursor:pointer; color:var(--text-primary); font-family:monospace;">${hasEmail ? emailMasked : '-'}</span>
                    <button class="icon-btn mini-toggle-eye" data-target="email" style="opacity:0.4; transition: opacity 0.2s; pointer-events:${hasEmail ? 'auto' : 'none'}; display:flex; align-items:center;" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
                 </div>
              </div>

              <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:4px;" class="contact-row-mini">
                 <span class="muted" style="font-size:0.7rem;">PASS:</span>
                 <div style="display:flex; align-items:center; gap:6px;">
                    <span class="contact-value mini-copy-trigger" data-type="password" data-original="${escapeHtml(char.contacts?.password || '')}" style="cursor:pointer; color:var(--text-primary); font-family:monospace;">${hasPass ? passMasked : '-'}</span>
                    <button class="icon-btn mini-toggle-eye" data-target="password" style="opacity:0.4; transition: opacity 0.2s; pointer-events:${hasPass ? 'auto' : 'none'}; display:flex; align-items:center;" title="Показать/Скрыть">${EYE_SVG_OPEN}</button>
                 </div>
              </div>
           </div>
        </div>

        <footer class="card-footer" style="padding:8px 12px; border-top:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; background:var(--panel);">
           <!-- Левая часть: Проходки -->
           <div style="display:flex; gap:6px;">
              ${passesHtml}
           </div>
           
           <!-- Правая часть: Кнопка Открыть Сайт -->
           <button id="btn-open-site-${char.id}" 
                   class="btn ghost small" 
                   style="font-size:0.7rem; padding:2px 8px; border:1px solid var(--border); border-radius:4px; cursor:pointer;"
                   title="Открыть браузер для входа"
                   onclick="event.stopPropagation(); window.handleOpenSite('${char.id}')">
               🌐 Открыть сайт
           </button>
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

  // 2. Активные пати (уникальные названия пати среди отфильтрованных)
  const uniquePartiesSet = new Set(charsToCount.map(c => c.party).filter(Boolean));
  document.getElementById('kpi-active-parties').textContent = uniquePartiesSet.size;

  // 3. Без пати
  const noPartyCount = charsToCount.filter(c => !c.party).length;
  document.getElementById('kpi-no-party').textContent = noPartyCount;

  // 4. Сумма древних монет
  const totalCoins = charsToCount.reduce((sum, c) => sum + (Number(c.ancientCoins) || 0), 0);
  document.getElementById('kpi-coins').textContent = totalCoins.toLocaleString('ru-RU');

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
function initSyncButtons() {
    console.log('[SYNC BUTTONS] Searching for buttons...');

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
    } else {
        console.warn('[SYNC BUTTONS] Button #btn-check-auth-status NOT FOUND in DOM!');
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
    } else {
        console.warn('[SYNC BUTTONS] Button #btn-refresh-balances NOT FOUND in DOM!');
    }
}

function bindCharacterEvents(container) {
  container.onclick = async (e) => {
    const target = e.target;

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

export function bindCharacters() {
  const addBtn = document.getElementById('add-character-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openCharacterForm(null);
    });
  }
  
  // ВАЖНО: Сначала инициализируем фильтры, потом рендерим
  initFilters(); 
  renderCharacters(); 
}

// --- ЭКСПОРТ ДЛЯ ДРУГИХ МОДУЛЕЙ ---
export { openCharacterProfile, openCharacterForm };