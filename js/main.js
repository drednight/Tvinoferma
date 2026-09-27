// js/main.js

import { state } from './state.js';
import { loadData, persist } from './storage.js'; // Или loadState/saveNow, в зависимости от твоей реализации storage
import { normalizeState } from './state.js';
import { bindCharacters, renderCharacters } from './characters.js';
import { bindParties, renderParties } from './parties.js';
import { bindMarathons, renderMarathons } from './marathon.js';
import { bindSettings, renderSettings } from './settings.js';
import { toast } from './ui.js';

async function boot() {
  try {
    console.log('[BOOT] Starting application...');
    
    // 1. Загрузка данных
    const raw = await loadData(); 
    if (raw) {
      Object.assign(state, normalizeState(raw));
      console.log('[BOOT] State loaded successfully.');
    } else {
      console.log('[BOOT] No saved data found. Using defaults.');
    }

    // 2. Инициализация модулей с изоляцией ошибок
    // Даже если Марафоны упадут, Персонажи и Настройки должны работать
    
    try {
      bindCharacters();
      console.log('[BOOT] Characters bound.');
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Characters:', e);
    }

    try {
      bindParties();
      console.log('[BOOT] Parties bound.');
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Parties:', e);
    }

    try {
      bindMarathons(); // Эта функция вызывает renderMarathons() внутри себя
      console.log('[BOOT] Marathons bound & rendered.');
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind/render Marathons:', e);
      // Можно показать заглушку в контейнере марафонов
      const marList = document.getElementById('marathon-list');
      if(marList) marList.innerHTML = '<div class="empty-state" style="color:red;">Ошибка загрузки модуля Марафонов.</div>';
    }

    try {
      bindSettings();
      console.log('[BOOT] Settings bound.');
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Settings:', e);
    }

    // 3. Привязка навигации по вкладкам (Должна быть последней, чтобы точно отработала)
    bindNavigation();
    console.log('[BOOT] Navigation bound.');

    // 4. Первый рендер активной вкладки (по умолчанию Персонажи)
    // Используем безопасную обертку из твоего кода
    renderActiveTab('characters');

  } catch (error) {
    console.error('[BOOT CRITICAL ERROR]', error);
    alert(`Критическая ошибка запуска приложения: ${error.message}\nПроверьте консоль разработчика.`);
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
    
    // Попытка восстановить UI: показываем пустой контейнер или сообщение об ошибке
    const container = document.querySelector(`.page[data-section="${sectionName}"]`);
    if (container) {
       // Не трогаем toolbar, только контент ниже
       const contentArea = container.querySelector('#character-grid') || 
                           container.querySelector('#party-list') || 
                           container.querySelector('#marathon-list') ||
                           container.querySelector('.settings-grid'); // Для настроек
      
      if(contentArea) {
         contentArea.innerHTML = `<div class="empty-state" style="color: var(--danger);">Не удалось загрузить данные. Ошибка: ${escapeHtmlSimple(err.message)}</div>`;
      }
    }
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

document.addEventListener('DOMContentLoaded', boot);