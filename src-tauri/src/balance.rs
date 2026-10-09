//! Баланс древних монет персонажа (chests2.php).

use crate::parsers::{eval_and_wait, navigate_clean, tf_log};
use crate::pool;
use crate::windows::window_is_open;
use tauri::{command, AppHandle, Emitter};

const CHESTS_URL: &str = "https://pwonline.ru/chests2.php";
const SCRIPT: &str = include_str!("scripts/balance.js");

/// Результат: `{ charId, balance: number | null (может быть дробным, 1 знак), error: null | "not_logged_in" | "timeout" | ... }`.
/// Дублируется событием `pw-balance-result-global`.
#[command]
pub async fn fetch_and_parse_balance_v4(
    app: AppHandle,
    char_id: String,
    timeout_seconds: Option<u64>,
    close_after: Option<bool>,
) -> Result<serde_json::Value, String> {
    let scope = format!("char:{}", char_id);
    // Как и проверка входа: окно, в котором работает пользователь, не переключаем.
    if window_is_open(&app, &char_id) {
        tf_log(&app, &scope, "warn", "окно занято, персонаж пропущен");
        let payload = serde_json::json!({ "charId": char_id, "balance": null, "error": "window_open", "skipped": true });
        let _ = app.emit("pw-balance-result-global", payload.clone());
        return Ok(payload);
    }
    let task = pool::acquire(&app, &char_id, CHESTS_URL).await?;
    navigate_clean(task.window(), CHESTS_URL).await?;

    let (balance, error) = match eval_and_wait(
        task.window(),
        SCRIPT,
        "#TF_BAL_V5_",
        timeout_seconds.unwrap_or(15),
        &scope,
    )
    .await
    {
        Some((None, data)) => match normalize_balance(&data) {
            Some(v) => (Some(v), None),
            None => (None, Some("parse_nan".to_string())),
        },
        Some((Some(err), _)) => (None, Some(err)),
        None => (None, Some("timeout".to_string())),
    };
    task.finish(Some(&char_id), close_after.unwrap_or(true), error.is_none())
        .await;

    println!("[BALANCE] {} -> {:?} ({:?})", char_id, balance, error);
    let payload = serde_json::json!({ "charId": char_id, "balance": balance, "error": error });
    let _ = app.emit("pw-balance-result-global", payload.clone());
    Ok(payload)
}

/// Значение из скрипта страницы → баланс. Баланс бывает дробным (28,5), поэтому читаем как `f64`
/// (раньше `as_i64()` отбрасывал дробные числа) и храним с точностью до 0,1.
fn normalize_balance(data: &serde_json::Value) -> Option<f64> {
    match data.as_f64() {
        Some(v) if v.is_finite() && v >= 0.0 => Some((v * 10.0).round() / 10.0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_balance;
    use serde_json::json;

    #[test]
    fn fractional_balance_is_kept() {
        assert_eq!(normalize_balance(&json!(28.5)), Some(28.5));
        assert_eq!(normalize_balance(&json!(1285.5)), Some(1285.5));
        assert_eq!(normalize_balance(&json!(0.5)), Some(0.5));
    }

    #[test]
    fn integer_balance_is_kept() {
        assert_eq!(normalize_balance(&json!(285)), Some(285.0));
        assert_eq!(normalize_balance(&json!(0)), Some(0.0));
    }

    #[test]
    fn extra_digits_are_rounded_to_one_decimal() {
        assert_eq!(normalize_balance(&json!(28.4999999)), Some(28.5));
    }

    #[test]
    fn invalid_values_are_rejected() {
        assert_eq!(normalize_balance(&json!(null)), None);
        assert_eq!(normalize_balance(&json!("28,5")), None);
        assert_eq!(normalize_balance(&json!(-1)), None);
    }
}
