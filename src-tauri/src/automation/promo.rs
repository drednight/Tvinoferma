//! Активация промокода на персонаже (Issue #25): страница `/pin/<КОД>` в окне его профиля,
//! нажатие кнопки «Активировать», чтение ответа сайта (скрипт `scripts/promo.js`).
//!
//! Правила безопасности (см. `docs/COMPLIANCE.md`):
//! - команда запускается только по кнопке пользователя из диалога; расписаний нет;
//! - перед нажатием страница только читается (вход, код не отклонён, ровно одна кнопка);
//! - кнопка нажимается ОДИН раз, повторов нет: поэтому `clicked = true` означает «заново запускать нельзя»;
//! - режим `dry_run` доходит до осмотра страницы и не нажимает ничего;
//! - код в консоль не пишется; награда со страницы успеха возвращается в `rewards`.

use crate::parsers::{eval_and_wait, navigate_clean, tf_log, with_common};
use crate::pool;
use crate::windows::window_label;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{command, AppHandle, Manager};

const SCRIPT: &str = include_str!("../scripts/promo.js");
const PIN_URL: &str = "https://pwonline.ru/pin/";
const PREFIX: &str = "#TF_PIN_V1_";
/// Самое длинное значение поля на форме `usercp.php` (`maxlength="40"`).
const CODE_MAX: usize = 40;
const CODE_MIN: usize = 4;

