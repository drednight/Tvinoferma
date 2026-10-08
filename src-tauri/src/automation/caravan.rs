//! «Сундук караванщика»: открытие сундуков из инвентаря на сайте в окне профиля персонажа.
//! Скрипт страницы: `scripts/caravan.js` (режимы `scan`, `fill`, `click`, `after`).
//!
//! Что делает команда для одного персонажа:
//! 1. открывает `/promo_items.php` и читает список сундуков (только чтение); берутся только «Сундуки караванщика»,
//!    другие сундуки («Подарочный мешок» и т. п.) не трогаются;
//! 2. для каждого сундука открывает `/promo_items.php?do=activate&cart_id=N`, отмечает все предметы
//!    и нажимает кнопку отправки формы ОДИН раз (повторов нет);
//! 3. снова читает список: сундук, которого там больше нет, считается открытым.
//!    Решение «успех или нет» принимает именно эта проверка, а не вид страницы после нажатия.
//!
//! Правила безопасности (см. `docs/COMPLIANCE.md`):
//! - команда запускается только кнопкой пользователя из диалога; расписаний нет;
//! - режим `dry_run` только читает список и ничего не нажимает;
//! - кнопка каждого сундука нажимается один раз; `clicked = true` означает «заново запускать вслепую нельзя».

use super::promo::is_valid_char_id;
use crate::parsers::{eval_and_wait, navigate_clean, read_hash_payload, tf_log, with_common};
use crate::pool;
use crate::windows::window_label;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{command, AppHandle, Manager};

const SCRIPT: &str = include_str!("../scripts/caravan.js");
const PAGE_URL: &str = "https://pwonline.ru/promo_items.php";
const ACTIVATE_URL: &str = "https://pwonline.ru/promo_items.php?do=activate&cart_id=";
const PREFIX: &str = "#TF_CARAVAN_V1_";
const CLEAR_HASH: &str = "history.replaceState(null, '', location.pathname + location.search);";
/// Больше сундуков за один запуск не открываем: остальные откроются следующим запуском.
const MAX_CHESTS: usize = 30;

/// Номер сундука идёт в адрес страницы, поэтому допускаются только цифры.
pub fn is_valid_cart_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 12 && id.chars().all(|c| c.is_ascii_digit())
}

type Wait = Option<(Option<String>, Value)>;

fn caravan_script(cfg: &Value) -> String {
    format!("window.__TF_CARAVAN = {};\n{}", cfg, SCRIPT)
}

fn timeout_error() -> (&'static str, String) {
    ("error", "timeout".to_string())
}

/// Сундук из списка: номер для адреса и срок «до …» для журнала.
#[derive(Debug, Clone, PartialEq)]
struct Chest {
    cart_id: String,
    until: String,
}

#[derive(Debug, PartialEq)]
struct Scan {
    chests: Vec<Chest>,
    /// Сундуки других видов: их не открываем
    other: u64,
}

/// Итог чтения списка: сундуки или конечный `(status, error)`.
fn classify_scan(res: Wait) -> Result<Scan, (&'static str, String)> {
    match res {
        None => Err(timeout_error()),
        Some((None, data)) if data["state"] == "scan" => {
            let mut chests: Vec<Chest> = Vec::new();
            for c in data["chests"].as_array().unwrap_or(&Vec::new()) {
                let id = c["cartId"].as_str().unwrap_or("");
                // Неверный номер пропускаем целиком, а не «чиним»: он попал бы в адрес страницы
                if is_valid_cart_id(id) && !chests.iter().any(|x| x.cart_id == id) {
                    chests.push(Chest {
                        cart_id: id.to_string(),
                        until: c["until"].as_str().unwrap_or("").to_string(),
                    });
                }
            }
            Ok(Scan {
                chests,
                other: data["other"].as_u64().unwrap_or(0),
            })
        }
        Some((None, _)) => Err(("error", "bad_response".to_string())),
        Some((Some(err), _)) => Err(match err.as_str() {
            "not_logged_in" => ("not_logged_in", err),
            "challenge" => ("challenge", err),
            // страница загрузилась, но списка предметов на ней нет
            "pending" => ("error", "page_not_found".to_string()),
            _ => ("error", err),
        }),
    }
}

/// Отмечены предметы сундука: сколько и какие.
#[derive(Debug, PartialEq)]
struct Filled {
    count: u64,
    names: Vec<String>,
}

