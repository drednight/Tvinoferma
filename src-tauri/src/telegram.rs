//! Отправка сообщений в Telegram через Bot API.
//!
//! Токен бота читается из хранилища ОС (как контакты персонажей), поэтому он
//! не попадает в state.json, бэкапы или логи. Сообщение передаётся из JS как
//! обычный текст: CSP приложения не распространяется на запрос из Rust-команды.

use std::time::Duration;

use serde_json::json;
use tauri::command;

const BOT_TOKEN_KEY: &str = "telegram.botToken";
const API_BASE: &str = "https://api.telegram.org";

/// Они же «оптимизация»: описание, которое летит в Telegram вместе с текстом
/// пользователя, чтобы автор видел контекст — без конфиденциальных данных.
fn diagnostics_block() -> String {
    let mut lines = String::from("—— Диагностика приложения ——\n");
    lines.push_str(&format!("Версия: {}\n", env!("CARGO_PKG_VERSION")));
    lines.push_str(&format!("ОС: {}\n", std::env::consts::OS));
    if let Ok(dir) = std::env::var("TVINOFERMA_DATA_DIR") {
        lines.push_str(&format!("Каталог данных: {dir}\n"));
    }
    lines
}

/// Отправляет сообщение в Telegram через бота.
///
/// Токен бота читается из хранилища ОС по ключу `telegram.botToken`; если его
/// нет — ошибка без повторного ввода. Ответ API проверяем по `ok` и описанию.
#[command]
pub async fn telegram_send_message(
    chat_id: String,
    text: String,
    with_diagnostics: Option<bool>,
) -> Result<serde_json::Value, String> {
    let chat_id = chat_id.trim().to_string();
    if chat_id.is_empty() {
        return Err("Чат для отправки не задан: укажите id канала или чата в настройках.".into());
    }
    let token = crate::commands::secrets::read_secret(BOT_TOKEN_KEY)?
        .unwrap_or_default();
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(
            "Токен бота Telegram не задан: сохраните его в настройках раздела «Предложения»."
                .into(),
        );
    }
    let mut message = text.trim().to_string();
    if message.is_empty() {
        return Err("Сообщение пусто: напишите текст для отправки.".into());
    }
    if with_diagnostics.unwrap_or(false) {
        message.push('\n');
        message.push_str(&diagnostics_block());
    }
    // Telegram ограничивает длину сообщения: обрезаем со знаком обрезки
    const MAX_LEN: usize = 4096;
    if message.chars().count() > MAX_LEN {
        let head: String = message.chars().take(MAX_LEN - 20).collect();
        message = format!("{head}\n…(сообщение обрезано, было больше {MAX_LEN} символов)");
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "Tvinoferma/",
            env!("CARGO_PKG_VERSION"),
            " (telegram-bot)"
        ))
        .tls_backend_rustls()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "telegram_client".to_string())?;

    let url = format!("{API_BASE}/bot{token}/sendMessage");
    let response = client
        .post(&url)
        .json(&json!({ "chat_id": chat_id, "text": message }))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "telegram_timeout".to_string()
            } else {
                format!("telegram_network: {e}")
            }
        })?;

    let status = response.status().as_u16();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("telegram_bad_response: {e}"))?;

    if status != 200 || body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let description = body
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("неизвестная ошибка");
        return Err(format!("Telegram не принял сообщение (HTTP {status}): {description}"));
    }

    Ok(json!({
        "ok": true,
        "messageId": body.get("result").and_then(|r| r.get("message_id")),
        "chatId": chat_id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_block_has_version_and_os() {
        let block = diagnostics_block();
        assert!(block.contains("Версия"));
        assert!(block.contains("ОС"));
    }
}
