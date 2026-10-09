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
//! - `tray`      — иконка в трее;
//! - `automation` — промокоды (`activate_promo`) и передача предметов (`read_transfer_page`, `read_server_status`, `transfer_items`);
//! - `injection` — (заготовка) панель и CSS поверх страниц игры;
//! - `autostart` — запуск вместе с Windows (запись в `Run`, режим «в трее»);
//! - `layout_sync` — копирование образца layout поверх остальных `.ini` папки Layout (команды — `commands/layout.rs`);
//! - `launcher`  — запуск GameCenter (VK Play) для аккаунта, подтверждение «Запустить новую копию клиента», закрытие клиентов игры.
//!
//! Скрипты, которые внедряются в страницы сайта, лежат в `src/scripts/*.js`.

mod auth;
mod automation;
mod autostart;
mod balance;
mod commands;
mod cookie_bank;
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
mod windows;

use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            commands::state::save_state,
            commands::state::get_data_dir,
            commands::backup::create_backup,
            commands::backup::list_backups,
            commands::backup::restore_backup,
            commands::backup::delete_backup,
            commands::secrets::secrets_available,
            commands::secrets::secrets_get_many,
            commands::secrets::secrets_set_many,
            commands::secrets::secrets_delete_many,
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
