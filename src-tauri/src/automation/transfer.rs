//! Передача предметов с сайта в игру (Issue #26): страница `/promo_items.php` в окне профиля персонажа.
//! Скрипт страницы: `scripts/transfer.js` (режимы `scan`, `fill`, `click`, `result`).
//!
//! Правила безопасности (см. `docs/COMPLIANCE.md`):
//! - обе команды запускаются только кнопкой пользователя из диалога; расписаний нет;
//! - `read_transfer_page` только читает страницу (что ждёт передачи, какие серверы и персонажи есть);
//! - `transfer_items` сначала только выбирает сервер, персонажа и предметы в списках сайта (`fill`), и лишь затем
//!   нажимает «Передать» ОДИН раз, без повторов: `clicked = true` означает «заново запускать нельзя»;
//! - режим `dry_run` доходит до выбора и ничего не нажимает;
//! - ответ сайта читается со страницы «История передачи»: решение «успех или нет» принимает приложение,
//!   сверяя историю с отправленным, поэтому неясный ответ никогда не считается успехом.

use super::promo::is_valid_char_id;
use crate::parsers::{eval_and_wait, navigate_clean, read_hash_payload, tf_log, with_common};
use crate::pool;
use crate::windows::window_label;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{command, AppHandle, Manager};

const SCRIPT: &str = include_str!("../scripts/transfer.js");
const PAGE_URL: &str = "https://pwonline.ru/promo_items.php";
const PREFIX: &str = "#TF_XFER_V1_";
const CLEAR_HASH: &str = "history.replaceState(null, '', location.pathname + location.search);";

/// Идентификатор сервера из списка сайта: только цифры.
pub fn is_valid_shard(shard: &str) -> bool {
    !shard.is_empty() && shard.len() <= 8 && shard.chars().all(|c| c.is_ascii_digit())
}

/// Получатель — значение из списка сайта: `<игровой аккаунт>_<сервер>_<персонаж>`, три числа через `_`.
pub fn is_valid_recipient(value: &str) -> bool {
    let parts: Vec<&str> = value.split('_').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 14 && p.chars().all(|c| c.is_ascii_digit()))
}

/// Сервер внутри значения получателя должен совпадать с выбранным сервером.
pub fn recipient_matches_shard(recipient: &str, shard: &str) -> bool {
    recipient.split('_').nth(1) == Some(shard)
}

/// Ник для сверки: без управляющих символов и не длиннее 60 знаков.
fn clean_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect::<String>()
        .trim()
        .to_string()
}

type Wait = Option<(Option<String>, Value)>;

/// Скрипт страницы для одного режима: `window.__TF_XFER = {...}` + `transfer.js`.
fn xfer_script(cfg: &Value) -> String {
    format!("window.__TF_XFER = {};\n{}", cfg, SCRIPT)
}

fn timeout_error() -> (&'static str, String) {
    ("error", "timeout".to_string())
}

/// Итог чтения страницы: данные страницы или конечный `(status, error)`.
fn classify_scan(res: Wait) -> Result<Value, (&'static str, String)> {
    match res {
        None => Err(timeout_error()),
        Some((None, data)) if data["state"] == "scan" => Ok(data),
        Some((None, _)) => Err(("error", "bad_response".to_string())),
        Some((Some(err), _)) => Err(match err.as_str() {
            "not_logged_in" => ("not_logged_in", err),
            "challenge" => ("challenge", err),
            // страница загрузилась, но нужных элементов на ней нет
            "pending" => ("error", "form_not_found".to_string()),
            _ => ("error", err),
        }),
    }
}

/// Выбор сделан: сколько предметов отмечено, что именно и отпечаток страницы.
#[derive(Debug, PartialEq)]
struct Filled {
    count: u64,
    items: Value,
}

fn classify_fill(res: Wait) -> Result<Filled, (&'static str, String)> {
    match res {
        None => Err(timeout_error()),
        Some((None, data))
            if data["state"] == "ready" && data["count"].as_u64().unwrap_or(0) > 0 =>
        {
            Ok(Filled {
                count: data["count"].as_u64().unwrap_or(0),
                items: data["items"].clone(),
            })
        }
        Some((None, _)) => Err(("error", "bad_response".to_string())),
        Some((Some(err), _)) => Err(match err.as_str() {
            "not_logged_in" => ("not_logged_in", err),
            "challenge" => ("challenge", err),
            // передавать нечего: ничего не нажато
            "no_items" => ("nothing", err),
            "pending" => ("error", "form_not_found".to_string()),
            // «server_not_found», «char_not_found», «char_mismatch»: списки сайта не совпали с сохранёнными
            // (сервер или персонаж изменились) — остаются как есть, ничего не отмечено и не нажато
            _ => ("error", err),
        }),
    }
}

