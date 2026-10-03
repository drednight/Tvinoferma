//! Окна браузера персонажей: видимые (ручной вход) и скрытые (фоновые скрипты).
//! У каждого персонажа свой профиль WebView (`pw-sync-profiles/<id>`), поэтому куки не смешиваются.
//! id персонажа строится из ника (`js/core/ids.js`): только `A-Za-z0-9_-`.

use std::collections::HashMap;
use std::path::PathBuf;
use tauri::webview::NewWindowResponse;
use tauri::{
    command, AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

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

/// Служебная схема панели «Помощник входа»: страница переходит на `tf-panel://<действие>`,
/// Rust отменяет переход и сообщает основному окну (Issue #54-2). Параметры не принимаются.
const PANEL_SCHEME: &str = "tf-panel";

/// Действие из адреса `tf-panel://<действие>`; список закрыт, остальное игнорируется.
fn parse_panel_action(url: &Url) -> Option<&'static str> {
    if url.scheme() != PANEL_SCHEME {
        return None;
    }
    match url.host_str()? {
        "balance" => Some("balance"),
        "parties" => Some("parties"),
        "promo" => Some("promo"),
        _ => None,
    }
}

/// Защита от всплывающих окон для окон персонажей. Попап (`window.open`, `target="_blank"`)
/// ломает вход через VK Play: сессия и `window.opener` остаются в другом окне.
/// 1) `popup_patch.js` вшит как initialization_script и срабатывает в каждом документе окна
///    (раньше он выполнялся один раз через `eval` и пропадал после первого перехода);
/// 2) обработчик нового окна переводит http(s)-запрос в это же окно, остальное запрещает;
/// 3) переход на `tf-panel://…` превращается в событие `panel-action` для основного окна.
///    Персонаж определяется по окну (`char_id`), а не по данным страницы.
fn guard_popups<'a, M: Manager<tauri::Wry>>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, M>,
    app: &AppHandle,
    label: &str,
    char_id: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, M> {
    let nav_app = app.clone();
    let char_id = char_id.to_string();
    let app = app.clone();
    let label = label.to_string();
    builder
        .initialization_script(POPUP_PATCH)
        .on_navigation(move |url| {
            if url.scheme() != PANEL_SCHEME {
                return true;
            }
            if let Some(action) = parse_panel_action(url) {
                let _ = nav_app.emit_to(
                    "main",
                    "panel-action",
                    serde_json::json!({ "charId": char_id, "action": action }),
                );
            }
            false
        })
        .on_new_window(move |url, _features| {
            // В лог попадает только адрес без параметров: в них бывают коды входа
            println!(
                "[WINDOW] {}: запрос нового окна -> {}{}",
                label,
                url.host_str().unwrap_or("?"),
                url.path()
            );
            if matches!(url.scheme(), "http" | "https") {
                if let Some(win) = app.get_webview_window(&label) {
                    tauri::async_runtime::spawn(async move {
                        let _ = win.navigate(url);
                    });
                }
            }
            NewWindowResponse::Deny
        })
}

/// Окно осталось на служебной странице прошлой задачи (`#TF_...`) или не на сайте.
fn is_stale_page(win: &WebviewWindow) -> bool {
    match win.url() {
        Ok(u) => {
            !matches!(u.scheme(), "http" | "https")
                || u.fragment().is_some_and(|f| f.starts_with("TF_"))
        }
        Err(_) => false,
    }
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

    let parsed_url = Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    if let Some(win) = app.get_webview_window(&label) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        let _ = win.set_title(&title);
        // Окно могло остаться от фоновой задачи: на служебной странице и без панели.
        // Открываем сайт заново, иначе пользователь видит пустую страницу вместо входа.
        let stale = is_stale_page(&win);
        if stale {
            win.navigate(parsed_url).map_err(|e| e.to_string())?;
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
        // Панель «Помощник входа»: в уже открытом окне она живёт до следующего перехода
        let _ = win.eval(POPUP_PATCH);
        if let Some(script) = panel_script.as_deref() {
            let _ = win.eval(script);
        }
        return Ok(label);
    }

    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .title(title)
        .inner_size(1200.0, 800.0)
        .resizable(true)
        .data_directory(profile_dir(&app, &char_id)?);
    let mut builder = guard_popups(builder, &app, &label, &char_id);
    // Панель «Помощник входа» рисуется скриптом поверх страницы и переживает переходы
    if let Some(script) = panel_script.as_deref() {
        builder = builder.initialization_script(script);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    center_window(&app, &win, 1200.0, 800.0);
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
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed_url))
        .title(format!("Hidden Sync: {}", key))
        .inner_size(1000.0, 700.0)
        .resizable(false)
        .visible(false)
        .data_directory(profile_dir(app, key)?);
    guard_popups(builder, app, &label, key)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn action(url: &str) -> Option<&'static str> {
        parse_panel_action(&Url::parse(url).unwrap())
    }

    #[test]
    fn panel_actions_from_closed_list() {
        assert_eq!(action("tf-panel://balance"), Some("balance"));
        assert_eq!(action("tf-panel://parties"), Some("parties"));
        assert_eq!(action("tf-panel://promo"), Some("promo"));
        assert_eq!(action("tf-panel://balance/"), Some("balance"));
    }

    #[test]
    fn unknown_actions_and_foreign_schemes_are_ignored() {
        assert_eq!(action("tf-panel://delete"), None);
        assert_eq!(action("tf-panel://"), None);
        assert_eq!(action("https://balance/"), None);
        assert_eq!(action("https://pwonline.ru/tf-panel://balance"), None);
    }
}
