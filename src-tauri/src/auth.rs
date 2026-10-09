//! Проверка авторизации персонажа на pwonline.ru через скрытое окно его профиля.

use crate::parsers::{eval_and_wait, navigate_clean, tf_log};
use crate::windows::{dispose, get_or_create_hidden_window, window_is_open};
use tauri::{command, AppHandle, Emitter};

const USERCP_URL: &str = "https://pwonline.ru/usercp.php";
const SCRIPT: &str = include_str!("scripts/check_auth.js");

/// Результат: `{ charId, status: "online" | "offline" | "skipped", reason: null | "not_logged_in" | "timeout" | "window_open" | ... }`.
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
    // Окно, в котором работает пользователь, не трогаем: проверка переключила бы у него
    // страницу (и обрывала «Сохранить страницу»). Статус прежний — это «не проверяли», а не «нет входа».
    if window_is_open(&app, &char_id) {
        tf_log(&app, &scope, "warn", "окно занято, персонаж пропущен");
        let payload = serde_json::json!({
            "charId": char_id, "status": "skipped", "reason": "window_open", "skipped": true
        });
        let _ = app.emit("login-status-result-global", payload.clone());
        return Ok(payload);
    }
    // Замер по этапам: без него «проверка входа идёт 42 секунды» нечем превратить в правку.
    // Каждый этап — отдельная величина, из них складывается всё время проверки.
    let started = std::time::Instant::now();
    let (window, created_here) = get_or_create_hidden_window(&app, &char_id, USERCP_URL).await?;
    let after_window = started.elapsed().as_millis() as u64;
    // Переход возвращает своё время: ждём готовности страницы, а не слепую паузу
    let navigate_ms = navigate_clean(&window, USERCP_URL).await?;

    let (status, reason) =
        match eval_and_wait(&window, SCRIPT, "#TF_AUTH_V2_", timeout, &scope).await {
            Some((None, data)) if data.as_str() == Some("online") => ("online", None),
            Some((err, _)) => ("offline", Some(err.unwrap_or_else(|| "unknown".into()))),
            None => ("offline", Some("timeout".to_string())),
        };
    let after_parse = started.elapsed().as_millis() as u64;

    // Вход подтверждён: обновляем сессию в банке кук (сайт мог переиздать куки)
    if status == "online" {
        match crate::cookie_bank::save_from_window(&app, &char_id, &window).await {
            Ok(n) => tf_log(
                &app,
                &scope,
                "info",
                format!("Сессия сохранена в банк кук ({} шт.)", n),
            ),
            Err(e) => tf_log(&app, &scope, "warn", format!("Банк кук: {}", e)),
        }
    }
    let after_cookies = started.elapsed().as_millis() as u64;
    dispose(&window, created_here, close_after.unwrap_or(false));

    // Этапы считаются от начала проверки, но «переход» берём из navigate_clean: там своё
    // реальное время ожидания страницы, а не слепая пауза
    let after_navigate = after_window + navigate_ms;
    let timings = serde_json::json!({
        "totalMs": after_cookies,
        "windowMs": after_window,
        "navigateMs": navigate_ms,
        "parseMs": after_parse.saturating_sub(after_navigate),
        "cookiesMs": after_cookies.saturating_sub(after_parse),
        "windowCreated": created_here,
    });
    // Долгая проверка видна сразу: без этого эта цифра живёт только в консоли
    if after_cookies > 3_000 {
        tf_log(
            &app,
            &scope,
            "warn",
            format!(
                "Проверка заняла {} с (окно {} мс, переход {} мс, разбор {} мс, куки {} мс)",
                after_cookies / 1000,
                timings["windowMs"],
                timings["navigateMs"],
                timings["parseMs"],
                timings["cookiesMs"],
            ),
        );
    }
    println!(
        "[AUTH] {} -> {} ({:?}) {} мс [окно {} / переход {} / разбор {} / куки {}]",
        char_id,
        status,
        reason,
        after_cookies,
        after_window,
        navigate_ms,
        after_parse.saturating_sub(after_navigate),
        after_cookies - after_parse,
    );
    let payload = serde_json::json!({
        "charId": char_id, "status": status, "reason": reason, "timings": timings
    });
    let _ = app.emit("login-status-result-global", payload.clone());
    Ok(payload)
}
