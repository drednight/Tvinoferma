//! Твиноферма — Tauri-бэкенд.
//!
//! Модули:
//! - `windows`   — окна браузера персонажей (видимые и скрытые профили);
//! - `parsers`   — общий цикл «скрипт → ответ в hash», «Проверка безопасности»;
//! - `auth`      — проверка входа на pwonline.ru;
//! - `balance`   — баланс древних монет;
//! - `marathons` — прогресс, поиск и разбор марафонов;
//! - `commands`  — state.json, резервные копии, учётные данные в keychain ОС;
//! - `cookie_bank` — зашифрованный банк кук: сессии персонажей на pwonline.ru;
//! - `pool`      — пул воркеров: общие скрытые окна, куки персонажа берутся из банка;
//! - `stats_ocr` — распознавание экрана боя (GUILD и т.п.);
//! - `vault`     — запись секретов в хранилище ОС; на Windows есть запасной способ, если keyring не может писать (ошибка 1312);
//! - `tray`      — иконка в трее;
//! - `automation` — промокоды (`activate_promo`) и передача предметов (`read_transfer_page`, `read_server_status`, `transfer_items`);
//! - `injection` — (заготовка) панель и CSS поверх страниц игры;
//! - `autostart` — запуск вместе с Windows (запись в `Run`, режим «в трее»);
//! - `elevate` — помощник с правами администратора: подписать окна игры от администратора без перезапуска;
//! - `layout_sync` — копирование образца layout поверх остальных `.ini` папки Layout (команды — `commands/layout.rs`);
//! - `launcher`  — запуск GameCenter (VK Play) для аккаунта, подтверждение «Запустить новую копию клиента», закрытие клиентов игры.
//!
//! Скрипты, которые внедряются в страницы сайта, лежат в `src/scripts/*.js`.

mod auth;
mod automation;
mod autostart;
mod balance;
#[cfg(windows)]
mod cloud_credential_binding;
#[cfg(windows)]
mod cloud_credential_lock;
#[cfg(windows)]
mod cloud_credential_records;
#[cfg(windows)]
mod cloud_credential_service;
#[cfg(windows)]
mod cloud_credential_store;
#[cfg(windows)]
mod cloud_dataset_binding;
mod cloud_disk_transport;
#[cfg(windows)]
mod cloud_initial_outbox;
#[cfg(windows)]
mod cloud_key_state;
mod cloud_oauth_callback;
mod cloud_oauth_transport;
#[cfg(windows)]
mod cloud_outbox_store;
mod commands;
mod cookie_bank;
mod elevate;
mod guild;
mod injection;
mod launcher;
mod layout_sync;
mod marathons;
mod notify;
mod parsers;
mod pool;
mod shortcut;
mod stats_ocr;
mod tray;
mod vault;
mod windows;

