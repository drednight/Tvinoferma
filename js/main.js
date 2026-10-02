// js/main.js

import { state, normalizeState } from './core/state.js';
import { loadData, persist, createBackup, isTauri } from './core/storage.js';
import { migrateState, SCHEMA_VERSION } from './core/migrations.js';
import { hydrateSecrets } from './core/secrets.js';
import { initHotkeys, initDesktop } from './desktop/desktop.js';
import { initNotifications } from './desktop/notifications.js';
import { startUpdateScheduler } from './desktop/updater.js';
import { initUpdateUi } from './desktop/updateUi.js';
import { bindCharacters, renderCharacters } from './modules/characters/list.js';
import { bindParties, renderParties } from './modules/parties/index.js';
import { bindMarathons, renderMarathons, resetMarathonView } from './modules/marathons/page.js';
import { initTaskLog } from './core/taskLog.js';
import { bindSettings, renderSettings } from './settings/settings.js';
import { toast } from './core/ui.js';
import { initSyncListeners, verifySavedLoginsOnStartup } from './modules/sync/syncManager.js'; 

// === ИМПОРТ ФУНКЦИЙ ДЛЯ FAB ===
import { initUiActions, updateFabVisibility } from './core/uiActions.js'; 

// Слушатели событий поиска марафонов на сайте
import { initDiscoveryListener } from './modules/marathons/discoveryLauncher.js';

/**
 * Главная точка входа приложения
 */
async function boot() {
  try {
    console.log('[BOOT] Starting Twinoferma...');
    
    // 1. Загрузка данных из хранилища
    let raw = null;
    try {
      raw = await loadData();
    } catch (e) {
      console.error('[BOOT] Failed to load state:', e);
      alert(`Не удалось прочитать данные: ${e?.message || e}\nПриложение запустится с пустыми данными, повреждённый файл сохранён рядом с state.json.`);
    }
    let needsSave = false;
    let idAliases = {}; // { новый id: старый id } после миграции v4
    if (raw) {
      // 1a. Миграции схемы: перед изменением формата делаем резервную копию исходного файла
      const migration = migrateState(raw);
      if (migration.newer) {
        toast(`Данные созданы более новой версией приложения (схема v${migration.from}, поддерживается v${SCHEMA_VERSION}). Обновите приложение.`, 'warning');
      } else if (migration.applied.length) {
        console.log(`[BOOT] Migrating state v${migration.from} → v${migration.to}`);
        if (isTauri()) {
          try { await createBackup(`pre-migration-v${migration.from}`); } catch (e) { console.warn('[BOOT] Pre-migration backup failed:', e); }
        }
        needsSave = true;
      }
      Object.assign(state, normalizeState(migration.state));

      // 1b. id персонажей стали читаемыми (из ника): переносим профили браузера, чтобы не слетел вход
      const remap = migration.idRemap || {};
      if (Object.keys(remap).length) {
        idAliases = Object.fromEntries(Object.entries(remap).map(([oldId, newId]) => [newId, oldId]));
        console.log('[BOOT] Character ids →', remap);
        if (isTauri()) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const failed = await invoke('rename_char_profiles', { remap });
            if (failed?.length) console.warn('[BOOT] Profiles not moved (re-login needed):', failed);
          } catch (e) { console.warn('[BOOT] rename_char_profiles failed:', e); }
        }
      }
      console.log('[BOOT] State loaded successfully.');
    } else {
      console.log('[BOOT] No saved data found. Using defaults.');
    }

    // 1c. Учётные данные из хранилища ОС (и перенос туда открытых паролей из старого state.json)
    const secrets = await hydrateSecrets(state.characters, { tauri: isTauri(), aliases: idAliases });
    if (secrets.migrated > 0) {
      needsSave = true;
      toast(`Учётные данные ${secrets.migrated} персонажей перенесены в защищённое хранилище ОС.`, 'success');
    }
    if (needsSave) await persist().catch(e => console.error('[BOOT] Save after migration failed:', e));

    // 2. Инициализация слушателей синхронизации PW Online
    // Делаем это ДО рендера UI, чтобы не пропустить ранние события от окон
    try {
        await initSyncListeners();
        await initTaskLog();
        console.log('[BOOT] Sync listeners initialized.');
    } catch (e) {
        console.error('[BOOT ERROR] Failed to initialize sync listeners:', e);
        toast('Модуль синхронизации недоступен', 'warning');
    }

    // 3. Инициализация модулей с изоляцией ошибок
    
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
      
      // === ИНИЦИАЛИЗАЦИЯ СЛУШАТЕЛЯ ПОИСКА МАРАФОНОВ ===
      // Это должно быть после bindMarathons, чтобы DOM был готов
      await initDiscoveryListener();
      console.log('[BOOT] Marathon discovery listener initialized.');
      
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

    // 4. Привязка навигации по вкладкам
    bindNavigation();
    console.log('[BOOT] Navigation bound.');

    // 5. Инициализация UI Actions (FAB, Меню скриптов)
    // Важно: это должно быть ПОСЛЕ рендера основных элементов, чтобы найти их в DOM
    try {
        initUiActions();
        console.log('[BOOT] UI Actions (FAB/Menus) initialized.');
    } catch (e) {
        console.error('[BOOT ERROR] Failed to init UI Actions:', e);
    }

    // 6. Горячие клавиши, трей, фоновые проверки, уведомления
    initHotkeys({ switchTab });
    try {
      await initDesktop();
      initNotifications();
    } catch (e) {
      console.error('[BOOT ERROR] Failed to init desktop features:', e);
    }

    // 7. Первый рендер активной вкладки (по умолчанию Персонажи)
    renderActiveTab('characters');

    console.log('[BOOT] Application ready.');

    // 8. Фоновая проверка сохранённых авторизаций (не блокирует интерфейс)
    if (window.__TAURI_INTERNALS__ && state.settings?.autoVerifyLogins !== false) {
      verifySavedLoginsOnStartup().catch(e => console.error('[BOOT] Startup auth check failed:', e));
    }

        // 9. Обновления: кнопка в шапке и в настройках; тихая проверка при запуске и раз в 6 часов
    initUpdateUi();
    if (isTauri()) {
      startUpdateScheduler({ isEnabled: () => state.settings?.updates?.checkOnStartup !== false });
    }

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
      
      // === ОБНОВЛЯЕМ СОСТОЯНИЕ FAB ПРИ СМЕНЕ ВКЛАДКИ ===
      updateFabVisibility(targetSection);
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
        resetMarathonView();   // клик по вкладке всегда возвращает к списку марафонов
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
  }
}

/** Переключить вкладку программно (горячие клавиши). */
function switchTab(sectionName) {
  document.querySelector(`.tab[data-tab="${sectionName}"]`)?.click();
}

// Запуск приложения после полной загрузки DOM
document.addEventListener('DOMContentLoaded', boot);