//! Клановый сайт Eternals (pw-eternals.ru): отдельное окно браузера со своим профилем.
//!
//! Зачем отдельный модуль, а не `open_sync_window`: окно персонажа имеет метку `sync-win-<id>`,
//! и открыть в нём чужой сайт значит подменить окно pwonline.ru и сломать синхронизацию.
//!
//! Сводка профиля (события и пати) забирается командой `eternals_sync`. Если окна клана нет,
//! она открывает СКРЫТОЕ окно с тем же профилем: вход сохраняется в профиле, поэтому после
//! первого входа обновление работает без открытия сайта. Если сессия истекла, команда
//! возвращает ошибку `login`.
//!
//! Отметка на ивенте уходит тем же запросом, что и форма сайта (`handlers/event_response.php`),
//! ответ возвращается в hash (`#TFETA1_`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::webview::NewWindowResponse;
use tauri::{command, AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const ETERNALS_LABEL: &str = "eternals-win";
const ETERNALS_URL: &str = "https://pw-eternals.ru/index.php";
/// Скрипт окна: панель навигации, разбор профиля и отметка на ивенте. Во всех страницах окна.
const ETERNALS_SCRIPT: &str = include_str!("scripts/eternals.js");
/// Начало hash со сводкой профиля (или признаком «нужен вход»).
const REPORT_HASH: &str = "#TFETE1_";
/// Начало hash с результатом отметки на ивенте.
const ACTION_HASH: &str = "#TFETA1_";
/// Сколько ждём страницу профиля при обновлении, секунд.
const SYNC_TIMEOUT_SECS: u64 = 25;
/// Сколько ждём ответ сайта на отметку, секунд.
const RESPOND_TIMEOUT_SECS: u64 = 20;

/// Идёт ли обновление: два запуска одновременно (кнопка и суточная проверка) не нужны.
static SYNC_BUSY: AtomicBool = AtomicBool::new(false);

/// Каталог профилей клана — отдельный от профилей персонажей (`pw-sync-profiles`).
fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pw-eternals-profiles")
        .join("clan");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;
    Ok(dir)
}

fn clan_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(ETERNALS_LABEL)
}

/// Создаёт окно клана. `visible = false` — скрытое окно для фонового обновления.
///
/// Создаётся только из `async` команд: на Windows создание окна из синхронной команды приводит
/// к взаимной блокировке, и `invoke` тогда не возвращается.
fn create_clan_window(app: &AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    let url = Url::parse(ETERNALS_URL).map_err(|e| e.to_string())?;
    let handle = app.clone();
    WebviewWindowBuilder::new(app, ETERNALS_LABEL, WebviewUrl::External(url))
        .title("Eternals Clan")
        .inner_size(1100.0, 800.0)
        .resizable(true)
        .visible(visible)
        .data_directory(profile_dir(app)?)
        .initialization_script(ETERNALS_SCRIPT)
        .on_new_window(move |url, _features| {
            // Ссылки, которые сайт открывает в новом окне, показываем в этом же окне
            if matches!(url.scheme(), "http" | "https") {
                if let Some(win) = handle.get_webview_window(ETERNALS_LABEL) {
                    tauri::async_runtime::spawn(async move {
                        let _ = win.navigate(url);
                    });
                }
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())
}

/// Открывает окно клана или поднимает уже открытое.
#[command]
pub async fn open_eternals_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = clan_window(&app) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    create_clan_window(&app, true).map(|_| ())
}

/// Закрывает окно клана.
#[command]
pub async fn close_eternals_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = clan_window(&app) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Открыто ли окно клана (видимое или скрытое).
#[command]
pub fn eternals_window_exists(app: AppHandle) -> bool {
    clan_window(&app).is_some()
}

/// Обновляет сводку клана: события и пати.
///
/// Работает и без открытого окна: если его нет, открывает скрытое окно с сохранённым профилем
/// и закрывает его после ответа. Возвращает `{ events, parties }` или ошибку:
/// - `login` — сессия на сайте истекла, нужно войти через «Открыть сайт клана»;
/// - `timeout` — страница профиля не открылась за отведённое время;
/// - `busy` — обновление уже идёт.
#[command]
pub async fn eternals_sync(app: AppHandle) -> Result<serde_json::Value, String> {
    if SYNC_BUSY.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let result = run_sync(&app).await;
    SYNC_BUSY.store(false, Ordering::SeqCst);
    result
}

async fn run_sync(app: &AppHandle) -> Result<serde_json::Value, String> {
    let (win, created) = match clan_window(app) {
        Some(win) => (win, false),
        None => (create_clan_window(app, false)?, true),
    };
    let result = wait_for_report(&win).await;
    // Скрытое окно создали ради обновления — после ответа убираем его, видимое не трогаем
    if created {
        let _ = win.destroy();
    }
    result
}

/// Ждёт payload в hash окна. `read_hash_payload` отдаёт `(ошибка, данные)`: ошибка `login`
/// значит, что страница входа, ждать дальше бессмысленно.
async fn wait_for_hash(
    win: &WebviewWindow,
    prefix: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let Ok(url) = win.url() else { continue };
        match crate::parsers::read_hash_payload(url.as_str(), prefix) {
            Some((Some(error), _)) => return Err(error),
            Some((None, data)) => return Ok(data),
            None => {}
        }
    }
    Err("timeout".into())
}

