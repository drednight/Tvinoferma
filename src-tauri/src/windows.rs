//! Окна браузера персонажей: видимые (ручной вход) и скрытые (фоновые скрипты).
//! У каждого персонажа свой профиль WebView (`pw-sync-profiles/<id>`), поэтому куки не смешиваются.
//! id персонажа строится из ника (`js/core/ids.js`): только `A-Za-z0-9_-`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::webview::NewWindowResponse;
use tauri::{
    command, AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const POPUP_PATCH: &str = include_str!("scripts/popup_patch.js");
static NEXT_POPUP_ID: AtomicU64 = AtomicU64::new(1);
/// Снимает клиентский лимит сайта «не более 6 предметов» на странице передачи предметов (только видимые окна).
const PROMO_ITEMS_UNLIMITED: &str = include_str!("scripts/promo_items_unlimited.js");
/// Панель «Коллекция» на странице мини-игры (Issue #72, только видимые окна): запуск только по кнопке пользователя.
const COLLECTION_PANEL: &str = include_str!("scripts/collection.js");

/// Настройки видимых окон браузера (из «Настроек» приложения).
pub struct BrowserSettings {
    pub unlimited_items: AtomicBool,
    pub collection_panel: AtomicBool,
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            unlimited_items: AtomicBool::new(true),
            collection_panel: AtomicBool::new(true),
        }
    }
}

fn unlimited_items_enabled(app: &AppHandle) -> bool {
    app.try_state::<BrowserSettings>()
        .map(|s| s.unlimited_items.load(Ordering::Relaxed))
        .unwrap_or(true)
}

/// «Снять лимит 6 предметов» в видимых окнах: действует на окна, открытые после изменения.
#[command]
pub fn set_unlimited_items(settings: State<'_, BrowserSettings>, enabled: bool) {
    settings.unlimited_items.store(enabled, Ordering::Relaxed);
}

fn collection_panel_enabled(app: &AppHandle) -> bool {
    app.try_state::<BrowserSettings>()
        .map(|s| s.collection_panel.load(Ordering::Relaxed))
        .unwrap_or(true)
}

/// «Панель Коллекции» в видимых окнах: действует на окна, открытые после изменения.
#[command]
pub fn set_collection_panel(settings: State<'_, BrowserSettings>, enabled: bool) {
    settings.collection_panel.store(enabled, Ordering::Relaxed);
}

/// Начало hash с отчётами панели «Коллекция». Не «TF_»: иначе `is_stale_page` сочтёт окно служебной страницей.
const COLLECTION_HASH: &str = "#TFCOL1_";

/// Отчёты панели из адреса окна `#TFCOL1_<encodeURIComponent({"data":{"reports":[..]},"error":null})>`.
/// К каждому отчёту добавляется `char` — id персонажа из метки окна. Больше 5 отчётов за раз не берём.
fn collection_reports_from_url(url: &str, char_id: &str) -> Vec<serde_json::Value> {
    let Some((None, data)) = crate::parsers::read_hash_payload(url, COLLECTION_HASH) else {
        return Vec::new();
    };
    let Some(list) = data.get("reports").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .take(5)
        .filter_map(|r| {
            let mut obj = r.as_object()?.clone();
            obj.insert(
                "char".into(),
                serde_json::Value::String(char_id.to_string()),
            );
            Some(serde_json::Value::Object(obj))
        })
        .collect()
}

/// Забирает отчёты панели «Коллекция» из видимых окон персонажей и убирает hash — для окна это «принято».
/// Только читает адрес окон приложения; ничего не открывает и не нажимает на сайте.
#[command]
pub fn take_collection_reports(app: AppHandle) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for (label, win) in app.webview_windows() {
        let Some(char_id) = label.strip_prefix("sync-win-") else {
            continue;
        };
        let Ok(url) = win.url() else { continue };
        if !url.fragment().is_some_and(|f| f.starts_with("TFCOL1_")) {
            continue;
        }
        out.extend(collection_reports_from_url(url.as_str(), char_id));
        let _ = win.eval(
            "if (location.hash.indexOf('#TFCOL1_') === 0) history.replaceState(null, '', location.pathname + location.search);",
        );
    }
    out
}

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