/// Итог отметки предметов на странице сундука.
/// `chest_gone` — формы этого сундука на странице нет (уже открыт или недоступен): это не ошибка запуска.
fn classify_fill(res: Wait) -> Result<Filled, (&'static str, String)> {
    match res {
        None => Err(timeout_error()),
        Some((None, data))
            if data["state"] == "ready" && data["count"].as_u64().unwrap_or(0) > 0 =>
        {
            Ok(Filled {
                count: data["count"].as_u64().unwrap_or(0),
                names: data["names"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        }
        Some((None, _)) => Err(("error", "bad_response".to_string())),
        Some((Some(err), _)) => Err(match err.as_str() {
            "not_logged_in" => ("not_logged_in", err),
            "challenge" => ("challenge", err),
            "chest_not_found" => ("chest_gone", err),
            "pending" => ("error", "form_not_found".to_string()),
            _ => ("error", err),
        }),
    }
}

/// Состояние одного сундука в отчёте.
fn chest_json(c: &Chest, state: &str, error: Option<&str>, items: &[String]) -> Value {
    json!({
        "cartId": c.cart_id,
        "until": c.until,
        "state": state,
        "error": error,
        "items": items,
    })
}

#[allow(clippy::too_many_arguments)]
fn payload(
    char_id: &str,
    status: &str,
    error: Option<&str>,
    dry_run: bool,
    clicked: bool,
    found: usize,
    other: u64,
    opened: usize,
    chests: Vec<Value>,
) -> Value {
    json!({
        "charId": char_id,
        "status": status,
        "error": error,
        "dryRun": dry_run,
        "clicked": clicked,
        "found": found,
        "other": other,
        "opened": opened,
        "chests": chests,
    })
}

/// В окне, где пользователь сейчас вводит логин, задачу не запускаем: оно бы перешло на другую страницу.
fn window_is_open(app: &AppHandle, char_id: &str) -> bool {
    app.get_webview_window(&window_label(char_id))
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// Итоговый статус по результатам проверки списка после открытия.
/// `after` — сундуки, которые остались в списке; `None` — список перечитать не удалось.
fn final_status(
    clicked: usize,
    remaining_of_clicked: Option<usize>,
    had_errors: bool,
) -> &'static str {
    match remaining_of_clicked {
        _ if clicked == 0 => {
            if had_errors {
                "error"
            } else {
                "nothing"
            }
        }
        None => "unknown",
        Some(0) if !had_errors => "success",
        Some(_) => "partial",
    }
}

/// Открывает «Сундуки караванщика» персонажа: `{ charId, status, error, dryRun, clicked, found, other, opened, chests }`.
/// `status`: `success` | `partial` | `nothing` | `dry_run` | `not_logged_in` | `challenge` | `unknown` | `error`.
/// В `chests`: `cartId`, `until`, `state` (`found` | `opened` | `not_opened` | `sent` | `gone` | `error`), `error`, `items`.
#[command]
pub async fn open_caravan_chests(
    app: AppHandle,
    char_id: String,
    dry_run: Option<bool>,
    timeout_seconds: Option<u64>,
) -> Result<Value, String> {
    let dry = dry_run.unwrap_or(false);
    let fail = |error: &str| payload(&char_id, "error", Some(error), dry, false, 0, 0, 0, vec![]);
    if !is_valid_char_id(&char_id) {
        return Ok(fail("bad_char"));
    }
    if window_is_open(&app, &char_id) {
        return Ok(fail("window_open"));
    }

    let scope = format!("char:{}", char_id);
    let timeout = timeout_seconds.unwrap_or(25).max(5);
    let task = pool::acquire(&app, &char_id, PAGE_URL).await?;
    tf_log(&app, &scope, "info", task.describe());
    navigate_clean(task.window(), PAGE_URL).await?;

    // 1. Список сундуков (только чтение)
    let scan = eval_and_wait(
        task.window(),
        &caravan_script(&json!({ "mode": "scan" })),
        PREFIX,
        timeout,
        &scope,
    )
    .await;
    let scan = match classify_scan(scan) {
        Ok(s) => s,
        Err((status, error)) => {
            tf_log(
                &app,
                &scope,
                "warn",
                format!("Инвентарь не прочитан: {}", error),
            );
            let logged_in = !matches!(status, "not_logged_in" | "challenge") && error != "timeout";
            task.finish(Some(&char_id), true, logged_in).await;
            let err = (status == "error").then_some(error.as_str());
            return Ok(payload(&char_id, status, err, dry, false, 0, 0, 0, vec![]));
        }
    };
    let found = scan.chests.len();
    tf_log(
        &app,
        &scope,
        "info",
        format!(
            "Сундуков караванщика: {}{}",
            found,
            if scan.other > 0 {
                format!(" (других сундуков: {}, их не трогаю)", scan.other)
            } else {
                String::new()
            }
        ),
    );
    if found == 0 || dry {
        task.finish(Some(&char_id), true, true).await;
        let status = if found == 0 { "nothing" } else { "dry_run" };
        let list = scan
            .chests
            .iter()
            .map(|c| chest_json(c, "found", None, &[]))
            .collect();
        return Ok(payload(
            &char_id, status, None, dry, false, found, scan.other, 0, list,
        ));
    }

    // 2. Каждый сундук: отметить все предметы и нажать кнопку один раз
    let todo: Vec<Chest> = scan.chests.iter().take(MAX_CHESTS).cloned().collect();
    let mut states: Vec<(Chest, &'static str, Option<String>, Vec<String>)> = Vec::new();
    let mut stop: Option<(&'static str, String)> = None;
    for chest in &todo {
        if stop.is_some() {
            // дальше идти нельзя (нет входа / проверка безопасности): остальные не трогаем
            states.push((chest.clone(), "found", None, vec![]));
            continue;
        }
        let url = format!("{}{}", ACTIVATE_URL, chest.cart_id);
        tf_log(
            &app,
            &scope,
            "step",
            format!("Открываю сундук {} (до {})", chest.cart_id, chest.until),
        );
        navigate_clean(task.window(), &url).await?;
        let fill = eval_and_wait(
            task.window(),
            &caravan_script(&json!({ "mode": "fill", "cartId": chest.cart_id })),
            PREFIX,
            timeout,
            &scope,
        )
        .await;
        let filled = match classify_fill(fill) {
            Ok(f) => f,
            Err(("chest_gone", _)) => {
                tf_log(
                    &app,
                    &scope,
                    "info",
                    "Сундук уже недоступен (открыт или истёк)",
                );
                states.push((chest.clone(), "gone", None, vec![]));
                continue;
            }
            Err((status, error)) => {
                tf_log(&app, &scope, "warn", format!("Сундук не открыт: {}", error));
                if matches!(status, "not_logged_in" | "challenge") {
                    stop = Some((status, error.clone()));
                }
                states.push((chest.clone(), "error", Some(error), vec![]));
                continue;
            }
        };

        let _ = task.window().eval(CLEAR_HASH);
        let click_cfg = json!({ "mode": "click", "cartId": chest.cart_id, "count": filled.count });
        if task
            .window()
            .eval(with_common(&caravan_script(&click_cfg)))
            .is_err()
        {
            states.push((
                chest.clone(),
                "error",
                Some("click_failed".to_string()),
                filled.names,
            ));
            continue;
        }
        tokio::time::sleep(Duration::from_millis(900)).await;
        // Скрипт отвечает только отказом (отметки изменились, кнопки нет): тогда ничего не нажато
        let refused = task
            .window()
            .url()
            .ok()
            .and_then(|u| read_hash_payload(u.as_str(), PREFIX))
            .and_then(|(e, _)| e);
        if let Some(err) = refused {
            tf_log(&app, &scope, "warn", format!("Кнопка не нажата: {}", err));
            states.push((chest.clone(), "error", Some(err), filled.names));
            continue;
        }
        // Ждём страницу после отправки формы (только чтение); итог всё равно решает повторное чтение списка
        let after = eval_and_wait(
            task.window(),
            &caravan_script(&json!({ "mode": "after" })),
            PREFIX,
            timeout.min(15),
            &scope,
        )
        .await;
        if let Some((None, data)) = &after {
            if let Some(t) = data["title"].as_str().filter(|t| !t.is_empty()) {
                tf_log(
                    &app,
                    &scope,
                    "info",
                    format!("Страница после нажатия: {}", t),
                );
            }
        }
        states.push((chest.clone(), "sent", None, filled.names));
        tokio::time::sleep(Duration::from_millis(600)).await;
    }

    // 3. Проверка: что осталось в списке
    let clicked = states.iter().filter(|s| s.1 == "sent").count();
    let had_errors = states.iter().any(|s| s.1 == "error") || stop.is_some();
    let mut remaining: Option<Vec<String>> = None;
    if clicked > 0 {
        navigate_clean(task.window(), PAGE_URL).await?;
        let rescan = eval_and_wait(
            task.window(),
            &caravan_script(&json!({ "mode": "scan" })),
            PREFIX,
            timeout,
            &scope,
        )
        .await;
        remaining = classify_scan(rescan)
            .ok()
            .map(|s| s.chests.into_iter().map(|c| c.cart_id).collect());
    }
    let mut opened = 0usize;
    let mut left_of_clicked = 0usize;
    let chests: Vec<Value> = states
        .iter()
        .map(|(c, state, err, items)| {
            let state = match (*state, &remaining) {
                ("sent", Some(rem)) if rem.contains(&c.cart_id) => {
                    left_of_clicked += 1;
                    "not_opened"
                }
                ("sent", Some(_)) => {
                    opened += 1;
                    "opened"
                }
                (s, _) => s,
            };
            chest_json(c, state, err.as_deref(), items)
        })
        .collect();
    let status = match (
        &stop,
        final_status(
            clicked,
            remaining.as_ref().map(|_| left_of_clicked),
            had_errors,
        ),
    ) {
        (Some((s, _)), "nothing" | "error") => *s,
        (_, s) => s,
    };
    let error = (status == "error").then(|| {
        states
            .iter()
            .find_map(|s| s.2.clone())
            .unwrap_or_else(|| "unknown".to_string())
    });
    tf_log(
        &app,
        &scope,
        if status == "success" { "ok" } else { "warn" },
        format!("Открыто сундуков: {} из {}", opened, found),
    );
    task.finish(
        Some(&char_id),
        true,
        !matches!(status, "not_logged_in" | "challenge"),
    )
    .await;
    let mut res = payload(
        &char_id,
        status,
        error.as_deref(),
        false,
        clicked > 0,
        found,
        scan.other,
        opened,
        chests,
    );
    if found > todo.len() {
        res["truncated"] = json!(found - todo.len());
    }
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
    fn cart_id_is_digits_only() {
        assert!(is_valid_cart_id("43915985"));
        for bad in ["", "a1", "12 3", "1;2", "../1", "1234567890123"] {
            assert!(!is_valid_cart_id(bad), "{bad}");
        }
    }

    #[test]
    fn scan_keeps_valid_unique_chests() {
        let page = json!({ "state": "scan", "other": 4, "chests": [
            { "cartId": "43915985", "until": "15:04 10.10.2026" },
            { "cartId": "43915985", "until": "дубль" },
            { "cartId": "x1", "until": "" },
            { "cartId": "43921742", "until": "15:06 11.10.2026" }
        ]});
        let s = classify_scan(ok(page)).unwrap();
        assert_eq!(s.other, 4);
        assert_eq!(
            s.chests
                .iter()
                .map(|c| c.cart_id.as_str())
                .collect::<Vec<_>>(),
            ["43915985", "43921742"]
        );
        assert_eq!(s.chests[0].until, "15:04 10.10.2026");
    }

    #[test]
    fn scan_errors_become_final_statuses() {
        assert_eq!(classify_scan(None), Err(("error", "timeout".to_string())));
        assert_eq!(
            classify_scan(err("not_logged_in")),
            Err(("not_logged_in", "not_logged_in".to_string()))
        );
        assert_eq!(
            classify_scan(err("challenge")),
            Err(("challenge", "challenge".to_string()))
        );
        assert_eq!(
            classify_scan(err("pending")),
            Err(("error", "page_not_found".to_string()))
        );
        assert_eq!(
            classify_scan(ok(json!({ "state": "oops" }))),
            Err(("error", "bad_response".to_string()))
        );
    }

    #[test]
    fn fill_needs_at_least_one_item() {
        let ready =
            json!({ "state": "ready", "count": 4, "names": ["Самоцвет грез (оружие)", "x"] });
        let f = classify_fill(ok(ready)).unwrap();
        assert_eq!(f.count, 4);
        assert_eq!(f.names.len(), 2);
        let zero = json!({ "state": "ready", "count": 0 });
        assert_eq!(
            classify_fill(ok(zero)),
            Err(("error", "bad_response".to_string()))
        );
        assert_eq!(
            classify_fill(err("chest_not_found")),
            Err(("chest_gone", "chest_not_found".to_string()))
        );
        assert_eq!(
            classify_fill(err("no_items")),
            Err(("error", "no_items".to_string()))
        );
        assert_eq!(
            classify_fill(err("pending")),
            Err(("error", "form_not_found".to_string()))
        );
    }

    #[test]
    fn final_status_is_decided_by_the_rechecked_list() {
        assert_eq!(final_status(0, None, false), "nothing");
        assert_eq!(final_status(0, None, true), "error");
        assert_eq!(final_status(3, Some(0), false), "success");
        assert_eq!(final_status(3, Some(1), false), "partial");
        assert_eq!(final_status(3, Some(0), true), "partial");
        // список перечитать не удалось — «успех» не объявляем
        assert_eq!(final_status(3, None, false), "unknown");
    }

    #[test]
    fn script_is_built_with_config() {
        let s = caravan_script(&json!({ "mode": "scan" }));
        assert!(s.starts_with("window.__TF_CARAVAN = {\"mode\":\"scan\"};"));
        assert!(s.contains("TF_CARAVAN_V1_"));
    }
}
