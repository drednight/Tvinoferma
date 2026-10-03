//! Окна браузера персонажей: видимые (ручной вход) и скрытые (фоновые скрипты).
//! У каждого персонажа свой профиль WebView (`pw-sync-profiles/<id>`), поэтому куки не смешиваются.
//! id персонажа строится из ника (`js/core/ids.js`): только `A-Za-z0-9_-`.

use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{command, AppHandle, Manager, Url, WebviewUrl, WebviewWindow};

const POPUP_PATCH: &str = include_str!("scripts/popup_patch.js");

pub fn window_label(key: &str) -> String {
    format!("sync-win-{}", key)
}

fn profiles_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pw-sync-profiles"))
}

fn profile_dir(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let dir = profiles_root(app)?.join(key);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;
    Ok(dir)
}

fn center_window(app: &AppHandle, win: &WebviewWindow, width: f64, height: f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let x = ((monitor.size().width as f64 - width) / 2.0) + 50.0;
        let y = (monitor.size().height as f64 - height) / 2.0;
        let _ = win.set_position(tauri::PhysicalPosition::new(
            (x * scale) as i32,
            (y * scale) as i32,
        ));
    }
}

/// Открывает ВИДИМОЕ окно браузера (для ручного входа/действия)
#[command]
pub async fn open_sync_window(
    app: AppHandle,
    char_id: String,
    url: String,
    char_nick: Option<String>,
    panel_script: Option<String>,
) -> Result<String, String> {
    let label = window_label(&char_id);
    let title = format!("PW Sync: {}", char_nick.as_deref().unwrap_or(&char_id));

    if let Some(win) = app.get_webview_window(&label) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        let _ = win.set_title(&title);
        // Панель «Помощник входа»: обновляем в уже открытом окне
        if let Some(script) = panel_script.as_deref() {
            let _ = win.eval(script);
        }
        return Ok(label);
    }

    let parsed_url = Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
            .title(title)
            .inner_size(1200.0, 800.0)
            .resizable(true)
            .data_directory(profile_dir(&app, &char_id)?);
    // Панель «Помощник входа» рисуется скриптом поверх страницы и переживает переходы
    if let Some(script) = panel_script.as_deref() {
        builder = builder.initialization_script(script);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
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

/// Переименовывает профили браузера после смены id персонажа (`{ старый: новый }`),
/// чтобы не терялся вход на сайт. Возвращает старые id, которые перенести не удалось
/// (окно персонажа открыто или папка с новым именем уже есть).
#[command]
pub fn rename_char_profiles(
    app: AppHandle,
    remap: HashMap<String, String>,
) -> Result<Vec<String>, String> {
    let root = profiles_root(&app)?;
    let mut failed = Vec::new();
    for (old_id, new_id) in remap {
        if old_id == new_id || !is_safe_key(&old_id) || !is_safe_key(&new_id) {
            continue;
        }
        // Сессия в банке кук привязана к id: переносим вместе с профилем
        crate::cookie_bank::rename(&app, &old_id, &new_id);
        if app.get_webview_window(&window_label(&old_id)).is_some() {
            failed.push(old_id);
            continue;
        }
        let from = root.join(&old_id);
        if !from.exists() {
            continue;
        }
        let to = root.join(&new_id);
        // Смена только регистра (bob → Bob): на Windows `to.exists()` уже true, переименовываем напрямую
        let case_only = old_id.eq_ignore_ascii_case(&new_id);
        if (to.exists() && !case_only) || std::fs::rename(&from, &to).is_err() {
            failed.push(old_id);
        }
    }
    Ok(failed)
}

/// id без разделителей пути (защита от `..` и `/` в имени папки).
fn is_safe_key(key: &str) -> bool {
    !key.is_empty() && key != "." && key != ".." && !key.contains(['/', '\\', ':'])
}

/// Проверяет существование окна по лейблу
#[command]
pub fn check_window_exists(app: AppHandle, label: String) -> bool {
    app.get_webview_window(&label).is_some()
}

/// Выполняет произвольный JS в окне персонажа (только `sync-win-*`, не в главном окне)
#[command]
pub async fn execute_script_in_window(
    app: AppHandle,
    label: String,
    script: String,
) -> Result<(), String> {
    if !label.starts_with("sync-win-") {
        return Err(format!("Window {} is not a sync window", label));
    }
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window {} not found", label))?;
    window.eval(&script).map_err(|e| e.to_string())
}

/// Возвращает окно `sync-win-{key}` (профиль персонажа), создавая СКРЫТОЕ при необходимости.
/// Второе значение = true, если окно создано сейчас (его можно уничтожить после работы).
pub async fn get_or_create_hidden_window(
    app: &AppHandle,
    key: &str,
    url: &str,
) -> Result<(WebviewWindow, bool), String> {
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
    let w = app
        .get_webview_window(&label)
        .ok_or("Window creation failed")?;
    Ok((w, true))
}

/// Окно для сканирования марафонов: профиль указанного (авторизованного) персонажа,
/// иначе любое открытое окно персонажа, иначе отдельный профиль сканера (без входа).
pub async fn pick_scan_window(
    app: &AppHandle,
    char_id: Option<String>,
    url: &str,
    fallback_key: &str,
) -> Result<(WebviewWindow, bool), String> {
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
