//! Иконка в трее: сворачивание вместо закрытия, быстрые действия, выход.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, State};

/// Закрытие главного окна прячет его в трей (настройка из интерфейса).
#[derive(Default)]
pub struct TraySettings {
    pub close_to_tray: AtomicBool,
}

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn setup(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Открыть Твиноферму", true, None::<&str>)?;
    let auth = MenuItem::with_id(
        app,
        "check-auth",
        "🔐 Проверить авторизацию",
        true,
        None::<&str>,
    )?;
    let balance = MenuItem::with_id(
        app,
        "update-balance",
        "💰 Обновить балансы",
        true,
        None::<&str>,
    )?;
    let marathons = MenuItem::with_id(
        app,
        "update-marathons",
        "🏃 Обновить марафоны",
        true,
        None::<&str>,
    )?;
    // Все скрипты спрятаны в подменю: в основном меню только «Открыть», «Скрипты» и «Выход»
    let scripts = Submenu::with_items(app, "📜 Скрипты", true, &[&auth, &balance, &marathons])?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &scripts, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Твиноферма")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            action => {
                // Скрипты выполняет интерфейс — пересылаем ему действие
                let _ = app.emit_to("main", "tray-action", action.to_string());
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[tauri::command]
pub fn set_close_to_tray(settings: State<'_, TraySettings>, enabled: bool) {
    settings.close_to_tray.store(enabled, Ordering::Relaxed);
}
