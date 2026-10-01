//! Окна браузера персонажей: видимые (ручной вход) и скрытые (фоновые скрипты).
//! У каждого персонажа свой профиль WebView (`pw-sync-profiles/<id>`), поэтому куки не смешиваются.

use std::path::PathBuf;
use tauri::{command, AppHandle, Manager, Url, WebviewUrl, WebviewWindow};

const POPUP_PATCH: &str = include_str!("scripts/popup_patch.js");

pub fn window_label(key: &str) -> String {
    format!("sync-win-{}", key)
}

fn profile_dir(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pw-sync-profiles")
        .join(key);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;
    Ok(dir)
}

fn center_window(app: &AppHandle, win: &WebviewWindow, width: f64, height: f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let x = ((monitor.size().width as f64 - width) / 2.0) + 50.0;
        let y = (monitor.size().height as f64 - height) / 2.0;
        let _ = win.set_position(tauri::PhysicalPosition::new((x * scale) as i32, (y * scale) as i32));
    }
}

/// Открывает ВИДИМОЕ окно браузера (для ручного входа/действия)
#[command]
pub async fn open_sync_window(
    app: AppHandle,
    char_id: String,
    url: String,
    char_nick: Option<String>,
) -> Result<String, String> {
    let label = window_label(&char_id);
    let title = format!("PW Sync: {}", char_nick.as_deref().unwrap_or(&char_id));

    if let Some(win) = app.get_webview_window(&label) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        let _ = win.set_title(&title);
        return Ok(label);
    }

    let parsed_url = Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    let win = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .title(title)
        .inner_size(1200.0, 800.0)
        .resizable(true)
        .data_directory(profile_dir(&app, &char_id)?)
        .build()
        .map_err(|e| e.to_string())?;
    center_window(&app, &win, 1200.0, 800.0);

    // Патч против попапов
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    win.eval(POPUP_PATCH).ok();
    Ok(label)
}

/// Закрывает окно браузера по ID персонажа (вместе с его попапами)
#[command]
pub async fn close_sync_window(app: AppHandle, char_id: String) -> Result<(), String> {
    let base_label = window_label(&char_id);
    if let Some(win) = app.get_webview_window(&base_label) {
        win.close().map_err(|e| e.to_string())?;
    }
    let popup_prefix = format!("popup-{}", base_label);
    for (_, window) in app.webview_windows() {
        if window.label().starts_with(&popup_prefix) {
            let _ = window.close();
        }
    }
    Ok(())
}

/// Проверяет существование окна по лейблу
#[command]
pub fn check_window_exists(app: AppHandle, label: String) -> bool {
    app.get_webview_window(&label).is_some()
}

/// Выполняет произвольный JS в окне персонажа (только `sync-win-*`, не в главном окне)
#[command]
pub async fn execute_script_in_window(app: AppHandle, label: String, script: String) -> Result<(), String> {
    if !label.starts_with("sync-win-") {
        return Err(format!("Window {} is not a sync window", label));
    }
    let window = app.get_webview_window(&label).ok_or_else(|| format!("Window {} not found", label))?;
    window.eval(&script).map_err(|e| e.to_string())
}

/// Возвращает окно `sync-win-{key}` (профиль персонажа), создавая СКРЫТОЕ при необходимости.
/// Второе значение = true, если окно создано сейчас (его можно уничтожить после работы).
pub async fn get_or_create_hidden_window(app: &AppHandle, key: &str, url: &str) -> Result<(WebviewWindow, bool), String> {
    let label = window_label(key);
    if let Some(w) = app.get_webview_window(&label) {
        return Ok((w, false));
    }
    let parsed_url = Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed_url))
        .title(format!("Hidden Sync: {}", key))
        .inner_size(1000.0, 700.0)
        .resizable(false)
        .visible(false)
        .data_directory(profile_dir(app, key)?)
        .build()
        .map_err(|e| e.to_string())?;

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let w = app.get_webview_window(&label).ok_or("Window creation failed")?;
    Ok((w, true))
}

/// Окно для сканирования марафонов: профиль указанного (авторизованного) персонажа,
/// иначе любое открытое окно персонажа, иначе отдельный профиль сканера (без входа).
pub async fn pick_scan_window(app: &AppHandle, char_id: Option<String>, url: &str, fallback_key: &str) -> Result<(WebviewWindow, bool), String> {
    if let Some(id) = char_id.filter(|s| !s.is_empty()) {
        return get_or_create_hidden_window(app, &id, url).await;
    }
    for (_, window) in app.webview_windows() {
        if window.label().starts_with("sync-win-") {
            return Ok((window, false));
        }
    }
    get_or_create_hidden_window(app, fallback_key, url).await
}

/// Закрывает служебное окно, если оно было создано для задачи.
/// destroy() вместо close(): не генерирует CloseRequested, чтобы фронтенд
/// не принял закрытие служебного окна за выход пользователя.
pub fn dispose(window: &WebviewWindow, created_here: bool, close_after: bool) {
    if created_here && close_after {
        let _ = window.destroy();
    }
}