/// Код попадает в адрес страницы, поэтому допускаются только буквы, цифры, `-` и `_`.
pub fn is_valid_code(code: &str) -> bool {
    (CODE_MIN..=CODE_MAX).contains(&code.len())
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// id персонажа строится из ника (`js/core/ids.js`): только `A-Za-z0-9_-`.
fn is_valid_char_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

type Wait = Option<(Option<String>, Value)>;

/// Итог осмотра: `Ok((подпись кнопки, отпечаток страницы))` или конечный `(status, error)`.
fn classify_inspect(res: Wait) -> Result<(String, String), (&'static str, String)> {
    match res {
        None => Err(("error", "timeout".to_string())),
        Some((None, data)) if data["state"] == "ready" => Ok((
            data["label"].as_str().unwrap_or("").to_string(),
            data["sig"].as_str().unwrap_or("").to_string(),
        )),
        Some((None, _)) => Err(("error", "bad_response".to_string())),
        Some((Some(err), _)) => {
            let status = match err.as_str() {
                "not_logged_in" => "not_logged_in",
                "challenge" => "challenge",
                "invalid_code" => "invalid_code",
                "expired" => "expired",
                "already_used" => "already_used",
                "needs_choice" => "needs_choice",
                // /pin/<код> не подставил код в поле: сами мы его не вводим и ничего не нажимаем
                "code_not_filled" => return Err(("error", "code_not_filled".to_string())),
                // страница загрузилась, но кнопки «Активировать» на ней нет
                "pending" => return Err(("error", "button_not_found".to_string())),
                _ => "error",
            };
            Err((status, err))
        }
    }
}

/// Итог после нажатия.
struct Outcome {
    status: &'static str,
    error: Option<String>,
    detail: Option<String>,
    /// Список наград (массив объектов) только для успеха.
    rewards: Value,
}

impl Outcome {
    fn new(status: &'static str, error: Option<String>, detail: Option<String>) -> Self {
        Outcome {
            status,
            error,
            detail,
            rewards: Value::Null,
        }
    }
}

/// Итог после нажатия. Любая неясность — `unknown`, а не успех.
fn classify_result(res: Wait) -> Outcome {
    let text = |v: &Value| v.as_str().map(|s| s.to_string());
    match res {
        None => Outcome::new("unknown", Some("timeout".to_string()), None),
        Some((None, data)) if data["state"] == "success" => {
            let mut out = Outcome::new("success", None, text(&data["detail"]));
            if data["rewards"].is_array() {
                out.rewards = data["rewards"].clone();
            }
            out
        }
        Some((None, _)) => Outcome::new("unknown", Some("bad_response".to_string()), None),
        Some((Some(err), data)) => match err.as_str() {
            "already_used" => Outcome::new("already_used", None, text(&data)),
            "invalid_code" => Outcome::new("invalid_code", None, text(&data)),
            "expired" => Outcome::new("expired", None, text(&data)),
            "not_logged_in" => Outcome::new("not_logged_in", None, text(&data)),
            // «Пустой пин-код» после нажатия: сайт не получил код, результат неясен
            "unknown" | "code_empty" => Outcome::new("unknown", None, text(&data)),
            // страница после нажатия не изменилась / показала проверку безопасности
            _ => Outcome::new("unknown", Some(err.clone()), None),
        },
    }
}

fn payload(
    char_id: &str,
    status: &str,
    error: Option<&str>,
    detail: Option<&str>,
    clicked: bool,
    dry_run: bool,
) -> Value {
    json!({
        "charId": char_id,
        "status": status,
        "error": error,
        "detail": detail,
        "clicked": clicked,
        "dryRun": dry_run,
        "rewards": Value::Null,
    })
}

/// Скрипт страницы для одного режима: `window.__TF_PIN = {...}` + `promo.js`.
fn pin_script(mode: &str, code: &str, baseline: &str) -> String {
    let cfg = json!({ "mode": mode, "code": code, "baseline": baseline });
    format!("window.__TF_PIN = {};\n{}", cfg, SCRIPT)
}

/// Результат: `{ charId, status, error, detail, clicked, dryRun, rewards }`.
/// `status`: `success` | `already_used` | `invalid_code` | `expired` | `not_logged_in` | `challenge` | `needs_choice`
/// | `dry_run` | `unknown` | `error`. `clicked = true` — кнопка нажата, команду повторять нельзя.
#[command]
pub async fn activate_promo(
    app: AppHandle,
    char_id: String,
    code: String,
    dry_run: Option<bool>,
    timeout_seconds: Option<u64>,
) -> Result<Value, String> {
    let dry = dry_run.unwrap_or(false);
    if !is_valid_char_id(&char_id) {
        return Ok(payload(
            &char_id,
            "error",
            Some("bad_char"),
            None,
            false,
            dry,
        ));
    }
    if !is_valid_code(&code) {
        return Ok(payload(
            &char_id,
            "error",
            Some("bad_code"),
            None,
            false,
            dry,
        ));
    }
    // В окне, где пользователь сейчас вводит логин, задачу не запускаем: оно бы перешло на другую страницу
    if let Some(w) = app.get_webview_window(&window_label(&char_id)) {
        if w.is_visible().unwrap_or(false) {
            return Ok(payload(
                &char_id,
                "error",
                Some("window_open"),
                None,
                false,
                dry,
            ));
        }
    }

    let scope = format!("char:{}", char_id);
    let timeout = timeout_seconds.unwrap_or(25).max(5);
    let url = format!("{}{}", PIN_URL, code);
    let task = pool::acquire(&app, &char_id, &url).await?;
    tf_log(&app, &scope, "info", task.describe());
    navigate_clean(task.window(), &url).await?;

    // 1. Осмотр страницы (только чтение)
    let inspect = eval_and_wait(
        task.window(),
        &pin_script("inspect", &code, ""),
        PREFIX,
        timeout,
        &scope,
    )
    .await;
    let (label, sig) = match classify_inspect(inspect) {
        Ok(ready) => ready,
        Err((status, error)) => {
            tf_log(
                &app,
                &scope,
                "warn",
                format!("Промокод не применён: {}", error),
            );
            // Вход на сайте был, если страница отвечала не «нет входа» и не «проверка безопасности»
            let logged_in = !matches!(status, "not_logged_in" | "challenge") && error != "timeout";
            task.finish(Some(&char_id), true, logged_in).await;
            let err = (status == "error").then_some(error.as_str());
            return Ok(payload(&char_id, status, err, None, false, dry));
        }
    };

    if dry {
        tf_log(
            &app,
            &scope,
            "info",
            format!("Пробный запуск: найдена кнопка «{}», она не нажата", label),
        );
        task.finish(Some(&char_id), true, true).await;
        return Ok(payload(
            &char_id,
            "dry_run",
            None,
            Some(&label),
            false,
            true,
        ));
    }

    // 2. Нажатие: строго один раз, без повторов
    tf_log(&app, &scope, "step", format!("Нажимаю «{}»", label));
    if task
        .window()
        .eval(with_common(&pin_script("click", &code, "")))
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
        ));
    }
    tokio::time::sleep(Duration::from_millis(900)).await;
    // Скрипт отвечает только отказом (кнопка пропала / их стало две): тогда ничего не нажато
    if let Ok(now) = task.window().url() {
        if let Some((Some(err), _)) = crate::parsers::read_hash_payload(now.as_str(), PREFIX) {
            tf_log(&app, &scope, "warn", format!("Кнопка не нажата: {}", err));
            task.finish(Some(&char_id), true, true).await;
            return Ok(payload(&char_id, "error", Some(&err), None, false, false));
        }
    }

    // 3. Ответ сайта (только чтение)
    let result = eval_and_wait(
        task.window(),
        &pin_script("result", &code, &sig),
        PREFIX,
        timeout,
        &scope,
    )
    .await;
    let out = classify_result(result);
    tf_log(
        &app,
        &scope,
        if out.status == "success" {
            "ok"
        } else {
            "warn"
        },
        format!("Ответ сайта: {}", out.status),
    );
    task.finish(Some(&char_id), true, out.status != "not_logged_in")
        .await;
    let mut res = payload(
        &char_id,
        out.status,
        out.error.as_deref(),
        out.detail.as_deref(),
        true,
        false,
    );
    res["rewards"] = out.rewards;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_format_is_restricted() {
        assert!(is_valid_code("PWZNANIYA26"));
        assert!(is_valid_code("ab-cd_12"));
        assert!(!is_valid_code("abc"));
        assert!(!is_valid_code(&"A".repeat(41)));
        assert!(is_valid_code(&"A".repeat(40)));
        // в адрес страницы не должно попасть ничего лишнего
        for bad in [
            "../x",
            "AB CD",
            "AB/CD",
            "AB?x=1",
            "AB#1",
            "АБВГД12",
            "a\nbcd",
        ] {
            assert!(!is_valid_code(bad), "{bad}");
        }
    }

    #[test]
    fn char_id_is_restricted() {
        assert!(is_valid_char_id("Aurazak_1"));
        assert!(!is_valid_char_id(""));
        assert!(!is_valid_char_id("a/b"));
        assert!(!is_valid_char_id(".."));
    }

    #[test]
    fn inspect_ready_returns_label_and_signature() {
        let ok = classify_inspect(Some((
            None,
            json!({ "state": "ready", "label": "активировать", "sig": "123" }),
        )));
        assert_eq!(ok, Ok(("активировать".to_string(), "123".to_string())));
    }

    #[test]
    fn inspect_failures_map_to_statuses() {
        let e = |err: &str| classify_inspect(Some((Some(err.to_string()), Value::Null)));
        assert_eq!(e("not_logged_in").unwrap_err().0, "not_logged_in");
        assert_eq!(e("challenge").unwrap_err().0, "challenge");
        assert_eq!(e("invalid_code").unwrap_err().0, "invalid_code");
        assert_eq!(e("already_used").unwrap_err().0, "already_used");
        assert_eq!(e("needs_choice").unwrap_err().0, "needs_choice");
        assert_eq!(
            e("pending").unwrap_err(),
            ("error", "button_not_found".to_string())
        );
        assert_eq!(
            e("button_ambiguous").unwrap_err(),
            ("error", "button_ambiguous".to_string())
        );
        assert_eq!(
            classify_inspect(None).unwrap_err(),
            ("error", "timeout".to_string())
        );
    }

    #[test]
    fn inspect_code_not_filled_is_a_final_error() {
        let e = classify_inspect(Some((Some("code_not_filled".to_string()), Value::Null)));
        assert_eq!(e.unwrap_err(), ("error", "code_not_filled".to_string()));
        let e = classify_inspect(Some((Some("expired".to_string()), Value::Null)));
        assert_eq!(e.unwrap_err().0, "expired");
    }

    #[test]
    fn result_is_success_only_when_page_says_so() {
        let ok = classify_result(Some((
            None,
            json!({ "state": "success", "detail": "Готово", "rewards": [{ "name": "Метеорит", "qty": 100 }] }),
        )));
        assert_eq!(ok.status, "success");
        assert_eq!(ok.detail.as_deref(), Some("Готово"));
        assert_eq!(ok.rewards[0]["name"], "Метеорит");
        // неясный ответ никогда не считается успехом
        let unknown = classify_result(Some((Some("unknown".to_string()), json!("текст"))));
        assert_eq!(unknown.status, "unknown");
        assert_eq!(unknown.detail.as_deref(), Some("текст"));
        assert!(unknown.rewards.is_null());
        let none = classify_result(None);
        assert_eq!(none.status, "unknown");
        assert_eq!(none.error.as_deref(), Some("timeout"));
        for e in ["pending", "challenge", "code_empty"] {
            let r = classify_result(Some((Some(e.to_string()), Value::Null)));
            assert_eq!(r.status, "unknown", "{e}");
        }
    }

    #[test]
    fn success_without_rewards_list_has_null_rewards() {
        let ok = classify_result(Some((None, json!({ "state": "success", "detail": "ok" }))));
        assert_eq!(ok.status, "success");
        assert!(ok.rewards.is_null());
    }

    #[test]
    fn result_known_outcomes() {
        let r = |e: &str| classify_result(Some((Some(e.to_string()), json!("x")))).status;
        assert_eq!(r("already_used"), "already_used");
        assert_eq!(r("invalid_code"), "invalid_code");
        assert_eq!(r("expired"), "expired");
        assert_eq!(r("not_logged_in"), "not_logged_in");
    }

    #[test]
    fn script_gets_mode_and_escaped_code() {
        let s = pin_script("click", "AB-12_x", "");
        assert!(s.starts_with("window.__TF_PIN = {"));
        assert!(s.contains("\"mode\":\"click\""));
        assert!(s.contains("TF_PIN_V1_"));
    }
}
