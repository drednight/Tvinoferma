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
//! - `automation` — (заготовка) промокоды, перевод предметов;
//! - `injection` — (заготовка) панель и CSS поверх страниц игры.
//!
//! Скрипты, которые внедряются в страницы сайта, лежат в `src/scripts/*.js`.

mod auth;
mod automation;
mod balance;
mod commands;
mod cookie_bank;
mod injection;
mod marathons;
mod parsers;
mod pool;
mod tray;
mod windows;

use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .manage(tray::TraySettings::default())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                tray::setup(app)?;
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
            // трей
            tray::set_close_to_tray,
            // куки-банк
            cookie_bank::bank_status,
            cookie_bank::bank_verify,
            cookie_bank::bank_forget,
            pool::pool_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
