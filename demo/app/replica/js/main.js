// js/main.js

import { state, normalizeState } from './core/state.js';
import {
  loadData,
  persist,
  createBackup,
  isTauri,
  protectIncompatibleState,
  forgetLoadedState,
  beginGuardedMigration,
  commitGuardedMigration,
  abortGuardedMigration
} from './core/storage.js';
import { migrateState, SCHEMA_VERSION } from './core/migrations.js';
import { blockUnsafeVaultRead, hydrateSecrets } from './core/secrets.js';
import { hasSafeVaultCharacterMapping } from './core/vaultIdentity.js';
import { initHotkeys, initDesktop } from './desktop/desktop.js';
import { initNotifications } from './desktop/notifications.js';
import { bindNotifyCenter } from './core/notifyCenter.js';
import { initSound } from './desktop/sound.js';
import { initGettingStarted } from './settings/gettingStarted.js';
import { startUpdateScheduler } from './desktop/updater.js';
import { resolveUpdateMode } from './desktop/updateSchedule.js';
import { subscribeUpdate, setUpdateState } from './desktop/updateState.js';
import { initUpdateUi } from './desktop/updateUi.js';
import { initParserHealthUi } from './settings/parserHealthUi.js';
import { startFreshnessTicker } from './core/freshness.js';
import {
  bindCharacters,
  renderCharacters,
  initRunningWindowsTracking,
  suppressAutomaticWelcome
} from './modules/characters/list.js';
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
import { bindGuild, applyGuildVisibility, startGuildDailySync } from './modules/guild/page.js';
import { applySections, resolveSection } from './core/sections.js';
import { bindFinance, renderFinance } from './modules/finance/page.js';

// === ИМПОРТ ФУНКЦИЙ ДЛЯ FAB ===
import { initUiActions, updateFabVisibility } from './core/uiActions.js';

// Слушатели событий поиска марафонов на сайте
import { initDiscoveryListener } from './modules/marathons/discoveryLauncher.js';

function showStorageReadOnlyWarning(message) {
  const banner = document.getElementById('storage-readonly-banner');
  if (!banner) return;
  const text = banner.querySelector('[data-storage-warning-text]');
  if (text) text.textContent = message;
  banner.hidden = false;
}

// A failed confirmation can mean that the file did change. Do not silently
// retry with stale in-memory data; storage stops new writes in this context.
window.addEventListener('tf-factory-reset-read-failed', () => {
  showStorageReadOnlyWarning(
    'Не удалось проверить исходные данные перед сбросом. Сохранение и сброс остановлены; проверьте файл и резервные копии.'
  );
});

window.addEventListener('tf-factory-reset-started', () => {
  showStorageReadOnlyWarning('Выполняется сброс локальных данных. Новые изменения не сохраняются до перезапуска.');
});

window.addEventListener('tf-storage-uncertain', event => {
  const vault = event.detail?.source === 'vault';
  const reset = event.detail?.source === 'reset';
  showStorageReadOnlyWarning(
    reset
      ? 'Сброс мог затронуть часть данных, но не подтверждён. Сохранение, повтор сброса и восстановление остановлены; проверьте данные и копии перед перезапуском.'
      : vault
        ? 'Запись остановлена: хранилище учётных данных могло измениться или не совпадает с прочитанным. Проверьте контакты и копии перед перезапуском; копии state.json могут не содержать контакты.'
        : 'Результат последней записи неизвестен. Изменения не сохраняются. Проверьте данные и резервные копии перед перезапуском.'
  );
  if (reset) return; // сообщение об операции покажет вызывающая сторона
  toast(
    vault
      ? 'Не удалось подтвердить изменение хранилища учётных данных. Новые записи остановлены; проверьте контакты и копии. Несохранённые изменения могут потеряться.'
      : 'Не удалось подтвердить изменение сохранённых данных. Новые записи остановлены. Проверьте данные, копии и свободное место перед перезапуском; несохранённые изменения могут потеряться.',
    'error',
    60000
  );
});