/// Сбрасывает старый hash и просит скрипт разобрать страницу заново, затем ждёт сводку профиля.
/// Иначе прочитали бы прошлую сводку.
async fn wait_for_report(win: &WebviewWindow) -> Result<serde_json::Value, String> {
    let _ = win.eval(
        "history.replaceState(null, '', location.pathname + location.search);\
         if (window.__tfEternalsScrape) window.__tfEternalsScrape();",
    );
    wait_for_hash(win, REPORT_HASH, Duration::from_secs(SYNC_TIMEOUT_SECS)).await
}

/// Отмечает ивент на сайте (`yes` — «Пойду», `no` — «Не пойду»).
///
/// Работает и без открытого окна: если его нет, поднимается скрытое окно с сохранённым
/// профилем и закрывается после ответа. Значения проверяются здесь: в окно уходит только
/// число и одно из двух слов.
///
/// Возвращает `{ ok, eventId, response, message }` — ответ сайта. Ошибки приходят строкой:
/// `login`, `timeout`, `busy`.
#[command]
pub async fn eternals_set_response(
    app: AppHandle,
    event_id: String,
    response: String,
) -> Result<serde_json::Value, String> {
    if event_id.is_empty() || event_id.len() > 12 || !event_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Некорректный номер события".into());
    }
    if response != "yes" && response != "no" {
        return Err("Некорректный ответ".into());
    }
    if SYNC_BUSY.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let result = run_respond(&app, &event_id, &response).await;
    SYNC_BUSY.store(false, Ordering::SeqCst);
    result
}

async fn run_respond(app: &AppHandle, event_id: &str, response: &str) -> Result<serde_json::Value, String> {
    match clan_window(app) {
        Some(win) => send_response(&win, event_id, response, false).await,
        None => {
            let win = create_clan_window(app, false)?;
            let result = send_response(&win, event_id, response, true).await;
            let _ = win.destroy();
            result
        }
    }
}

async fn send_response(
    win: &WebviewWindow,
    event_id: &str,
    response: &str,
    fresh_window: bool,
) -> Result<serde_json::Value, String> {
    if fresh_window {
        // Окно только что создано: скрипт ещё не успел встать. Ждём разбор страницы —
        // заодно убеждаемся, что вход на сайте живой (на странице входа придёт `login`).
        wait_for_report(win).await?;
    }
    // Старый ответ мог остаться в hash от прошлой отметки — иначе прочитаем его.
    let _ = win.eval(
        "if (location.hash.indexOf('#TFETA1_') === 0) history.replaceState(null, '', location.pathname + location.search);",
    );
    win.eval(&format!(
        "if (window.__tfEternalsRespond) window.__tfEternalsRespond({}, {});",
        event_id,
        serde_json::Value::String(response.to_string())
    ))
    .map_err(|e| e.to_string())?;
    wait_for_hash(win, ACTION_HASH, Duration::from_secs(RESPOND_TIMEOUT_SECS)).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn hash_prefixes_do_not_clash_with_collection_or_sync_hashes() {
        // Разные префиксы: окно клана не должно принять чужой hash за свой и наоборот
        assert_ne!(super::REPORT_HASH, super::ACTION_HASH);
        assert!(!super::REPORT_HASH.starts_with("#TF_"));
        assert!(!super::ACTION_HASH.starts_with("#TF_"));
        assert!(!super::REPORT_HASH.starts_with("#TFCOL"));
    }
}
