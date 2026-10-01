//! Баланс древних монет персонажа (chests2.php).

use crate::parsers::{eval_and_wait, navigate_clean};
use crate::pool;
use tauri::{command, AppHandle, Emitter};

const CHESTS_URL: &str = "https://pwonline.ru/chests2.php";
const SCRIPT: &str = include_str!("scripts/balance.js");

/// Результат: `{ charId, balance: number | null, error: null | "not_logged_in" | "timeout" | ... }`.
/// Дублируется событием `pw-balance-result-global`.
#[command]
pub async fn fetch_and_parse_balance_v4(
    app: AppHandle,
    char_id: String,
    timeout_seconds: Option<u64>,
    close_after: Option<bool>,
) -> Result<serde_json::Value, String> {
    let scope = format!("char:{}", char_id);
    let task = pool::acquire(&app, &char_id, CHESTS_URL).await?;
    navigate_clean(task.window(), CHESTS_URL).await?;

    let (balance, error) = match eval_and_wait(task.window(), SCRIPT, "#TF_BAL_V5_", timeout_seconds.unwrap_or(15), &scope).await {
        Some((None, data)) => match data.as_i64() {
            Some(v) if v >= 0 => (Some(v), None),
            _ => (None, Some("parse_nan".to_string())),
        },
        Some((Some(err), _)) => (None, Some(err)),
        None => (None, Some("timeout".to_string())),
    };
    task.finish(Some(&char_id), close_after.unwrap_or(true), error.is_none()).await;

    println!("[BALANCE] {} -> {:?} ({:?})", char_id, balance, error);
    let payload = serde_json::json!({ "charId": char_id, "balance": balance, "error": error });
    let _ = app.emit("pw-balance-result-global", payload.clone());
    Ok(payload)
}
