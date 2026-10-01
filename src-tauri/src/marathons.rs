//! Марафоны: прогресс персонажа, поиск марафонов на сайте, разбор страницы и новости.

use crate::parsers::{eval_and_wait, navigate_clean, tf_log};
use crate::pool;
use tauri::{command, AppHandle, Emitter};

const PROGRESS_SCRIPT: &str = include_str!("scripts/marathon_progress.js");
const TITLES_SCRIPT: &str = include_str!("scripts/marathon_titles.js");
const DETAIL_SCRIPT: &str = include_str!("scripts/marathon_detail.js");
const NEWS_SCRIPT: &str = include_str!("scripts/marathon_news.js");

const DEFAULT_PAGES: [&str; 2] = [
    "https://pwonline.ru/supermarathon.php",
    "https://pwonline.ru/supermarathon2.php",
];

/// ПАРСЕР МАРАФОНА v2: прогресс персонажа по всем заданиям страницы марафона
#[command]
pub async fn fetch_marathon_progress_v1(
    app: AppHandle,
    char_id: String,
    marathon_url: Option<String>,
    close_after: Option<bool>,
) -> Result<(), String> {
    let target = marathon_url.unwrap_or_else(|| DEFAULT_PAGES[0].to_string());
    let scope = format!("char:{}", char_id);
    let task = pool::acquire(&app, &char_id, &target).await?;
    tf_log(&app, &scope, "info", task.describe());

    // Всегда переходим на страницу марафона: окно могло остаться на другой странице
    navigate_clean(task.window(), &target).await?;
    let result = eval_and_wait(task.window(), PROGRESS_SCRIPT, "#TF_MARATHON_DATA_", 25, &scope).await;
    let ok = matches!(&result, Some((None, _)));
    task.finish(Some(&char_id), close_after.unwrap_or(false), ok).await;

    let payload = match result {
        Some((error, data)) => serde_json::json!({ "charId": char_id, "quests": data, "error": error }),
        None => serde_json::json!({ "charId": char_id, "quests": [], "error": "timeout_parsing_marathon" }),
    };
    println!("[MARATHON-PARSER] {} -> error: {:?}", char_id, payload["error"]);
    let _ = app.emit("marathon-progress-result-global", payload);
    Ok(())
}

/// СКАН НАЗВАНИЙ МАРАФОНОВ (v5): использует профиль авторизованного персонажа (char_id)
#[command]
pub async fn get_available_marathon_titles(
    app: AppHandle,
    char_id: Option<String>,
    extra_urls: Option<Vec<String>>,
) -> Result<(), String> {
    let mut urls: Vec<String> = DEFAULT_PAGES.iter().map(|s| s.to_string()).collect();
    for u in extra_urls.unwrap_or_default() {
        if u.starts_with("http") && !urls.contains(&u) {
            urls.push(u);
        }
    }
    let _ = app.emit("scan-progress-update", serde_json::json!({ "percent": 0, "message": "Подготовка..." }));

    let task = pool::acquire_for_scan(&app, char_id, &urls[0], "_title_scanner_v4_").await?;
    let window = task.window().clone();
    tf_log(&app, "scan", "info", task.describe());

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for (index, url) in urls.iter().enumerate() {
        let percent = ((index as f64 / urls.len() as f64) * 100.0) as u8;
        let _ = app.emit("scan-progress-update", serde_json::json!({
            "percent": percent,
            "message": format!("Проверка: {}", url.split('/').last().unwrap_or(""))
        }));
        tf_log(&app, "scan", "step", format!("Открываю {}", url));

        if let Err(e) = navigate_clean(&window, url).await {
            errors.push(format!("bad_url: {} ({})", url, e));
            continue;
        }
        match eval_and_wait(&window, TITLES_SCRIPT, "#TF_TITLE_V4_", 20, "scan").await {
            Some((None, data)) => results.push(data),
            Some((Some(err), _)) => errors.push(err),
            None => errors.push("timeout".to_string()),
        }
    }

    let _ = app.emit("scan-progress-update", serde_json::json!({ "percent": 100, "message": "Готово" }));
    task.finish(None, true, false).await;

    let _ = app.emit("marathon-titles-scanned-global", serde_json::json!({
        "titles": results,
        "count": results.len(),
        "errors": errors
    }));
    Ok(())
}

/// ДЕТАЛЬНЫЙ ПАРСИНГ СТРАНИЦЫ МАРАФОНА (v5): этапы + задания
#[command]
pub async fn parse_specific_marathon_page(app: AppHandle, url: String, char_id: Option<String>) -> Result<(), String> {
    let task = pool::acquire_for_scan(&app, char_id, &url, "_detail_parser_v4_").await?;
    tf_log(&app, "detail", "info", task.describe());

    navigate_clean(task.window(), &url).await?;
    let result = eval_and_wait(task.window(), DETAIL_SCRIPT, "#TF_DETAIL_V4_", 25, "detail").await;
    task.finish(None, true, false).await;

    let payload = match result {
        Some((None, data)) => serde_json::json!({ "marathon": data, "error": null }),
        Some((Some(err), _)) => serde_json::json!({ "marathon": null, "error": err }),
        None => serde_json::json!({ "marathon": null, "error": "timeout_parsing_details" }),
    };
    let _ = app.emit("single-marathon-parsed-global", payload);
    Ok(())
}

/// НОВОСТЬ О МАРАФОНЕ: возвращает очищенный HTML статьи (news.php?article=…),
/// разбор этапов, заданий и наград выполняется в интерфейсе (js/marathons/newsParser.js).
#[command]
pub async fn fetch_marathon_news(app: AppHandle, url: String, char_id: Option<String>) -> Result<(), String> {
    tf_log(&app, "news", "step", format!("Открываю новость {}", url));
    let task = pool::acquire_for_scan(&app, char_id, &url, "_news_reader_").await?;
    navigate_clean(task.window(), &url).await?;

    let result = eval_and_wait(task.window(), NEWS_SCRIPT, "#TF_NEWS_V1_", 25, "news").await;
    task.finish(None, true, false).await;

    let payload = match result {
        Some((None, data)) => serde_json::json!({ "news": data, "error": null }),
        Some((Some(err), _)) => serde_json::json!({ "news": null, "error": err }),
        None => serde_json::json!({ "news": null, "error": "timeout" }),
    };
    let _ = app.emit("marathon-news-parsed-global", payload);
    Ok(())
}