/// Обычные всплывающие ссылки открываются в том же окне, OAuth-попапы сохраняются:
/// VK ID использует `window.opener` для возврата с `oauth2.htm`.
fn guard_popups<'a, M: Manager<tauri::Wry>>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, M>,
    app: &AppHandle,
    label: &str,
    profile_key: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, M> {
    let unlimited = unlimited_items_enabled(app);
    let collection = collection_panel_enabled(app);
    let app = app.clone();
    let label = label.to_string();
    let profile_key = profile_key.to_string();
    let mut builder = builder.initialization_script(POPUP_PATCH);
    if unlimited {
        builder = builder.initialization_script(PROMO_ITEMS_UNLIMITED);
    }
    if collection {
        builder = builder.initialization_script(COLLECTION_PANEL);
    }
    builder.on_new_window(move |url, features| {
        // В лог попадает только адрес без параметров: в них бывают коды входа
        println!(
            "[WINDOW] {}: запрос нового окна -> {}{}",
            label,
            url.host_str().unwrap_or("?"),
            url.path()
        );
        if is_oauth_popup_url(&url) {
            let popup_label = format!(
                "popup-{}-{}",
                label,
                NEXT_POPUP_ID.fetch_add(1, Ordering::Relaxed)
            );
            let data_dir = match profile_dir(&app, &profile_key) {
                Ok(dir) => dir,
                Err(error) => {
                    eprintln!(
                        "[WINDOW] {}: не удалось подготовить OAuth-профиль: {}",
                        label, error
                    );
                    return NewWindowResponse::Deny;
                }
            };
            let mut popup_builder =
                WebviewWindowBuilder::new(&app, &popup_label, WebviewUrl::External(url.clone()))
                    .title("Авторизация")
                    .inner_size(1000.0, 750.0)
                    .window_features(features)
                    .data_directory(data_dir);
            popup_builder = guard_popups(popup_builder, &app, &label, &profile_key);
            return match popup_builder.build() {
                Ok(window) => {
                    // Окно авторизации создаётся из обработчика нового окна, поэтому Windows
                    // оставляет на переднем плане родительское окно, а попап уходит за него —
                    // пользователь его не видит и не понимает, что нужно ввести пароль.
                    // Поэтому поднимаем попап поверх и отдаём ему фокус. «Всегда сверху» ставим
                    // только на пару секунд: постоянное TOPMOST мешало бы переключаться на игру.
                    raise_above_parent(&app, &window, &label);
                    NewWindowResponse::Create { window }
                }
                Err(error) => {
                    eprintln!(
                        "[WINDOW] {}: не удалось открыть OAuth-окно: {}",
                        label, error
                    );
                    NewWindowResponse::Deny
                }
            };
        }
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

fn is_oauth_popup_url(url: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let host = url.host_str().unwrap_or_default();
    ["vk.com", "vk.ru", "vkplay.ru", "pwonline.ru"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
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

fn center_window(app: &AppHandle, win: &WebviewWindow) -> Result<(), String> {
    let (anchor_position, anchor_size) = if let Some(main) = app.get_webview_window("main") {
        (
            main.inner_position().map_err(|e| e.to_string())?,
            main.inner_size().map_err(|e| e.to_string())?,
        )
    } else if let Some(monitor) = app.primary_monitor().map_err(|e| e.to_string())? {
        (*monitor.position(), *monitor.size())
    } else {
        return Err("No application window or monitor available for centering".into());
    };
    let window_size = win.outer_size().map_err(|e| e.to_string())?;
    let position = centered_position(anchor_position, anchor_size, window_size);
    win.set_position(position).map_err(|e| e.to_string())
}

fn centered_position(
    anchor_position: tauri::PhysicalPosition<i32>,
    anchor_size: tauri::PhysicalSize<u32>,
    window_size: tauri::PhysicalSize<u32>,
) -> tauri::PhysicalPosition<i32> {
    tauri::PhysicalPosition::new(
        anchor_position.x + (anchor_size.width as i32 - window_size.width as i32) / 2,
        anchor_position.y + (anchor_size.height as i32 - window_size.height as i32) / 2,
    )
}

/// Сколько окно авторизации остаётся «поверх всего», мс.
const POPUP_TOP_FOR: std::time::Duration = std::time::Duration::from_secs(3);

/// Поднимает окно поверх родительского и отдаёт ему фокус.
///
/// Зачем: окно авторизации (OAuth) создаётся из обработчика «страница открыла новое окно».
/// Windows при этом оставляет на переднем плане родительское окно, и попап оказывается под ним —
/// пользователь не видит окно входа (жалобы пользователей). Здесь окно показывается,
/// ставится по центру родителя и забирает фокус.
///
/// Постоянный «всегда сверху» не ставим: из-за него нельзя было бы уйти в окно игры поверх
/// этого окна. Флаг держится `POPUP_TOP_FOR`, затем снимается — этого хватает, чтобы окно
/// оказалось перед родительским и получило фокус.
fn raise_above_parent(app: &AppHandle, popup: &WebviewWindow, parent_label: &str) {
    let _ = popup.show();
    // Сайт может прислать в `window.open` свои координаты — показываем окно по центру родителя
    if let Some(parent) = app.get_webview_window(parent_label) {
        if let (Ok(pos), Ok(size)) = (parent.inner_position(), parent.inner_size()) {
            if let Ok(own) = popup.outer_size() {
                let _ = popup.set_position(centered_position(pos, size, own));
            }
        }
    }
    let _ = popup.set_always_on_top(true);
    let _ = popup.set_focus();

    let handle = app.clone();
    let label = popup.label().to_string();
    std::thread::spawn(move || {
        std::thread::sleep(POPUP_TOP_FOR);
        // Окно могли закрыть раньше — тогда снимать флаг уже не у чего
        if let Some(win) = handle.get_webview_window(&label) {
            let _ = win.set_always_on_top(false);
        }
    });
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
        if unlimited_items_enabled(&app) {
            let _ = win.eval(PROMO_ITEMS_UNLIMITED);
        }
        if collection_panel_enabled(&app) {
            let _ = win.eval(COLLECTION_PANEL);
        }
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
    if let Err(error) = center_window(&app, &win) {
        let _ = win.destroy();
        return Err(error);
    }
    Ok(label)
}

/// Закрывает все окна-всплывашки окна `base_label` (OAuth-попапы авторизации).
///
/// Вызывается и явной командой, и при закрытии самого окна персонажа: иначе попап остаётся
/// жить отдельно, а в нём `window.opener` уже не работает — страница возврата виснет белой.
pub fn close_popups_of(app: &AppHandle, base_label: &str) {
    let popup_prefix = format!("popup-{}", base_label);
    for (_, window) in app.webview_windows() {
        if window.label().starts_with(&popup_prefix) {
            let _ = window.close();
        }
    }
}

/// Закрывает окно браузера по ID персонажа (вместе с его попапами)
#[command]
pub async fn close_sync_window(app: AppHandle, char_id: String) -> Result<(), String> {
    let base_label = window_label(&char_id);
    close_popups_of(&app, &base_label);
    if let Some(win) = app.get_webview_window(&base_label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Закрывает только окна авторизации персонажа, не трогая основное окно.
///
/// Нужно, когда вход уже подтверждён, а окно OAuth осталось висеть: после успешной авторизации
/// страница возврата отдаёт результат в `window.opener`, но само окно закрывается не всегда
/// (например, если родительское окно перезагрузилось) — и пользователь видит белую страницу.
/// Закрываем такое окно сразу, как только вход подтвердился. Возвращает, сколько окон закрыто.
#[command]
pub fn close_auth_popups(app: AppHandle, char_id: String) -> usize {
    let base_label = window_label(&char_id);
    let prefix = format!("popup-{}", base_label);
    let mut closed = 0;
    for (_, window) in app.webview_windows() {
        if window.label().starts_with(&prefix) && window.close().is_ok() {
            closed += 1;
        }
    }
    closed
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
    use super::{centered_position, collection_reports_from_url, is_oauth_popup_url};
    use tauri::Url;

    #[test]
    fn allows_vk_id_and_oauth_callback_popup_hosts() {
        for url in [
            "https://id.vk.ru/auth",
            "https://id.vk.com/auth",
            "https://oauth.vk.ru/oauth2.htm",
            "https://account.vkplay.ru/login",
            "https://pwonline.ru/oauth2.htm",
            "about:blank",
        ] {
            assert!(is_oauth_popup_url(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn rejects_unrelated_popup_hosts_and_schemes() {
        for url in [
            "https://vk.ru.example.com/",
            "https://example.com/oauth2.htm",
            "file:///tmp/oauth2.htm",
        ] {
            assert!(!is_oauth_popup_url(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn centers_browser_window_on_application_content_without_offset() {
        let position = centered_position(
            tauri::PhysicalPosition::new(200, 100),
            tauri::PhysicalSize::new(1400, 900),
            tauri::PhysicalSize::new(1200, 800),
        );

        assert_eq!(position, tauri::PhysicalPosition::new(300, 150));
    }

    #[test]
    fn reads_collection_reports_and_adds_character_id() {
        let json =
            r#"{"data":{"reports":[{"id":"a1","opened":9},{"id":"b2","opened":3}]},"error":null}"#;
        let url = format!(
            "https://pwonline.ru/minigames.php?game=collection&doo=display#TFCOL1_{}",
            urlencoding::encode(json)
        );
        let reports = collection_reports_from_url(&url, "Temnyy_Mag");
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0]["id"], "a1");
        assert_eq!(reports[1]["opened"], 3);
        assert_eq!(reports[0]["char"], "Temnyy_Mag");
    }

    #[test]
    fn ignores_foreign_broken_and_oversized_collection_hashes() {
        let page = "https://pwonline.ru/minigames.php?game=collection&doo=display";
        assert!(collection_reports_from_url(page, "x").is_empty());
        assert!(collection_reports_from_url(&format!("{page}#TF_BAL_V5_%7B%7D"), "x").is_empty());
        assert!(collection_reports_from_url(&format!("{page}#TFCOL1_%7Bbroken"), "x").is_empty());
        let many: Vec<String> = (0..8).map(|i| format!("{{\"id\":\"r{i}\"}}")).collect();
        let json = format!(
            "{{\"data\":{{\"reports\":[{}]}},\"error\":null}}",
            many.join(",")
        );
        let url = format!("{page}#TFCOL1_{}", urlencoding::encode(&json));
        assert_eq!(collection_reports_from_url(&url, "x").len(), 5);
        // отчёт с ошибкой не принимается
        let err = format!(
            "{page}#TFCOL1_{}",
            urlencoding::encode(r#"{"data":null,"error":"x"}"#)
        );
        assert!(collection_reports_from_url(&err, "x").is_empty());
    }
}
