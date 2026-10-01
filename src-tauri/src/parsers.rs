//! Общая инфраструктура парсеров: журнал шагов, ожидание ответа скрипта в hash,
//! обработка «Проверки безопасности» сайта.

use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewWindow};

/// Шаг для журнала задач в интерфейсе (событие `tf-task-log`, scope = `char:<id>` | `scan` | `detail` | `news`).
pub fn tf_log(app: &AppHandle, scope: &str, level: &str, message: impl Into<String>) {
    let message: String = message.into();
    println!("[{}] {}: {}", scope, level, message);
    let _ = app.emit(
        "tf-task-log",
        serde_json::json!({ "scope": scope, "level": level, "message": message }),
    );
}

/// Убирает hash прошлого ответа и переходит на страницу.
/// Без очистки `window.url()` сразу после `navigate` может вернуть старый адрес
/// с результатом предыдущей проверки.
pub async fn navigate_clean(window: &WebviewWindow, url: &str) -> Result<(), String> {
    let _ = window.eval("history.replaceState(null, '', location.pathname + location.search);");
    let target = Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    window.navigate(target).map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    Ok(())
}

/// Читает результат парсера из hash вида `#PREFIX<encodeURIComponent(JSON)>`,
/// где JSON = { "data": ..., "error": string|null }.
pub fn read_hash_payload(url_str: &str, prefix: &str) -> Option<(Option<String>, serde_json::Value)> {
    let pos = url_str.find(prefix)?;
    let encoded = &url_str[pos + prefix.len()..];
    let decoded = urlencoding::decode(encoded).ok()?;
    let value: serde_json::Value = serde_json::from_str(&decoded).ok()?;
    let error = value.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
    let data = value.get("data").cloned().unwrap_or(serde_json::Value::Null);
    Some((error, data))
}

/// Выполняет скрипт парсера и ждёт ответ в hash (`#PREFIX<json>`).
/// Пока сайт показывает «Проверку безопасности» (error = "challenge"), страница
/// ещё не дорисована (error = "pending") или перезагружается — повторяет скрипт.
/// Возвращает None по таймауту.
pub async fn eval_and_wait(
    window: &WebviewWindow,
    script: &str,
    prefix: &str,
    timeout_secs: u64,
    scope: &str,
) -> Option<(Option<String>, serde_json::Value)> {
    let app = window.app_handle().clone();
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_eval: Option<Instant> = None;
    let mut challenge_logged = false;
    tf_log(&app, scope, "info", format!("Жду загрузки страницы и ответа парсера (до {} с)…", timeout_secs));

    while Instant::now() < deadline {
        let need_eval = last_eval.map(|t| t.elapsed() >= Duration::from_millis(1500)).unwrap_or(true);
        if need_eval {
            let _ = window.eval(script);
            last_eval = Some(Instant::now());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;

        let Ok(url) = window.url() else { continue };
        let Some((error, data)) = read_hash_payload(url.as_str(), prefix) else { continue };
        match error.as_deref() {
            Some("challenge") => {
                if !challenge_logged {
                    tf_log(&app, scope, "warn", "Сайт показывает «Проверку безопасности» — жду, пока она пройдёт…");
                    challenge_logged = true;
                }
            }
            Some("pending") => {}
            _ => return Some((error, data)),
        }
        // Убираем hash, чтобы не прочитать его повторно, и ждём
        let _ = window.eval("history.replaceState(null, '', location.pathname + location.search);");
    }
    tf_log(&app, scope, "error", format!("Страница не ответила за {} с", timeout_secs));
    None
}

#[cfg(test)]
mod tests {
    use super::read_hash_payload;

    #[test]
    fn reads_payload_from_hash() {
        let url = "https://pwonline.ru/x.php#TF_X_%7B%22data%22%3A5%2C%22error%22%3Anull%7D";
        let (err, data) = read_hash_payload(url, "#TF_X_").unwrap();
        assert!(err.is_none());
        assert_eq!(data, serde_json::json!(5));
    }

    #[test]
    fn reads_error_and_ignores_other_prefix() {
        let url = "https://pwonline.ru/x.php#TF_X_%7B%22data%22%3Anull%2C%22error%22%3A%22challenge%22%7D";
        assert_eq!(read_hash_payload(url, "#TF_X_").unwrap().0.as_deref(), Some("challenge"));
        assert!(read_hash_payload(url, "#TF_Y_").is_none());
    }
}