use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Запуск-помощник: подписать окна или закрыть клиенты от администратора и выйти.
    // Проверяем до сборки Tauri — помощнику ни окно, ни трей, ни журнал не нужны.
    if elevate::run_as_helper_if_requested() {
        return;
    }
    tauri::Builder::default()
        // Плагин одиночного экземпляра обязан идти первым: он проверяет именованный мьютекс
        // в `setup` плагинов, то есть до создания окон из `tauri.conf.json`. Регистрируй
        // его раньше остальных плагинов — иначе второй запуск успеет создать своё окно
        // и значок в трее, и в трее будет висеть два процесса (жалобы пользователей).
        //
        // Текущий экземпляр лежит в трее (окно скрыто), поэтому появление второго запуска
        // должно не просто показать окно, а вернуть его из трея: развернуть, поднять
        // поверх остальных и забрать фокус.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .manage(tray::TraySettings::default())
        .manage(windows::BrowserSettings::default())
        .setup(|app| {
            // Регистрируем приложение как источник уведомлений сразу: тогда оно находится
            // в поиске Windows и появляется в «Параметры → Уведомления» ещё до первого уведомления
            notify::register_at_startup();
            // Ярлык установщик называет по productName («Tvinoferma»), поэтому переименовываем
            // в русское имя: иначе поиск Windows не находит приложение по слову «Твиноферма»
            shortcut::ensure_russian_shortcut();
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                tray::setup(app)?;
                // Явно ставим иконку главному окну: Tauri v2 не принимает `icon` в конфиге окна,
                // а без неё Windows иногда показывает пустой значок на панели задач.
                if let (Some(main), Some(icon)) =
                    (app.get_webview_window("main"), app.default_window_icon())
                {
                    let _ = main.set_icon(icon.clone());
                }
                // Большой слот окна (`ICON_BIG`) Tauri не ставит вовсе, а без него панель задач
                // рисует пустой лист. Ставим его из ресурса exe (см. `apply_app_taskbar_icon`).
                #[cfg(windows)]
                if let Some(main) = app.get_webview_window("main") {
                    if let Ok(hwnd) = main.hwnd() {
                        launcher::apply_app_taskbar_icon(hwnd.0 as usize);
                    }
                }
                // Автозапуск «в трее»: окно не показываем, приложение сразу работает в фоне
                if autostart::started_minimized() {
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.hide();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            match event {
                WindowEvent::CloseRequested { api, .. } if label == "main" => {
                    let settings = window.state::<tray::TraySettings>();
                    if settings.close_to_tray.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // Скрытые окна персонажей не должны держать приложение после закрытия главного окна
                WindowEvent::Destroyed if label == "main" => {
                    window.app_handle().exit(0);
                }
                // Окно персонажа закрыли — закрываем и его окна авторизации (OAuth-попапы).
                // Иначе попап остаётся жить отдельно, а в нём уже не работает `window.opener`.
                WindowEvent::Destroyed if label.starts_with("sync-win-") => {
                    windows::close_popups_of(window.app_handle(), label);
                }
                WindowEvent::CloseRequested { .. }
                    if label.starts_with("sync-win-") || label.starts_with("popup-sync-win-") =>
                {
                    println!("[RUST EVENT] Browser window closed: {}", label);
                    let _ = window.app_handle().emit_to(
                        "main",
                        "browser-window-closed",
                        serde_json::json!({ "label": label }),
                    );
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // окна
            windows::open_sync_window,
            windows::close_sync_window,
            windows::check_window_exists,
            windows::execute_script_in_window,
            windows::rename_char_profiles,
            // закрыть только окна авторизации (окно входа уже подтверждено)
            windows::close_auth_popups,
            // клановый сайт Guild: отдельное окно, сводка профиля, отметки на ивенты
            guild::open_guild_window,
            guild::close_guild_window,
            guild::guild_window_exists,
            guild::guild_sync,
            guild::guild_set_response,
            guild::guild_vote_poll,
            // скрипты сайта
            automation::promo::activate_promo,
            automation::caravan::open_caravan_chests,
            automation::shop::read_shop,
            automation::shop::read_shop_history,
            automation::shop::buy_shop_item,
            automation::transfer::read_transfer_page,
            automation::transfer::read_server_status,
            automation::transfer::transfer_items,
            auth::check_login_status_http,
            balance::fetch_and_parse_balance_v4,
            marathons::fetch_marathon_progress_v1,
            marathons::get_available_marathon_titles,
            marathons::parse_specific_marathon_page,
            marathons::fetch_marathon_news,
            // хранилище
            commands::state::load_state,
            commands::state::load_state_raw,
            commands::state::save_state,
            commands::state::save_state_if_unchanged,
            commands::state::get_data_dir,
            commands::backup::create_backup,
            commands::backup::create_migration_backup,
            commands::backup::list_backups,
            commands::backup::inspect_backup,
            commands::backup::restore_backup,
            commands::backup::delete_backup,
            commands::secrets::secrets_available,
            commands::secrets::secrets_get_many,
            commands::secrets::secrets_set_many,
            commands::secrets::secrets_delete_many,
            // Экспериментальная локальная авторизация; обмен файлами ещё не подключён.
            commands::cloud_credentials::cloud_credential_read,
            commands::cloud_credentials::cloud_credential_binding_read,
            commands::cloud_credentials::cloud_credential_install,
            commands::cloud_credentials::cloud_credential_compare_exchange,
            commands::cloud_credentials::cloud_credential_forget,
            commands::cloud_credentials::cloud_credential_forget_if_unbound,
            // Экспериментальный ключ данных; настройка в UI ещё не реализована.
            commands::cloud_dataset_binding::cloud_dataset_binding_read,
            commands::cloud_dataset_binding::cloud_dataset_binding_install,
            commands::cloud_dataset_binding::cloud_dataset_binding_forget,
            commands::cloud_key_state::cloud_key_state_read,
            commands::cloud_key_state::cloud_key_state_install,
            commands::cloud_key_state::cloud_key_state_compare_exchange,
            commands::cloud_key_state::cloud_key_state_forget,
            // Экспериментальная очередь первого снимка; автосинхронизация ещё не готова.
            commands::cloud_outbox::cloud_outbox_read,
            commands::cloud_outbox::cloud_outbox_install_initial,
            commands::cloud_outbox::cloud_outbox_compare_exchange,
            // Диагностика и первый вход OAuth; синхронизация пока не включена.
            commands::cloud_oauth::cloud_oauth_callback_begin,
            commands::cloud_oauth::cloud_oauth_callback_poll,
            commands::cloud_oauth::cloud_oauth_callback_cancel,
            commands::cloud_oauth_transport::cloud_oauth_network,
            // Экспериментальные операции с версиями; UI и очередь не подключены.
            commands::cloud_disk_transport::cloud_disk_network,
            // полный сброс: «Вернуть к заводским настройкам»
            commands::factory_reset::factory_reset,
            // трей
            tray::set_close_to_tray,
            tray::set_tray_parties,
            // видимые окна браузера
            windows::set_unlimited_items,
            windows::set_collection_panel,
            windows::take_collection_reports,
            // куки-банк
            cookie_bank::bank_status,
            cookie_bank::bank_verify,
            cookie_bank::bank_forget,
            pool::pool_status,
            // автозапуск вместе с Windows
            autostart::autostart_status,
            autostart::autostart_set,
            // мгновенная остановка выполняющегося скрипта
            parsers::cancel_scope_command,
            parsers::resume_scope_command,
            // запуск GameCenter
            launcher::launcher_check_path,
            launcher::launcher_gc_info,
            launcher::launcher_pick_gamecenter,
            // Layout: образец раскладки поверх остальных файлов папки
            commands::layout::layout_pick_folder,
            commands::layout::layout_pick_file,
            commands::layout::layout_scan,
            commands::layout::layout_apply,
            commands::layout::layout_unlock,
            launcher::launcher_start,
            launcher::launcher_running_clients,
            launcher::launcher_close_clients,
            launcher::launcher_close_clients_elevated,
            launcher::launcher_find_dialogs,
            launcher::launcher_inspect_windows,
            launcher::launcher_self_elevated,
            elevate::launcher_run_elevated,
            elevate::launcher_relaunch_elevated,
            launcher::launcher_capture_account,
            launcher::launcher_forget_account,
            launcher::launcher_has_account,
            // список запущенных окон игры и закрытие выбранных
            launcher::launcher_running_details,
            launcher::launcher_close_clients_pids,
            // повторная подпись окон (название и значок) после запуска
            launcher::launcher_decorate_clients,
            // ручная смена названия и значка у запущенного окна
            launcher::launcher_apply_window_style,
            // разбор скриншота с характеристиками персонажа
            stats_ocr::stats_ocr_available,
            stats_ocr::stats_ocr_read,
            // системные уведомления Windows: регистрация приложения как источника и показ
            notify::tf_notify,
            notify::tf_notify_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
