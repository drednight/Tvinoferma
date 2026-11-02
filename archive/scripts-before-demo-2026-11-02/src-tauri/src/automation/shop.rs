//! Покупка за Древние монеты в «Магазине подарков» (`chests2.php`): чтение предметов, покупка по одной штуке,
//! чтение «Истории монет» (скрипт страницы `scripts/shop.js`).
//!
//! Правила безопасности (см. `docs/COMPLIANCE.md`):
//! - покупка запускается только по кнопке пользователя из диалога; расписаний нет;
//! - одна команда `buy_shop_item` = ОДНА покупка: приложение нажимает «Купить», затем «Да» в окне подтверждения
//!   сайта (как человек), и повторов после нажатия нет: `clicked = true` означает «заново запускать нельзя»;
//! - перед нажатием страница только читается: предмет найден один раз, цена совпадает с той, что показали
//!   пользователю, лимит не исчерпан, монет хватает;
//! - результат проверяется по сайту: баланс должен уменьшиться ровно на цену; неясный исход — `unknown`
//!   (с чтением «Истории монет» для сверки), а не успех;
//! - режим `dry_run` доходит до осмотра страницы и ничего не нажимает.

use crate::automation::promo::is_valid_char_id;
use crate::parsers::{eval_and_wait, navigate_clean, read_hash_payload, tf_log, with_common};
use crate::pool;
use crate::windows::window_is_open;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{command, AppHandle};

const SCRIPT: &str = include_str!("../scripts/shop.js");
const SHOP_URL: &str = "https://pwonline.ru/chests2.php";
const HISTORY_URL: &str = "https://pwonline.ru/chests2.php?do=history";
const PREFIX: &str = "#TF_SHOP_V1_";
/// Сколько названий предметов можно передать за один раз.
const MAX_WANTED: usize = 16;
const NAME_MAX: usize = 80;

/// Название предмета попадает только в скрипт страницы (как JSON), но допускаются лишь обычные символы названий.
pub fn is_valid_item_name(name: &str) -> bool {
    let count = name.chars().count();
    (2..=NAME_MAX).contains(&count)
        && !name.trim().is_empty()
        && name.chars().all(|c| {
            c.is_alphanumeric()
                || matches!(
                    c,
                    ' ' | '(' | ')' | '-' | '.' | ',' | ':' | '«' | '»' | '\''
                )
        })
}

/// Цена, с которой пользователь согласился: конечное положительное число.
pub fn is_valid_price(price: f64) -> bool {
    price.is_finite() && price > 0.0 && price < 100_000.0
}

fn clean_wanted(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in list {
        let name = name.trim().to_string();
        if is_valid_item_name(&name) && !out.contains(&name) {
            out.push(name);
        }
        if out.len() >= MAX_WANTED {
            break;
        }
    }
    out
}

/// Скрипт страницы для одного режима: `window.__TF_SHOP = {...}` + `shop.js`.
fn shop_script(cfg: &Value) -> String {
    format!("window.__TF_SHOP = {};\n{}", cfg, SCRIPT)
}