/**
 * Главная точка входа приложения
 */
export async function boot() {
  try {
    console.log('[BOOT] Starting Twinoferma...');

    // 1. Загрузка данных из хранилища
    let raw = null;
    let startupReadOnly = false;
    try {
      raw = await loadData();
    } catch (e) {
      startupReadOnly = true;
      suppressAutomaticWelcome();
      showStorageReadOnlyWarning(
        'Данные не удалось прочитать. Изменения не сохраняются; проверьте исходные данные и резервные копии перед перезапуском.'
      );
      console.error('[BOOT] Failed to load state:', e);
      alert(
        `Не удалось прочитать данные: ${e?.message || e}\nСохранение остановлено, чтобы не перезаписать прежние данные. В настройках можно восстановить резервную копию. До восстановления или перезапуска новые изменения не сохранятся.`
      );
    }
    let needsSave = false;
    let guardedMigration = false;
    let migratedSecrets = 0;
    let idAliases = {}; // { новый id: старый id } после миграции v4
    let idRemap = {};
    let vaultMappingSafe = true;
    const plaintextIds = new Set();
    const stopForVaultRead = (conflict = false) => {
      blockUnsafeVaultRead();
      abortGuardedMigration();
      protectIncompatibleState();
      forgetLoadedState(raw);
      startupReadOnly = true;
      needsSave = false;
      guardedMigration = false;
      suppressAutomaticWelcome();
      showStorageReadOnlyWarning(
        conflict
          ? 'Открытые контакты и данные хранилища ОС различаются. Сохранение остановлено; проверьте обе версии и резервные копии перед перезапуском.'
          : 'Учётные данные не удалось безопасно прочитать. Изменения не сохраняются; проверьте хранилище ОС и копии перед перезапуском. Копии state.json могут не содержать контакты.'
      );
      alert(
        conflict
          ? 'Открытые контакты в файле и данные хранилища ОС различаются. Запись остановлена, ни одна версия не заменена. Проверьте обе версии и резервные копии; автоматического разрешения пока нет.'
          : 'Не удалось безопасно прочитать хранилище учётных данных. Запись и перенос контактов остановлены. Проверьте доступ к хранилищу ОС, исходные данные и резервные копии перед перезапуском. Копия state.json может не содержать контакты.'
      );
    };
    if (raw) {
      // 1a. Миграции схемы: перед изменением формата делаем резервную копию исходного файла
      const migration = migrateState(raw);
      if (migration.newer) {
        protectIncompatibleState();
        startupReadOnly = true;
        suppressAutomaticWelcome();
        showStorageReadOnlyWarning(
          'Данные созданы более новой версией приложения. Изменения не сохраняются; обновите Твиноферму или восстановите подходящую копию.'
        );
        alert(
          `Данные созданы более новой версией приложения (схема v${migration.from}, поддерживается v${SCHEMA_VERSION}). Сохранение остановлено, чтобы не потерять новые поля. Обновите Твиноферму; изменения в этой версии не сохранятся.`
        );
        // Дополнительная копия полезна, но её неуспех не разрешает запись старой схемы.
        if (isTauri()) {
          try {
            await createBackup(`newer-schema-v${migration.from}`);
          } catch (e) {
            console.warn('[BOOT] Backup of newer data failed:', e);
          }
        }
      } else if (migration.applied.length) {
        console.log(`[BOOT] Migrating state v${migration.from} → v${migration.to}`);
        try {
          // До переноса профилей или контактов нужна точная копия именно загруженного
          // состояния. Старые резервные копии при этом не удаляются.
          await beginGuardedMigration(raw, `pre-migration-v${migration.from}`);
          guardedMigration = true;
          needsSave = true;
        } catch {
          protectIncompatibleState();
          forgetLoadedState(raw);
          startupReadOnly = true;
          suppressAutomaticWelcome();
          showStorageReadOnlyWarning(
            'Резервная копия исходных данных не подтверждена или данные изменились. Изменения не сохраняются; проверьте копии и свободное место перед перезапуском.'
          );
          console.warn('[BOOT] Migration backup could not be confirmed; saving stopped.');
          alert(
            'Не удалось подтвердить резервную копию исходных данных или данные изменились. Миграция и сохранение остановлены. Проверьте свободное место и резервные копии, затем перезапустите приложение. Изменения до перезапуска не сохранятся.'
          );
        }
      }
      if (migration.newer) forgetLoadedState(raw);
      Object.assign(state, normalizeState(migration.state));
      if (
        !startupReadOnly &&
        isTauri() &&
        (raw.secretsInVault === true || state.settings.security?.useVault !== false)
      ) {
        // До чтения vault убеждаемся, что нормализация и миграция не смешали
        // исходные ID персонажей (включая архивных) и цепочки старых ключей.
        vaultMappingSafe = hasSafeVaultCharacterMapping(raw, migration, state);
      }
      // Отличаем намеренно пустые открытые контакты от null-заглушки vault.
      for (const [source, normalized] of [
        [raw.characters, state.characters],
        [raw.archivedCharacters, state.archivedCharacters]
      ]) {
        if (!Array.isArray(source)) continue;
        source.forEach((character, index) => {
          if (character?.contacts != null && normalized[index]?.id) plaintextIds.add(normalized[index].id);
        });
      }

      // Пока только готовим карту старых ключей. Перенос профилей выполняется
      // после безопасного чтения vault и подтверждения нужной резервной копии.
      idRemap = migration.idRemap || {};
      if (!startupReadOnly && Object.keys(idRemap).length) {
        idAliases = Object.fromEntries(Object.entries(idRemap).map(([oldId, newId]) => [newId, oldId]));
      }
      console.log('[BOOT] State loaded successfully.');
    } else {
      console.log('[BOOT] No saved data found. Using defaults.');
    }

    // 1c. Флаг в исходном файле нельзя терять при нормализации: он означает,
    // что пустые значения из state.json не доказывают отсутствие контактов в vault.
    const hasVaultMarker = raw && Object.hasOwn(raw, 'secretsInVault');
    const invalidVaultMarker = hasVaultMarker && raw.secretsInVault !== true && raw.secretsInVault !== false;
    if (!startupReadOnly && (invalidVaultMarker || !vaultMappingSafe)) stopForVaultRead();
    if (!startupReadOnly) {
      const secrets = await hydrateSecrets([...state.characters, ...state.archivedCharacters], {
        tauri: isTauri(),
        aliases: idAliases,
        requiresVault: raw?.secretsInVault === true,
        plaintextIds
      });
      if (secrets.blocked) {
        stopForVaultRead(secrets.conflict === true);
      } else if (secrets.migrated > 0) {
        // И без миграции схемы перенос открытых контактов сначала требует
        // точной копии файла, из которого они прочитаны. Vault копия не охватывает.
        if (raw && !guardedMigration) {
          try {
            await beginGuardedMigration(raw, 'pre-vault-migration');
            guardedMigration = true;
          } catch {
            protectIncompatibleState();
            forgetLoadedState(raw);
            startupReadOnly = true;
            suppressAutomaticWelcome();
            showStorageReadOnlyWarning(
              'Копия перед переносом учётных данных не подтверждена. Изменения не сохраняются; проверьте данные, копии и свободное место перед перезапуском.'
            );
            alert(
              'Не удалось подтвердить копию перед переносом учётных данных. Перенос и сохранение остановлены; проверьте исходные данные, резервные копии и свободное место.'
            );
          }
        }
        if (!startupReadOnly) {
          needsSave = true;
          migratedSecrets = secrets.migrated;
        }
      }
    }
    if (raw && !guardedMigration) forgetLoadedState(raw);

    if (!startupReadOnly && Object.keys(idRemap).length) {
      console.log('[BOOT] Character ids →', idRemap);
      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const failed = await invoke('rename_char_profiles', { remap: idRemap });
          if (failed?.length) console.warn('[BOOT] Profiles not moved (re-login needed):', failed);
        } catch (e) {
          console.warn('[BOOT] rename_char_profiles failed:', e);
        }
      }
    }

    let savedMigration = false;
    if (needsSave && guardedMigration) {
      try {
        await commitGuardedMigration();
        savedMigration = true;
      } catch {
        startupReadOnly = true;
        suppressAutomaticWelcome();
        showStorageReadOnlyWarning(
          'Сохранение миграции не подтверждено. Изменения не сохраняются; проверьте копии. Профили и хранилище учётных данных могли уже измениться.'
        );
        console.warn('[BOOT] Guarded migration could not be confirmed; saving stopped.');
        alert(
          'Не удалось подтвердить сохранение миграции. Запись остановлена. Проверьте данные и резервные копии перед перезапуском; профили и хранилище учётных данных могли уже измениться. Новые изменения до перезапуска не сохранятся.'
        );
      }
    } else if (needsSave) {
      try {
        await persist();
        savedMigration = true;
      } catch (e) {
        console.error('[BOOT] Save after migration failed:', e);
      }
    }
    if (savedMigration && migratedSecrets > 0 && state.settings.security?.useVault !== false) {
      toast(`Учётные данные ${migratedSecrets} персонажей перенесены в защищённое хранилище ОС.`, 'success');
    }

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
      if (marList) marList.innerHTML = '<div class="empty-state" style="color:red;">Ошибка загрузки марафонов.</div>';
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

    try {
      bindFinance();
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Finance:', e);
    }

    // Клан Eternals: скрытая страница, по умолчанию выключена
    try {
      bindGuild();
      applyGuildVisibility();
      // Во время восстановления не запускаем фоновые обновления на неполном состоянии.
      if (!startupReadOnly) startGuildDailySync();
    } catch (e) {
      console.error('[BOOT ERROR] Failed to bind Guild:', e);
    }

    // 4. Привязка навигации по вкладкам и счётчиков разделов
    bindNavigation();
    initNavBadges();
    // Повторный вызов приветственного окна: инструкция должна быть доступна и позже
    document.getElementById('welcome-btn')?.addEventListener('click', async () => {
      const { openWelcome } = await import('./modules/characters/list.js');
      openWelcome().catch(e => console.warn('[ONBOARDING] Не удалось сохранить отметку:', e));
    });
    // Базовый гайд по приложению: кнопки в шапке и в «Настройки → Справка» + один автопоказ
    initGettingStarted({ autoOpen: !startupReadOnly });
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
    // Звук уведомлений: браузерный движок разрешает его только после первого клика (js/desktop/sound.js)
    initSound();
    bindNotifyCenter();
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

    // 7. Порядок и видимость разделов по настройке. Именно здесь, а не в разметке: раздел
    // выключается и переставляется без перезагрузки, поэтому кнопки на месте со своими
    // обработчиками, а меняются только их порядок и `hidden`.
    applySections(document, state.settings);

    // 8. Первый рендер активной вкладки
    renderActiveTab('today');

    console.log('[BOOT] Application ready.');

    // 9. Фоновые проверки при запуске (не блокируют интерфейс). Порядок: сначала «Статус серверов»
    // (публичная страница, аккаунты не нужны), затем проверка сохранённых авторизаций персонажей.
    if (window.__TAURI_INTERNALS__ && !startupReadOnly) {
      (async () => {
        await loadServerStatusOnStartup(() => state.settings);
        startServerStatusScheduler(() => state.settings);
        if (state.settings?.autoVerifyLogins !== false) {
          await verifySavedLoginsOnStartup().catch(e => console.error('[BOOT] Startup auth check failed:', e));
        }
      })().catch(e => console.error('[BOOT] Startup checks failed:', e));
    }

    // 10. Обновления: обязательная тихая проверка при каждом запуске; дополнительные проверки по расписанию
    initUpdateUi();
    initParserHealthUi();
    startFreshnessTicker(() => state.settings); // «5 мин назад» пересчитывается раз в минуту
    // Время последней успешной проверки хранится в настройках, чтобы расписание переживало перезапуск
    const savedCheck = state.settings?.updates?.lastCheckedAt;
    if (savedCheck) setUpdateState({ lastCheckedAt: savedCheck });
    subscribeUpdate(s => {
      if (
        (s.status === 'uptodate' || s.status === 'available') &&
        s.lastCheckedAt &&
        s.lastCheckedAt !== state.settings.updates?.lastCheckedAt
      ) {
        state.settings.updates = { ...state.settings.updates, lastCheckedAt: s.lastCheckedAt };
        if (!startupReadOnly) persist().catch(e => console.warn('[UPDATES] Не удалось сохранить время проверки:', e));
      }
    });
    if (isTauri()) {
      startUpdateScheduler({
        getMode: () => resolveUpdateMode(state.settings),
        getLastChecked: () => state.settings?.updates?.lastCheckedAt
      });
    }
  } catch (error) {
    abortGuardedMigration();
    protectIncompatibleState();
    suppressAutomaticWelcome();
    showStorageReadOnlyWarning(
      'Запуск не завершён. Изменения не сохраняются; проверьте исходные данные и резервные копии перед перезапуском.'
    );
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
      if (sectionTitle)
        sectionTitle.textContent =
          tab.querySelector('strong')?.textContent ||
          tab.querySelector('span:not([aria-hidden])')?.textContent ||
          targetSection;
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
        // renderToday сам вызывает renderGuildToday в конце — второй раз звать не надо
        renderToday(document.getElementById('today-root'), { run: runTodayAction });
        // Список окон игры нужен и на «Сегодня» (блок запущенных окон), и на «Персонажах»
        // (кнопка закрытия окна в карточке). Он общий и меняется после запуска/закрытия,
        // поэтому обновляем его при каждом переходе на эти вкладки.
        if (isTauri()) refreshRunningWindows().catch(() => {});
        break;
      case 'characters':
        renderCharacters();
        if (isTauri()) refreshRunningWindows().catch(() => {});
        break;
      case 'parties':
        renderParties();
        // Список окон игры нужен и на «Пати» (кнопка «🔖» подписать окна в карточке пати).
        // Он общий и меняется после запуска/закрытия, поэтому обновляем его при входе.
        if (isTauri()) refreshRunningWindows().catch(() => {});
        break;
      case 'marathons':
        resetMarathonView(); // клик по вкладке всегда возвращает к списку марафонов
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
      case 'finance':
        renderFinance();
        break;
      case 'settings':
        renderSettings();
        break;
      default:
        console.warn(`[NAV] Unknown section: ${sectionName}`);
    }
    refreshNavBadges(); // число записей могло измениться во время отрисовки раздела
  } catch (err) {
    console.error(`[RENDER ERROR in ${sectionName}]`, err);
    toast(`Ошибка отображения раздела "${sectionName}". Подробности в консоли.`, 'error');
  }
}

/** Переключить вкладку ��рограммно (горячие клавиши). */
/**
 * Переключить раздел программно: горячие клавиши, палитра команд, сохранённые команды.
 *
 * Раздел могли выключить в настройках, а прийти сюда можно откуда угодно — из палитры или
 * из команды. Клик по спрятанной кнопке ничего не делает, и человек остался бы на прежнем
 * экране без объяснений, поэтому выключенный раздел заменяем первым видимым.
 */
function switchTab(sectionName) {
  const target = resolveSection(sectionName, state.settings);
  if (target.id !== String(sectionName)) {
    console.warn(`[NAV] Раздел «${sectionName}» выключен, открываю «${target.title}»`);
  }
  document.querySelector(`.tab[data-tab="${target.id}"]`)?.click();
}

// Запуск снимка выполняет demo/app/bootstrap.js только после изоляции окружения.
