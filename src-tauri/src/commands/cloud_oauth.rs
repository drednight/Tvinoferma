//! IPC-обёртка локального callback для диагностики и первого входа OAuth.
//! Сам callback не обменивает и не хранит токены и не передаёт файлы.

use crate::cloud_oauth_callback::{CallbackRegistry, CallbackStatus};
use serde::Serialize;
use std::sync::OnceLock;

static CALLBACK: OnceLock<CallbackRegistry> = OnceLock::new();

fn registry() -> &'static CallbackRegistry {
    CALLBACK.get_or_init(CallbackRegistry::default)
}

fn check_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Авторизация доступна только в главном окне".into());
    }
    Ok(())
}

#[derive(Serialize)]
pub struct CloudOAuthStart {
    port: u16,
}

#[derive(Serialize)]
pub struct CloudOAuthPoll {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

#[tauri::command]
pub fn cloud_oauth_callback_begin(
    window: tauri::WebviewWindow,
    provider: String,
    port: u16,
    state: String,
    handle: String,
) -> Result<CloudOAuthStart, String> {
    check_window(&window)?;
    let port = registry().begin(&provider, port, state, handle)?;
    Ok(CloudOAuthStart { port })
}

#[tauri::command]
pub fn cloud_oauth_callback_poll(
    window: tauri::WebviewWindow,
    handle: String,
) -> Result<CloudOAuthPoll, String> {
    check_window(&window)?;
    let (status, code) = match registry().poll(&handle)? {
        CallbackStatus::Pending => ("pending", None),
        CallbackStatus::Code(code) => ("code", Some(code)),
        CallbackStatus::Denied => ("denied", None),
        CallbackStatus::Error => ("error", None),
        CallbackStatus::Expired => ("expired", None),
        CallbackStatus::Cancelled => ("cancelled", None),
        CallbackStatus::Consumed => ("consumed", None),
    };
    Ok(CloudOAuthPoll { status, code })
}

#[tauri::command]
pub fn cloud_oauth_callback_cancel(
    window: tauri::WebviewWindow,
    handle: String,
) -> Result<(), String> {
    check_window(&window)?;
    registry().cancel(&handle)
}
