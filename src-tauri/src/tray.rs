//! Иконка в трее: сворачивание вместо закрытия, быстрые действия, выход.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Runtime, State};

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

/// Сколько пати показываем в меню трея (длинный список в меню неудобен).
const MAX_PARTIES: usize = 30;
const MAX_FAVORITES: usize = 30;
/// Префикс пункта «запустить пати»: после него идёт название пати (JS находит пати по названию).
const LAUNCH_PREFIX: &str = "launch-party:";
const FAVORITE_PREFIX: &str = "launch-favorite:";
/// Пункты «Ввести промокод», «Передать предметы в игру» и «Активация подарков»: им нужно окно приложения (выбор персонажей и предметов)
const PROMO_ACTION: &str = "promo";
const TRANSFER_ACTION: &str = "transfer";
const SHOP_ACTION: &str = "shop";

/// Меню трея: «Открыть», «Запустить пати» (по списку пати), «Закрыть все окна игры», «Скрипты» (проверка входа, балансы, промокод, передача предметов, активация подарков, марафоны), «Выход».
fn build_menu<R: Runtime, M: Manager<R>>(
    app: &M,
    parties: &[String],
    favorites: &[String],
) -> tauri::Result<Menu<R>> {
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
    let promo = MenuItem::with_id(app, PROMO_ACTION, "🎁 Ввести промокод", true, None::<&str>)?;
    let transfer = MenuItem::with_id(
        app,
        TRANSFER_ACTION,
        "📦 Передать предметы в игру",
        true,
        None::<&str>,
    )?;
    let shop = MenuItem::with_id(
        app,
        SHOP_ACTION,
        "🪙 Активация подарков",
        true,
        None::<&str>,
    )?;
    // Все скрипты спрятаны в подменю: в основном меню только «Открыть», «Запустить пати», «Скрипты» и «Выход»
    let scripts = Submenu::with_items(
        app,
        "📜 Скрипты",
        true,
        &[&auth, &balance, &promo, &transfer, &shop, &marathons],
    )?;

    let party_items = parties
        .iter()
        .take(MAX_PARTIES)
        .map(|name| {
            MenuItem::with_id(
                app,
                format!("{}{}", LAUNCH_PREFIX, name),
                format!("▶ {}", name),
                true,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<MenuItem<R>>>>()?;
    let party_refs: Vec<&dyn IsMenuItem<R>> = party_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<R>)
        .collect();
    let launch = Submenu::with_items(
        app,
        "🎮 Запустить пати",
        !party_refs.is_empty(),
        &party_refs,
    )?;

    let favorite_items = favorites
        .iter()
        .take(MAX_FAVORITES)
        .filter_map(|value| value.split_once('\u{1f}'))
        .map(|(id, name)| {
            MenuItem::with_id(
                app,
                format!("{}{}", FAVORITE_PREFIX, id),
                format!("▶ {}", name),
                true,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<MenuItem<R>>>>()?;
    let favorite_refs: Vec<&dyn IsMenuItem<R>> = favorite_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<R>)
        .collect();
    let favorites_menu = Submenu::with_items(
        app,
        "⭐ Избранное",
        !favorite_refs.is_empty(),
        &favorite_refs,
    )?;

    let close_game = MenuItem::with_id(
        app,
        "close-game",
        "🛑 Закрыть все окна игры",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &show,
            &favorites_menu,
            &launch,
            &close_game,
            &scripts,
            &separator,
            &quit,
        ],
    )
}

pub fn setup(app: &App) -> tauri::Result<()> {
    let menu = build_menu(app, &[], &[])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Твиноферма")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            "close-game" => {
                // Окна закрываем сразу в Rust (интерфейс может быть свёрнут в трей); итог показывает интерфейс
                let handle = app.clone();
                std::thread::spawn(move || {
                    let report = crate::launcher::close_clients_now();
                    let _ = handle.emit_to("main", "game-closed", report);
                });
            }
            action => {
                // Промокод, передача предметов и активация подарков — это диалоги: показываем окно, чтобы их было видно
                if action == PROMO_ACTION || action == TRANSFER_ACTION || action == SHOP_ACTION {
                    show_main(app);
                }
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

/// Список пати для меню трея: интерфейс присылает названия пати, где есть кого запускать.
#[tauri::command]
pub fn set_tray_parties(
    app: AppHandle,
    names: Vec<String>,
    favorites: Vec<String>,
) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "Иконка в трее не создана".to_string())?;
    let menu = build_menu(&app, &names, &favorites).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())
}
