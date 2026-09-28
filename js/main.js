// js/main.js

import { state } from './state.js';
import { loadData, persist } from './storage.js'; 
import { normalizeState } from './state.js';
import { bindCharacters, renderCharacters } from './characters.js';
import { bindParties, renderParties } from './parties.js';
import { bindMarathons, renderMarathons } from './marathon.js';
import { bindSettings, renderSettings } from './settings.js';
import { toast } from './ui.js';
import { initSyncListeners, refreshAllBalances } from './syncManager.js'; // Импортируем функции синхронизации

/**
 * Главная точка входа приложения
 */
async function boot() {
  try {
    console.log('[BOOT] Starting Twinoferma...');
    
    // 1. Загрузка данных из хранилища
    const raw = await loadData(); 
    if (raw) {
      Object.assign(state, normalizeState(raw));
      console.log('[BOOT] State loaded successfully.');
    } else {
      console.log('[BOOT] No saved data found. Using defaults.');
    }

    // 2. Инициализация слушателей синхронизации PW Online
    // Делаем это ДО рендера UI, чтобы не пропустить ранние события от окон
    try {
        await initSyncListeners();
        console.log('[BOOT] Sync listeners initialized.');
    } catch (e) {
        console.error('[BOOT ERROR] Failed to initialize sync listeners:', e);
        toast('Модуль синхронизации недоступен', 'warning');
    }

    // 3. Инициализация модулей с изоляцией ошибок
    // Даже если один модуль упадет, остальные должны работать
    
    try {
      bindCharacters();
      console.log('[BOOT] Characters bound.');
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Characters:', e);
      toast('Ошибка загрузки персонажей', 'error');
    }

    try {
      bindParties();
      console.log('[BOOT] Parties bound.');
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Parties:', e);
    }

    try {
      bindMarathons(); 
      console.log('[BOOT] Marathons bound & rendered.');
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind/render Marathons:', e);
      const marList = document.getElementById('marathon-list');
      if(marList) marList.innerHTML = '<div class="empty-state" style="color:red;">Ошибка загрузки марафонов.</div>';
    }

    try {
      bindSettings();
      console.log('[BOOT] Settings bound.');
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Settings:', e);
    }

    // 4. Привязка глобальных контролов (кнопки вне карточек)
    bindGlobalControls();

    // 5. Привязка навигации по вкладкам
    bindNavigation();
    console.log('[BOOT] Navigation bound.');

    // 6. Первый рендер активной вкладки (по умолчанию Персонажи)
    renderActiveTab('characters');

    console.log('[BOOT] Application ready.');

  } catch (error) {
    console.error('[BOOT CRITICAL ERROR]', error);
    alert(`Критическая ошибка запуска: ${error.message}`);
  }
}

/**
 * Логика переключения вкладок
 */
function bindNavigation() {
  const tabs = document.querySelectorAll('.tab');
  const pages = document.querySelectorAll('.page');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetSection = tab.dataset.tab;

      // Обновляем активную вкладку визуально
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Переключаем видимость секций
      pages.forEach(page => {
        page.classList.toggle('active', page.dataset.section === targetSection);
      });

      // Вызываем рендер конкретной секции
      renderActiveTab(targetSection);
    });
  });
}

/**
 * Безопасный вызов рендера для выбранной секции
 */
function renderActiveTab(sectionName) {
  try {
    switch (sectionName) {
      case 'characters':
        renderCharacters();
        break;
      case 'parties':
        renderParties();
        break;
      case 'marathons':
        renderMarathons();
        break;
      case 'settings':
        renderSettings();
        break;
      default:
        console.warn(`[NAV] Unknown section: ${sectionName}`);
    }
  } catch (err) {
    console.error(`[RENDER ERROR in ${sectionName}]`, err);
    toast(`Ошибка отображения раздела "${sectionName}". Подробности в консоли.`, 'error');
    
    // Попытка восстановить UI
    const container = document.querySelector(`.page[data-section="${sectionName}"]`);
    if (container) {
       const contentArea = container.querySelector('#character-grid') || 
                           container.querySelector('#party-list') || 
                           container.querySelector('#marathon-list') ||
                           container.querySelector('.settings-grid'); 
      
      if(contentArea) {
         contentArea.innerHTML = `<div class="empty-state" style="color: var(--danger);">Не удалось загрузить данные. Ошибка: ${escapeHtmlSimple(err.message)}</div>`;
      }
    }
  }
}

/**
 * Привязка событий к глобальным кнопкам интерфейса
 */
function bindGlobalControls() {
  
  // Кнопка "Обновить все балансы" (должна быть в HTML с id="btn-refresh-all-balances")
  const btnRefreshAll = document.getElementById('btn-refresh-all-balances');
  if (btnRefreshAll) {
    btnRefreshAll.addEventListener('click', async () => {
      const charsWithAccounts = state.characters.filter(c => c.contacts?.email);
      
      if (charsWithAccounts.length === 0) {
        toast('Нет персонажей с введенными контактами.', 'warning');
        return;
      }

      btnRefreshAll.disabled = true;
      const originalText = btnRefreshAll.textContent;
      btnRefreshAll.textContent = '⏳ Проверка...';

      try {
        await refreshAllBalances();
      } catch (err) {
        console.error(err);
        toast('Ошибка при массовом обновлении', 'error');
      } finally {
        btnRefreshAll.disabled = false;
        btnRefreshAll.textContent = originalText;
      }
    });
  }
}

// Простая экранировка для сообщений об ошибках
function escapeHtmlSimple(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Запуск приложения после полной загрузки DOM
document.addEventListener('DOMContentLoaded', boot);