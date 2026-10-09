// js/main.js

import { state, normalizeState } from './core/state.js';
import { loadData, persist, createBackup, isTauri } from './core/storage.js';
import { migrateState, SCHEMA_VERSION } from './core/migrations.js';
import { hydrateSecrets } from './core/secrets.js';
import { initHotkeys, initDesktop } from './desktop/desktop.js';
import { initNotifications } from './desktop/notifications.js';
import { startUpdateScheduler } from './desktop/updater.js';
import { resolveUpdateMode } from './desktop/updateSchedule.js';
import { subscribeUpdate, setUpdateState } from './desktop/updateState.js';
import { initUpdateUi } from './desktop/updateUi.js';
import { initParserHealthUi } from './settings/parserHealthUi.js';
import { startFreshnessTicker } from './core/freshness.js';
import { bindCharacters, renderCharacters, initRunningWindowsTracking } from './modules/characters/list.js';
import { runTodayAction } from './modules/characters/list.js';
import { renderToday } from './modules/dashboard/todayView.js';
import { refreshRunningWindows } from './modules/launcher/runningWindows.js';
import { bindParties, renderParties } from './modules/parties/index.js';
import { bindMarathons, renderMarathons, resetMarathonView } from './modules/marathons/page.js';
import { bindRunes, renderRunes } from './modules/runes/index.js';
import { bindTools, renderTools } from './modules/tools/index.js';
import { initTaskLog } from './core/taskLog.js';
import { initStickyHeader } from './core/stickyHeader.js';
import { bindSettings, renderSettings } from './settings/settings.js';
import { toast } from './core/ui.js';
import { initSyncListeners, verifySavedLoginsOnStartup } from './modules/sync/syncManager.js'; 
import { mountServerStatus } from './modules/servers/serverStatusView.js';
import { mountMskClock } from './modules/servers/mskClock.js';
import { loadServerStatusOnStartup, startServerStatusScheduler } from './modules/servers/serverStatus.js';
import { initNavBadges, refreshNavBadges } from './core/navBadges.js';

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
        // Старая версия при сохранении перепишет файл в своём формате и может потерять новые поля —
        // поэтому до любой записи оставляем копию исходного файла
        if (isTauri()) {
          try { await createBackup(`newer-schema-v${migration.from}`); } catch (e) { console.warn('[BOOT] Backup of newer data failed:', e); }
        }
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
    const secrets = await hydrateSecrets(
      [...state.characters, ...state.archivedCharacters],
      { tauri: isTauri(), aliases: idAliases }
    );
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
      initRunningWindowsTracking();
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
      bindRunes();
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Runes:', e);
    }

    try {
      bindTools();
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Tools:', e);
    }

    try {
      bindSettings();
      console.log('[BOOT] Settings bound.');
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Settings:', e);
    }

    // 4. Привязка навигации по вкладкам и счётчиков разделов
    bindNavigation();
    initNavBadges();
    // Повторный вызов приветственного окна: инструкция должна быть доступна и позже
    document.getElementById('welcome-btn')?.addEventListener('click', async () => {
      const { openWelcome } = await import('./modules/characters/list.js');
      openWelcome();
    });
    console.log('[BOOT] Navigation bound.');

    // 5. Инициализация UI Actions (FAB, Меню скриптов)
    // Важно: это должно быть ПОСЛЕ рендера основных элементов, чтобы найти их в DOM
    try {
        initUiActions();
        initStickyHeader();
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

    // Плашка «Статус серверов» в шапке: сначала последнее сохранённое чтение, затем обновляется само
    mountServerStatus(document.getElementById('server-status'));
    // Часы по Москве над плашкой: ЧЧ:ММ:СС, тикают раз в секунду
    mountMskClock(document.getElementById('msk-clock'));

    // 7. Первый рендер активной вкладки
    renderActiveTab('today');

    console.log('[BOOT] Application ready.');

    // 8. Фоновые проверки при запуске (не блокируют интерфейс). Порядок: сначала «Статус серверов»
    // (публичная страница, аккаунты не нужны), затем проверка сохранённых авторизаций персонажей.
    if (window.__TAURI_INTERNALS__) {
      (async () => {
        await loadServerStatusOnStartup(() => state.settings);
        startServerStatusScheduler(() => state.settings);
        if (state.settings?.autoVerifyLogins !== false) {
          await verifySavedLoginsOnStartup().catch(e => console.error('[BOOT] Startup auth check failed:', e));
        }
      })().catch(e => console.error('[BOOT] Startup checks failed:', e));
    }

    // 9. Обновления: обязательная тихая проверка при каждом запуске; дополнительные проверки по расписанию
    initUpdateUi();
    initParserHealthUi();
    startFreshnessTicker(() => state.settings);   // «5 мин назад» пересчитывается раз в минуту
    // Время последней успешной проверки хранится в настройках, чтобы расписание переживало перезапуск
    const savedCheck = state.settings?.updates?.lastCheckedAt;
    if (savedCheck) setUpdateState({ lastCheckedAt: savedCheck });
    subscribeUpdate((s) => {
      if ((s.status === 'uptodate' || s.status === 'available') && s.lastCheckedAt
        && s.lastCheckedAt !== state.settings.updates?.lastCheckedAt) {
        state.settings.updates = { ...state.settings.updates, lastCheckedAt: s.lastCheckedAt };
        persist();
      }
    });
    if (isTauri()) {
      startUpdateScheduler({
        getMode: () => resolveUpdateMode(state.settings),
        getLastChecked: () => state.settings?.updates?.lastCheckedAt
      });
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
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === targetSection));
      const sectionTitle = document.getElementById('next-section-title');
      if (sectionTitle) sectionTitle.textContent = tab.querySelector('strong')?.textContent
        || tab.querySelector('span:not([aria-hidden])')?.textContent
        || targetSection;
      const sectionSubtitle = document.getElementById('next-section-subtitle');
      if (sectionSubtitle) sectionSubtitle.textContent = tab.dataset.subtitle || '';

      // Скрываем ранее открытые разделы и даём им знать, что их покинули:
      // на «Сегодня» и «Персонажах» по этому событию снимаются подписки на список окон игры
      pages.forEach(page => {
        const wasActive = page.classList.contains('active');
        page.classList.toggle('active', page.dataset.section === targetSection);
        if (wasActive && page.dataset.section !== targetSection) {
          page.dispatchEvent(new CustomEvent('tf-leave'));
        }
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
      case 'today':
        renderToday(document.getElementById('today-root'), { run: runTodayAction });
        // Список окон игры нужен и на «Сегодня» (блок запущенных окон), и на «Персонажах»
        // (кнопка закрытия окна в карточке). Он общий и меняется после запуска/закрытия,
        // поэтому обновляем его при каждом переходе на эти вкладки.
        if (isTauri()) refreshRunningWindows().catch(() => {});
        break;
      case 'characters':
        renderCharacters();
        if (isTauri()) refreshRunningWindows().catch(() => {});
        break;      case 'parties':
        renderParties();
        break;
      case 'marathons':
        resetMarathonView();   // клик по вкладке всегда возвращает к списку марафонов
        renderMarathons();
        break;
      case 'runes':
        renderRunes();
        break;
      case 'tools':
        renderTools();
        // Список окон игры нужен и здесь (управление окнами), и на «Сегодня», и в карточке
        if (isTauri()) refreshRunningWindows().catch(() => {});
        break;
      case 'settings':
        renderSettings();
        break;
      default:
        console.warn(`[NAV] Unknown section: ${sectionName}`);
    }
    refreshNavBadges();   // число записей могло измениться во время отрисовки раздела
  } catch (err) {
    console.error(`[RENDER ERROR in ${sectionName}]`, err);
    toast(`Ошибка отображения раздела "${sectionName}". Подробности в консоли.`, 'error');
  }
}

/** Переключить вкладку ��рограммно (горячие клавиши). */
function switchTab(sectionName) {
  document.querySelector(`.tab[data-tab="${sectionName}"]`)?.click();
}

// Запуск приложения после полной загрузки DOM
document.addEventListener('DOMContentLoaded', boot);