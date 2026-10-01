//! Проверка авторизации персонажа на pwonline.ru через скрытое окно его профиля.

use crate::parsers::{eval_and_wait, navigate_clean, tf_log};
use crate::windows::{dispose, get_or_create_hidden_window};
use tauri::{command, AppHandle, Emitter};

const USERCP_URL: &str = "https://pwonline.ru/usercp.php";
const SCRIPT: &str = include_str!("scripts/check_auth.js");

/// Результат: `{ charId, status: "online" | "offline", reason: null | "not_logged_in" | "timeout" | ... }`.
/// Дублируется событием `login-status-result-global`.
#[command]
pub async fn check_login_status_http(
    app: AppHandle,
    char_id: String,
    timeout_seconds: Option<u64>,
    close_after: Option<bool>,
) -> Result<serde_json::Value, String> {
    let timeout = timeout_seconds.unwrap_or(5).max(2);
    let scope = format!("char:{}", char_id);
    let (window, created_here) = get_or_create_hidden_window(&app, &char_id, USERCP_URL).await?;
    navigate_clean(&window, USERCP_URL).await?;

    let (status, reason) = match eval_and_wait(&window, SCRIPT, "#TF_AUTH_V2_", timeout, &scope).await {
        Some((None, data)) if data.as_str() == Some("online") => ("online", None),
        Some((err, _)) => ("offline", Some(err.unwrap_or_else(|| "unknown".into()))),
        None => ("offline", Some("timeout".to_string())),
    };
    // Вход подтверждён: обновляем сессию в банке кук (сайт мог переиздать куки)
    if status == "online" {
        match crate::cookie_bank::save_from_window(&app, &char_id, &window).await {
            Ok(n) => tf_log(&app, &scope, "info", format!("Сессия сохранена в банк кук ({} шт.)", n)),
            Err(e) => tf_log(&app, &scope, "warn", format!("Банк кук: {}", e)),
        }
    }
    dispose(&window, created_here, close_after.unwrap_or(false));

    println!("[AUTH] {} -> {} ({:?})", char_id, status, reason);
    let payload = serde_json::json!({ "charId": char_id, "status": status, "reason": reason });
    let _ = app.emit("login-status-result-global", payload.clone());
    Ok(payload)
}