type Wait = Option<(Option<String>, Value)>;
/// Конечный отказ: `(status, error)`.
type Failure = (&'static str, String);

fn page_failure(err: &str) -> Failure {
    match err {
        "not_logged_in" => ("not_logged_in", err.to_string()),
        "challenge" => ("challenge", err.to_string()),
        _ => ("error", err.to_string()),
    }
}

/// Был ли на сайте вход (нужно, чтобы обновить банк кук только после удачной работы).
fn page_was_logged_in(res: &Wait) -> bool {
    match res {
        None => false,
        Some((Some(err), _)) => !matches!(err.as_str(), "not_logged_in" | "challenge"),
        Some((None, _)) => true,
    }
}

/// Чтение магазина: `data = { state: "scan", account, balance, items }`.
fn classify_scan(res: Wait) -> Result<Value, Failure> {
    match res {
        None => Err(("error", "timeout".to_string())),
        Some((None, data)) if data["state"] == "scan" => Ok(data),
        Some((None, _)) => Err(("error", "bad_response".to_string())),
        Some((Some(err), _)) => Err(page_failure(&err)),
    }
}

/// Чтение «Истории монет»: `data = { state: "history", account, rows }`.
fn classify_history(res: Wait) -> Result<Value, Failure> {
    match res {
        None => Err(("error", "timeout".to_string())),
        Some((None, data)) if data["state"] == "history" => Ok(data),
        Some((None, _)) => Err(("error", "bad_response".to_string())),
        Some((Some(err), _)) => Err(page_failure(&err)),
    }
}

/// Отказ до нажатия: ничего не нажато, причина — статус (`limit_reached`, `no_funds`, …) или ошибка.
#[derive(Debug, PartialEq)]
struct Refusal {
    status: &'static str,
    error: Option<String>,
    /// Данные со страницы (новая цена, остаток лимита, баланс).
    info: Value,
}

fn refuse(status: &'static str, error: Option<&str>, info: Value) -> Refusal {
    Refusal {
        status,
        error: error.map(|e| e.to_string()),
        info,
    }
}

/// Осмотр перед покупкой: `Ok(data)` — предмет можно покупать, иначе отказ.
fn classify_inspect(res: Wait) -> Result<Value, Refusal> {
    match res {
        None => Err(refuse("error", Some("timeout"), Value::Null)),
        Some((None, data)) if data["state"] == "ready" => Ok(data),
        Some((None, _)) => Err(refuse("error", Some("bad_response"), Value::Null)),
        Some((Some(err), data)) => Err(match err.as_str() {
            "limit_reached" => refuse("limit_reached", None, data),
            "no_funds" => refuse("no_funds", None, data),
            "price_changed" => refuse("price_changed", None, data),
            "item_missing" => refuse("item_missing", None, Value::Null),
            "not_logged_in" => refuse("not_logged_in", None, Value::Null),
            "challenge" => refuse("challenge", None, Value::Null),
            other => refuse("error", Some(other), Value::Null),
        }),
    }
}

/// Что показала страница после нажатия.
#[derive(Debug, PartialEq)]
enum After {
    /// Страница магазина с новыми данными.
    Page(Value),
    /// Страница не распознана или не изменилась: магазин нужно открыть заново (с текстом страницы, если он был).
    Recheck(Option<String>),
}

fn classify_after(res: Wait) -> After {
    match res {
        Some((None, data)) if data["state"] == "scan" => After::Page(data),
        Some((Some(err), data)) if err == "other_page" => {
            After::Recheck(data.as_str().map(|s| s.to_string()))
        }
        _ => After::Recheck(None),
    }
}

/// Итог сверки баланса после нажатия.
#[derive(Debug, PartialEq)]
enum Verdict {
    /// Баланс уменьшился ровно на цену.
    Bought,
    /// Баланс не изменился: сайт покупку не провёл.
    NoEffect,
    /// Баланс изменился иначе: нужна ручная проверка.
    Unclear(String),
}

fn verify_purchase(balance_before: f64, price: f64, after: &Value) -> Verdict {
    let Some(now) = after["balance"].as_f64() else {
        return Verdict::Unclear("баланс после покупки не прочитан".to_string());
    };
    let spent = ((balance_before - now) * 10.0).round() / 10.0;
    if (spent - price).abs() < 0.05 {
        Verdict::Bought
    } else if spent.abs() < 0.05 {
        Verdict::NoEffect
    } else {
        Verdict::Unclear(format!("баланс изменился на {} вместо {}", spent, price))
    }
}

fn buy_payload(
    char_id: &str,
    item: &str,
    status: &str,
    error: Option<&str>,
    detail: Option<String>,
    clicked: bool,
    dry_run: bool,
) -> Value {
    json!({
        "charId": char_id,
        "item": item,
        "status": status,
        "error": error,
        "detail": detail,
        "clicked": clicked,
        "dryRun": dry_run,
        "account": Value::Null,
        "balanceBefore": Value::Null,
        "balanceAfter": Value::Null,
        "items": Value::Null,
        "history": Value::Null,
        "info": Value::Null,
    })
}

/// Открывает страницу, выполняет один скрипт-чтение и возвращает его ответ (окно закрывается, если не сказано иное).
async fn read_page(
    app: &AppHandle,
    char_id: &str,
    url: &str,
    cfg: &Value,
    timeout: u64,
    close_after: bool,
) -> Result<Wait, String> {
    let scope = format!("char:{}", char_id);
    let task = pool::acquire(app, char_id, url).await?;
    tf_log(app, &scope, "info", task.describe());
    navigate_clean(task.window(), url).await?;
    let res = eval_and_wait(task.window(), &shop_script(cfg), PREFIX, timeout, &scope).await;
    task.finish(Some(char_id), close_after, page_was_logged_in(&res))
        .await;
    Ok(res)
}

/// Чтение магазина (только чтение): аккаунт сайта, баланс и данные нужных предметов.
/// Результат: `{ charId, status: "ok" | "not_logged_in" | "challenge" | "error", error, account, balance, items }`.
/// `items[]`: `{ want, found, ambiguous }` или `{ want, found: true, name, id, kind, price, available, max, blocked, desc, image }`.
#[command]
pub async fn read_shop(
    app: AppHandle,
    char_id: String,
    wanted: Vec<String>,
    timeout_seconds: Option<u64>,
    close_after: Option<bool>,
) -> Result<Value, String> {
    let empty = |status: &str, error: Option<&str>| {
        json!({
            "charId": char_id, "status": status, "error": error,
            "account": Value::Null, "balance": Value::Null, "items": Value::Null,
        })
    };
    if !is_valid_char_id(&char_id) {
        return Ok(empty("error", Some("bad_char")));
    }
    let names = clean_wanted(&wanted);
    if names.is_empty() {
        return Ok(empty("error", Some("bad_item")));
    }
    if window_is_open(&app, &char_id) {
        return Ok(empty("error", Some("window_open")));
    }
    let cfg = json!({ "mode": "scan", "wanted": names });
    let timeout = timeout_seconds.unwrap_or(25).max(5);
    let res = read_page(
        &app,
        &char_id,
        SHOP_URL,
        &cfg,
        timeout,
        close_after.unwrap_or(true),
    )
    .await?;
    Ok(match classify_scan(res) {
        Ok(data) => json!({
            "charId": char_id, "status": "ok", "error": Value::Null,
            "account": data["account"], "balance": data["balance"], "items": data["items"],
        }),
        Err((status, error)) => empty(status, Some(error.as_str())),
    })
}

/// Чтение «Истории монет» (последние 10 записей). Результат: `{ charId, status, error, account, rows }`,
/// `rows[]`: `{ at: "ГГГГ-ММ-ДД ЧЧ:ММ" (МСК), delta, before, after, action }`.
#[command]
pub async fn read_shop_history(
    app: AppHandle,
    char_id: String,
    timeout_seconds: Option<u64>,
    close_after: Option<bool>,
) -> Result<Value, String> {
    let empty = |status: &str, error: Option<&str>| {
        json!({
            "charId": char_id, "status": status, "error": error,
            "account": Value::Null, "rows": Value::Null,
        })
    };
    if !is_valid_char_id(&char_id) {
        return Ok(empty("error", Some("bad_char")));
    }
    if window_is_open(&app, &char_id) {
        return Ok(empty("error", Some("window_open")));
    }
    let cfg = json!({ "mode": "history" });
    let timeout = timeout_seconds.unwrap_or(25).max(5);
    let res = read_page(
        &app,
        &char_id,
        HISTORY_URL,
        &cfg,
        timeout,
        close_after.unwrap_or(true),
    )
    .await?;
    Ok(match classify_history(res) {
        Ok(data) => json!({
            "charId": char_id, "status": "ok", "error": Value::Null,
            "account": data["account"], "rows": data["rows"],
        }),
        Err((status, error)) => empty(status, Some(error.as_str())),
    })
}

/// Одна покупка. Результат: `{ charId, item, status, error, detail, clicked, dryRun, account,
/// balanceBefore, balanceAfter, items, history, info }`.
/// `status`: `success` | `dry_run` | `limit_reached` | `no_funds` | `price_changed` | `item_missing`
/// | `no_effect` | `unknown` | `not_logged_in` | `challenge` | `error`.
/// `clicked = true` — кнопка нажата, команду для этой покупки повторять нельзя.
#[command]
pub async fn buy_shop_item(
    app: AppHandle,
    char_id: String,
    item: String,
    expect_price: f64,
    wanted: Option<Vec<String>>,
    dry_run: Option<bool>,
    timeout_seconds: Option<u64>,
) -> Result<Value, String> {
    let dry = dry_run.unwrap_or(false);
    let fail = |error: &str| buy_payload(&char_id, &item, "error", Some(error), None, false, dry);
    if !is_valid_char_id(&char_id) {
        return Ok(fail("bad_char"));
    }
    if !is_valid_item_name(&item) {
        return Ok(fail("bad_item"));
    }
    if !is_valid_price(expect_price) {
        return Ok(fail("bad_price"));
    }
    // В окне, где пользователь сейчас вводит логин, задачу не запускаем: оно бы перешло на другую страницу
    if window_is_open(&app, &char_id) {
        return Ok(fail("window_open"));
    }

    let mut names = clean_wanted(&wanted.unwrap_or_default());
    if !names.contains(&item) {
        names.push(item.clone());
    }
    let scope = format!("char:{}", char_id);
    let timeout = timeout_seconds.unwrap_or(25).max(5);
    let task = pool::acquire(&app, &char_id, SHOP_URL).await?;
    tf_log(&app, &scope, "info", task.describe());
    navigate_clean(task.window(), SHOP_URL).await?;

    // 1. Осмотр страницы (только чтение)
    let inspect_cfg = json!({
        "mode": "inspect", "wanted": names, "target": item, "expectPrice": expect_price
    });
    let inspect = eval_and_wait(
        task.window(),
        &shop_script(&inspect_cfg),
        PREFIX,
        timeout,
        &scope,
    )
    .await;
    let ready = match classify_inspect(inspect) {
        Ok(ready) => ready,
        Err(refusal) => {
            tf_log(
                &app,
                &scope,
                "warn",
                format!("Покупка «{}» не начата: {}", item, refusal.status),
            );
            // Вход на сайте был, если страница отвечала не «нет входа» и не «проверка безопасности»
            let logged_in = !matches!(refusal.status, "not_logged_in" | "challenge")
                && refusal.error.as_deref() != Some("timeout");
            task.finish(Some(&char_id), true, logged_in).await;
            let mut res = buy_payload(
                &char_id,
                &item,
                refusal.status,
                refusal.error.as_deref(),
                None,
                false,
                dry,
            );
            res["info"] = refusal.info;
            return Ok(res);
        }
    };
    let balance_before = ready["balance"].as_f64().unwrap_or(0.0);
    let price = ready["item"]["price"].as_f64().unwrap_or(expect_price);
    let sig = ready["sig"].as_str().unwrap_or("").to_string();
    let account = ready["account"].clone();

    if dry {
        let label = ready["label"].as_str().unwrap_or("").to_string();
        tf_log(
            &app,
            &scope,
            "info",
            format!("Пробный запуск: найдена кнопка «{}», она не нажата", label),
        );
        task.finish(Some(&char_id), true, true).await;
        let mut res = buy_payload(&char_id, &item, "dry_run", None, Some(label), false, true);
        res["account"] = account;
        res["balanceBefore"] = json!(balance_before);
        res["info"] = ready["item"].clone();
        return Ok(res);
    }

    // 2. Нажатие: строго один раз, без повторов
    tf_log(
        &app,
        &scope,
        "step",
        format!("Покупаю «{}» за {}", item, price),
    );
    let click_cfg = json!({
        "mode": "click", "wanted": names, "target": item, "expectPrice": expect_price
    });
    if task
        .window()
        .eval(with_common(&shop_script(&click_cfg)))
        .is_err()
    {
        task.finish(Some(&char_id), true, true).await;
        return Ok(fail("click_failed"));
    }
    tokio::time::sleep(Duration::from_millis(1200)).await;
    // Скрипт отвечает только отказом (нет окна подтверждения, другое название): тогда ничего не куплено
    if let Ok(now) = task.window().url() {
        if let Some((Some(err), data)) = read_hash_payload(now.as_str(), PREFIX) {
            tf_log(
                &app,
                &scope,
                "warn",
                format!("Покупка не выполнена: {}", err),
            );
            task.finish(Some(&char_id), true, true).await;
            let mut res = buy_payload(
                &char_id,
                &item,
                "error",
                Some(err.as_str()),
                None,
                false,
                false,
            );
            res["info"] = data;
            return Ok(res);
        }
    }

    // 3. Страница после покупки (только чтение); если она не распознана, магазин открывается заново
    let after_cfg = json!({
        "mode": "after", "wanted": names, "target": item, "baseline": sig
    });
    let after = eval_and_wait(
        task.window(),
        &shop_script(&after_cfg),
        PREFIX,
        timeout,
        &scope,
    )
    .await;
    let (page, note) = match classify_after(after) {
        After::Page(data) => (Some(data), None),
        After::Recheck(note) => {
            tf_log(
                &app,
                &scope,
                "info",
                "Страница после покупки не распознана, перечитываю магазин",
            );
            let mut page = None;
            if navigate_clean(task.window(), SHOP_URL).await.is_ok() {
                let scan_cfg = json!({ "mode": "scan", "wanted": names });
                let scan = eval_and_wait(
                    task.window(),
                    &shop_script(&scan_cfg),
                    PREFIX,
                    timeout,
                    &scope,
                )
                .await;
                page = classify_scan(scan).ok();
            }
            (page, note)
        }
    };

    let (status, error, detail): (&str, Option<String>, Option<String>) = match &page {
        Some(data) => match verify_purchase(balance_before, price, data) {
            Verdict::Bought => ("success", None, None),
            Verdict::NoEffect => ("no_effect", None, note),
            Verdict::Unclear(why) => ("unknown", None, Some(why)),
        },
        None => ("unknown", Some("timeout".to_string()), note),
    };

    // 4. Неясный исход: «История монет» нужна для сверки (приложение само ничего не повторяет)
    let mut history = Value::Null;
    if status == "unknown" && navigate_clean(task.window(), HISTORY_URL).await.is_ok() {
        let history_cfg = json!({ "mode": "history" });
        let res = eval_and_wait(
            task.window(),
            &shop_script(&history_cfg),
            PREFIX,
            timeout.min(15),
            &scope,
        )
        .await;
        if let Ok(data) = classify_history(res) {
            history = data["rows"].clone();
        }
    }
    tf_log(
        &app,
        &scope,
        if status == "success" { "ok" } else { "warn" },
        format!("Ответ сайта: {}", status),
    );
    task.finish(Some(&char_id), true, true).await;

    let mut res = buy_payload(
        &char_id,
        &item,
        status,
        error.as_deref(),
        detail,
        true,
        false,
    );
    res["account"] = account;
    res["balanceBefore"] = json!(balance_before);
    if let Some(data) = &page {
        res["balanceAfter"] = data["balance"].clone();
        res["items"] = data["items"].clone();
    }
    res["history"] = history;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(data: Value) -> Wait {
        Some((None, data))
    }
    fn err(e: &str, data: Value) -> Wait {
        Some((Some(e.to_string()), data))
    }

    #[test]
    fn item_names_are_restricted() {
        for good in [
            "Камень светлого духа",
            "Знак доблести (25 штук)",
            "Ключ от Книги наставлений",
        ] {
            assert!(is_valid_item_name(good), "{good}");
        }
        for bad in [
            "",
            "а",
            "x\ny",
            "<script>",
            "a/b",
            "Камень;",
            &"А".repeat(81),
        ] {
            assert!(!is_valid_item_name(bad), "{bad}");
        }
    }

    #[test]
    fn price_must_be_positive_and_finite() {
        assert!(is_valid_price(40.0));
        assert!(is_valid_price(2.5));
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY, 100_000.0] {
            assert!(!is_valid_price(bad), "{bad}");
        }
    }

    #[test]
    fn wanted_list_is_cleaned() {
        let list = vec![
            " Камень лагеря ".to_string(),
            "Камень лагеря".to_string(),
            "<bad>".to_string(),
            "Камень государя".to_string(),
        ];
        assert_eq!(
            clean_wanted(&list),
            vec!["Камень лагеря".to_string(), "Камень государя".to_string()]
        );
        let many: Vec<String> = (0..40).map(|i| format!("Предмет {i}")).collect();
        assert_eq!(clean_wanted(&many).len(), MAX_WANTED);
    }

    #[test]
    fn scan_returns_data_or_final_error() {
        let data = json!({ "state": "scan", "balance": 54, "items": [] });
        assert_eq!(classify_scan(ok(data.clone())), Ok(data));
        assert_eq!(classify_scan(None), Err(("error", "timeout".to_string())));
        assert_eq!(
            classify_scan(ok(json!({ "state": "other" }))),
            Err(("error", "bad_response".to_string()))
        );
        assert_eq!(
            classify_scan(err("not_logged_in", Value::Null))
                .unwrap_err()
                .0,
            "not_logged_in"
        );
        assert_eq!(
            classify_scan(err("challenge", Value::Null)).unwrap_err().0,
            "challenge"
        );
        assert_eq!(
            classify_scan(err("container_missing", Value::Null)),
            Err(("error", "container_missing".to_string()))
        );
    }

    #[test]
    fn history_returns_rows_or_final_error() {
        let data = json!({ "state": "history", "rows": [{ "at": "2026-10-07 01:11" }] });
        assert_eq!(classify_history(ok(data.clone())), Ok(data));
        assert_eq!(
            classify_history(err("pending", json!("complete"))),
            Err(("error", "pending".to_string()))
        );
    }

    #[test]
    fn inspect_ready_allows_buying() {
        let data = json!({ "state": "ready", "balance": 54, "sig": "1", "item": { "price": 40 } });
        assert_eq!(classify_inspect(ok(data.clone())), Ok(data));
    }

    #[test]
    fn inspect_refusals_map_to_statuses_and_keep_page_data() {
        let r = classify_inspect(err("limit_reached", json!({ "available": 0 }))).unwrap_err();
        assert_eq!(r.status, "limit_reached");
        assert_eq!(r.info["available"], 0);
        assert_eq!(r.error, None);
        let r = classify_inspect(err("price_changed", json!({ "price": 45 }))).unwrap_err();
        assert_eq!(
            (r.status, r.info["price"].clone()),
            ("price_changed", json!(45))
        );
        let r = classify_inspect(err("no_funds", json!({ "balance": 39 }))).unwrap_err();
        assert_eq!(r.status, "no_funds");
        for (e, s) in [
            ("item_missing", "item_missing"),
            ("not_logged_in", "not_logged_in"),
            ("challenge", "challenge"),
        ] {
            assert_eq!(classify_inspect(err(e, Value::Null)).unwrap_err().status, s);
        }
    }

    #[test]
    fn inspect_unknown_failures_are_errors_never_ready() {
        for e in [
            "button_not_found",
            "price_unreadable",
            "pending",
            "exception_x",
        ] {
            let r = classify_inspect(err(e, Value::Null)).unwrap_err();
            assert_eq!((r.status, r.error.as_deref()), ("error", Some(e)));
        }
        assert_eq!(
            classify_inspect(None).unwrap_err().error.as_deref(),
            Some("timeout")
        );
        assert_eq!(
            classify_inspect(ok(json!({ "state": "scan" })))
                .unwrap_err()
                .error
                .as_deref(),
            Some("bad_response")
        );
    }

    #[test]
    fn after_page_is_used_only_when_it_is_the_shop() {
        let page = json!({ "state": "scan", "balance": 14 });
        assert_eq!(classify_after(ok(page.clone())), After::Page(page));
        assert_eq!(
            classify_after(err("other_page", json!("Покупка выполнена"))),
            After::Recheck(Some("Покупка выполнена".to_string()))
        );
        // страница не изменилась или сайт не ответил — магазин перечитывается
        assert_eq!(
            classify_after(err("pending", json!("complete"))),
            After::Recheck(None)
        );
        assert_eq!(classify_after(None), After::Recheck(None));
    }

    #[test]
    fn purchase_is_success_only_when_balance_dropped_by_price() {
        let after = |b: f64| json!({ "balance": b });
        assert_eq!(verify_purchase(54.0, 40.0, &after(14.0)), Verdict::Bought);
        assert_eq!(verify_purchase(28.5, 2.5, &after(26.0)), Verdict::Bought);
        assert_eq!(verify_purchase(54.0, 40.0, &after(54.0)), Verdict::NoEffect);
        assert!(matches!(
            verify_purchase(54.0, 40.0, &after(4.0)),
            Verdict::Unclear(_)
        ));
        assert!(matches!(
            verify_purchase(54.0, 40.0, &json!({})),
            Verdict::Unclear(_)
        ));
    }

    #[test]
    fn logged_in_flag_follows_page_answer() {
        assert!(page_was_logged_in(&ok(json!({}))));
        assert!(page_was_logged_in(&err("pending", Value::Null)));
        assert!(!page_was_logged_in(&None));
        assert!(!page_was_logged_in(&err("not_logged_in", Value::Null)));
        assert!(!page_was_logged_in(&err("challenge", Value::Null)));
    }

    #[test]
    fn script_gets_mode_and_embedded_script() {
        let s = shop_script(&json!({ "mode": "click", "target": "Камень лагеря" }));
        assert!(s.starts_with("window.__TF_SHOP = {"));
        assert!(s.contains("\"mode\":\"click\""));
        assert!(s.contains("TF_SHOP_V1_"));
    }

    #[test]
    fn payload_has_all_fields() {
        let p = buy_payload("a", "b", "success", None, None, true, false);
        for key in [
            "charId",
            "item",
            "status",
            "error",
            "detail",
            "clicked",
            "dryRun",
            "account",
            "balanceBefore",
            "balanceAfter",
            "items",
            "history",
            "info",
        ] {
            assert!(p.get(key).is_some(), "{key}");
        }
    }
}