/// Итог после нажатия. Любая неясность — `unknown`, а не успех.
struct Outcome {
    status: &'static str,
    error: Option<String>,
    detail: Option<String>,
    /// Строки самой новой передачи из «Истории передачи» (только для `submitted`).
    history: Value,
}

impl Outcome {
    fn unknown(error: Option<String>, detail: Option<String>) -> Self {
        Outcome {
            status: "unknown",
            error,
            detail,
            history: Value::Null,
        }
    }
}

fn classify_result(res: Wait) -> Outcome {
    let text = |v: &Value| v.as_str().map(|s| s.to_string());
    match res {
        None => Outcome::unknown(Some("timeout".to_string()), None),
        Some((None, data)) if data["state"] == "history" && data["rows"].is_array() => Outcome {
            status: "submitted",
            error: None,
            detail: None,
            history: data["rows"].clone(),
        },
        Some((None, _)) => Outcome::unknown(Some("bad_response".to_string()), None),
        // «нет входа» после нажатия не говорит, ушла ли передача: проверять историю вручную
        Some((Some(err), data)) => Outcome::unknown(
            (err != "unknown").then(|| err.clone()),
            text(&data).filter(|_| err == "unknown"),
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn payload(
    char_id: &str,
    status: &str,
    error: Option<&str>,
    detail: Option<&str>,
    clicked: bool,
    dry_run: bool,
    count: u64,
    items: Value,
) -> Value {
    json!({
        "charId": char_id,
        "status": status,
        "error": error,
        "detail": detail,
        "clicked": clicked,
        "dryRun": dry_run,
        "count": count,
        "items": items,
        "history": Value::Null,
    })
}

/// В окне, где пользователь сейчас вводит логин, задачу не запускаем: оно бы перешло на другую страницу.
fn window_is_open(app: &AppHandle, char_id: &str) -> bool {
    app.get_webview_window(&window_label(char_id))
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// Чтение страницы передачи (только чтение): `{ charId, status, error, roster }`.
/// `status`: `ok` | `not_logged_in` | `challenge` | `error`. В `roster`: `siteId`, `accountName`, `shards`
/// (серверы с персонажами), `items` (что можно передать), `chests`, `locked`, `empty`.
#[command]
pub async fn read_transfer_page(
    app: AppHandle,
    char_id: String,
    timeout_seconds: Option<u64>,
) -> Result<Value, String> {
    let reply = |status: &str, error: Option<&str>, roster: Value| json!({ "charId": char_id, "status": status, "error": error, "roster": roster });
    if !is_valid_char_id(&char_id) {
        return Ok(reply("error", Some("bad_char"), Value::Null));
    }
    if window_is_open(&app, &char_id) {
        return Ok(reply("error", Some("window_open"), Value::Null));
    }
    let scope = format!("char:{}", char_id);
    let timeout = timeout_seconds.unwrap_or(25).max(5);
    let task = pool::acquire(&app, &char_id, PAGE_URL).await?;
    tf_log(&app, &scope, "info", task.describe());
    navigate_clean(task.window(), PAGE_URL).await?;

    let res = eval_and_wait(
        task.window(),
        &xfer_script(&json!({ "mode": "scan" })),
        PREFIX,
        timeout,
        &scope,
    )
    .await;
    match classify_scan(res) {
        Ok(data) => {
            tf_log(&app, &scope, "ok", "Серверы и персонажи прочитаны");
            task.finish(Some(&char_id), true, true).await;
            Ok(reply("ok", None, data))
        }
        Err((status, error)) => {
            tf_log(
                &app,
                &scope,
                "warn",
                format!("Страница передачи не прочитана: {}", error),
            );
            let logged_in = !matches!(status, "not_logged_in" | "challenge") && error != "timeout";
            task.finish(Some(&char_id), true, logged_in).await;
            let err = (status == "error").then_some(error.as_str());
            Ok(reply(status, err, Value::Null))
        }
    }
}

/// Передача всех доступных предметов выбранному персонажу.
/// Результат: `{ charId, status, error, detail, clicked, dryRun, count, items, history }`.
/// `status`: `submitted` (после нажатия открылась история; `history` — строки самой новой передачи) | `dry_run`
/// | `nothing` | `not_logged_in` | `challenge` | `unknown` | `error`. `clicked = true` — повторять нельзя.
#[command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_items(
    app: AppHandle,
    char_id: String,
    shard_id: String,
    recipient: String,
    char_name: Option<String>,
    dry_run: Option<bool>,
    timeout_seconds: Option<u64>,
) -> Result<Value, String> {
    let dry = dry_run.unwrap_or(false);
    let fail = |error: &str| {
        payload(
            &char_id,
            "error",
            Some(error),
            None,
            false,
            dry,
            0,
            Value::Null,
        )
    };
    if !is_valid_char_id(&char_id) {
        return Ok(fail("bad_char"));
    }
    if !is_valid_shard(&shard_id) {
        return Ok(fail("bad_server"));
    }
    if !is_valid_recipient(&recipient) || !recipient_matches_shard(&recipient, &shard_id) {
        return Ok(fail("bad_recipient"));
    }
    if window_is_open(&app, &char_id) {
        return Ok(fail("window_open"));
    }

    let name = clean_name(char_name.as_deref().unwrap_or(""));
    let scope = format!("char:{}", char_id);
    let timeout = timeout_seconds.unwrap_or(30).max(5);
    let task = pool::acquire(&app, &char_id, PAGE_URL).await?;
    tf_log(&app, &scope, "info", task.describe());
    navigate_clean(task.window(), PAGE_URL).await?;

    // 1. Выбор в списках сайта (ничего не отправляется)
    let fill_cfg =
        json!({ "mode": "fill", "shard": shard_id, "recipient": recipient, "charName": name });
    let filled = eval_and_wait(
        task.window(),
        &xfer_script(&fill_cfg),
        PREFIX,
        timeout,
        &scope,
    )
    .await;
    let filled = match classify_fill(filled) {
        Ok(f) => f,
        Err((status, error)) => {
            tf_log(
                &app,
                &scope,
                "warn",
                format!("Передача не начата: {}", error),
            );
            let logged_in = !matches!(status, "not_logged_in" | "challenge") && error != "timeout";
            task.finish(Some(&char_id), true, logged_in).await;
            let err = (status != "nothing").then_some(error.as_str());
            return Ok(payload(
                &char_id,
                status,
                err,
                None,
                false,
                dry,
                0,
                Value::Null,
            ));
        }
    };

    if dry {
        tf_log(
            &app,
            &scope,
            "info",
            format!(
                "Пробный запуск: выбрано предметов {}, «Передать» не нажато",
                filled.count
            ),
        );
        task.finish(Some(&char_id), true, true).await;
        return Ok(payload(
            &char_id,
            "dry_run",
            None,
            None,
            false,
            true,
            filled.count,
            filled.items,
        ));
    }

    // 2. Нажатие: строго один раз, без повторов
    tf_log(
        &app,
        &scope,
        "step",
        format!("Передаю предметов: {}", filled.count),
    );
    let _ = task.window().eval(CLEAR_HASH);
    let click_cfg = json!({ "mode": "click", "shard": shard_id, "recipient": recipient, "count": filled.count });
    if task
        .window()
        .eval(with_common(&xfer_script(&click_cfg)))
        .is_err()
    {
        task.finish(Some(&char_id), true, true).await;
        return Ok(payload(
            &char_id,
            "error",
            Some("click_failed"),
            None,
            false,
            false,
            filled.count,
            filled.items,
        ));
    }
    tokio::time::sleep(Duration::from_millis(900)).await;
    // Скрипт отвечает только отказом (выбор изменился, кнопка пропала): тогда ничего не нажато
    if let Ok(now) = task.window().url() {
        if let Some((Some(err), _)) = read_hash_payload(now.as_str(), PREFIX) {
            tf_log(&app, &scope, "warn", format!("Кнопка не нажата: {}", err));
            task.finish(Some(&char_id), true, true).await;
            return Ok(payload(
                &char_id,
                "error",
                Some(&err),
                None,
                false,
                false,
                filled.count,
                filled.items,
            ));
        }
    }

    // 3. Ответ сайта: страница «История передачи» (только чтение)
    let result = eval_and_wait(
        task.window(),
        &xfer_script(&json!({ "mode": "result" })),
        PREFIX,
        timeout.max(40),
        &scope,
    )
    .await;
    let out = classify_result(result);
    tf_log(
        &app,
        &scope,
        if out.status == "submitted" {
            "ok"
        } else {
            "warn"
        },
        format!("Ответ сайта: {}", out.status),
    );
    task.finish(Some(&char_id), true, true).await;
    let mut res = payload(
        &char_id,
        out.status,
        out.error.as_deref(),
        out.detail.as_deref(),
        true,
        false,
        filled.count,
        filled.items,
    );
    res["history"] = out.history;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(data: Value) -> Wait {
        Some((None, data))
    }
    fn err(e: &str) -> Wait {
        Some((Some(e.to_string()), Value::Null))
    }

    #[test]
    fn shard_and_recipient_are_restricted() {
        assert!(is_valid_shard("3"));
        assert!(is_valid_shard("12"));
        for bad in ["", "a", "3 ", "3;4", "../3", "123456789"] {
            assert!(!is_valid_shard(bad), "{bad}");
        }
        assert!(is_valid_recipient("153909633_3_2069946672"));
        for bad in [
            "", "1_2", "1_2_3_4", "a_3_4", "1__3", "1_3_x", "1_3_4 ", "1_3_4\n",
        ] {
            assert!(!is_valid_recipient(bad), "{bad}");
        }
        assert!(recipient_matches_shard("153909633_3_2069946672", "3"));
        assert!(!recipient_matches_shard("153909633_3_2069946672", "5"));
    }

    #[test]
    fn name_is_cleaned() {
        assert_eq!(clean_name("  #Тест\n"), "#Тест");
        assert_eq!(clean_name(&"я".repeat(100)).chars().count(), 60);
    }

    #[test]
    fn scan_returns_page_data_or_final_error() {
        let data = json!({ "state": "scan", "shards": [], "items": [] });
        assert_eq!(classify_scan(ok(data.clone())), Ok(data));
        assert_eq!(
            classify_scan(err("not_logged_in")).unwrap_err().0,
            "not_logged_in"
        );
        assert_eq!(classify_scan(err("challenge")).unwrap_err().0, "challenge");
        assert_eq!(
            classify_scan(err("pending")).unwrap_err(),
            ("error", "form_not_found".to_string())
        );
        assert_eq!(
            classify_scan(None).unwrap_err(),
            ("error", "timeout".to_string())
        );
        assert_eq!(
            classify_scan(ok(json!({ "state": "other" }))).unwrap_err(),
            ("error", "bad_response".to_string())
        );
    }

    #[test]
    fn fill_needs_at_least_one_item() {
        let ready = ok(json!({ "state": "ready", "count": 3, "items": [{ "name": "Метеорит" }] }));
        let f = classify_fill(ready).unwrap();
        assert_eq!(f.count, 3);
        assert_eq!(f.items[0]["name"], "Метеорит");
        // «ready» без предметов — не повод нажимать
        assert!(classify_fill(ok(json!({ "state": "ready", "count": 0 }))).is_err());
    }

    #[test]
    fn fill_failures_map_to_statuses() {
        assert_eq!(classify_fill(err("no_items")).unwrap_err().0, "nothing");
        assert_eq!(
            classify_fill(err("not_logged_in")).unwrap_err().0,
            "not_logged_in"
        );
        assert_eq!(classify_fill(err("challenge")).unwrap_err().0, "challenge");
        for e in ["server_not_found", "char_not_found", "char_mismatch"] {
            assert_eq!(classify_fill(err(e)).unwrap_err(), ("error", e.to_string()));
        }
        assert_eq!(
            classify_fill(err("pending")).unwrap_err(),
            ("error", "form_not_found".to_string())
        );
        assert_eq!(
            classify_fill(None).unwrap_err(),
            ("error", "timeout".to_string())
        );
    }

    #[test]
    fn result_is_submitted_only_when_history_opened() {
        let rows = json!([{ "name": "Метеорит", "qty": 2, "status": "В обработке" }]);
        let o = classify_result(ok(json!({ "state": "history", "rows": rows })));
        assert_eq!(o.status, "submitted");
        assert_eq!(o.history[0]["name"], "Метеорит");
        // всё остальное — «не удалось определить»: передача могла и уйти, нужна проверка истории
        for res in [
            None,
            ok(json!({ "state": "ready" })),
            err("pending"),
            err("not_logged_in"),
        ] {
            let o = classify_result(res);
            assert_eq!(o.status, "unknown");
            assert!(o.history.is_null());
        }
    }

    #[test]
    fn unknown_result_keeps_site_text() {
        let o = classify_result(Some((
            Some("unknown".to_string()),
            json!("Что-то пошло не так"),
        )));
        assert_eq!(o.status, "unknown");
        assert_eq!(o.detail.as_deref(), Some("Что-то пошло не так"));
        assert!(o.error.is_none());
        assert_eq!(classify_result(None).error.as_deref(), Some("timeout"));
    }

    #[test]
    fn script_gets_mode_and_embedded_script() {
        let s = xfer_script(&json!({ "mode": "click", "count": 2 }));
        assert!(s.starts_with("window.__TF_XFER = {"));
        assert!(s.contains("\"mode\":\"click\""));
        assert!(s.contains("TF_XFER_V1_"));
    }
}
