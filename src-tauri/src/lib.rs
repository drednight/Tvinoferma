// src-tauri/src/lib.rs

use tauri::{command, AppHandle, Manager}; // Импорт базовых типов

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        // ВАЖНО: Никаких .plugin(tauri_plugin_webview...) здесь быть не должно!
        
        .setup(|_app| {
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_pw_window]) // Регистрируем нашу команду
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Наша команда для открытия окна
#[command]
async fn open_pw_window(app: AppHandle, url: String) -> Result<String, String> {
    let label = format!("pw-sync-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis());

    // Создаем новое окно с внешним URL
    let _window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url.parse().unwrap()))
        .title("PW Online Sync")
        .inner_size(800.0, 600.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(label)
}

#[command]
async fn eval_in_window(app: AppHandle, label: String, script: String) -> Result<serde_json::Value, String> {
    // Находим окно по лейблу
    if let Some(window) = app.get_webview_window(&label) {
        // Выполняем JS и получаем результат
        // Примечание: eval() возвращает () , чтобы получить значение, нужно использовать evaluate_script 
        // или обернуть код так, чтобы он возвращал JSON string, которую мы распарсим.
        
        // В Tauri v2 стандартный способ выполнить скрипт и вернуть результат:
        let result = window.eval(&script).map_err(|e| e.to_string())?;
        
        // eval() обычно ничего не возвращает напрямую в Rust как serde_json::Value
        // Для получения данных лучше использовать канал событий или возвращать данные через localStorage/window.__TAURI__
        // Но для простоты MVP можно попробовать использовать метод, если он доступен, 
        // либо пересылать данные через emit_to.
        
        // БОЛЕЕ НАДЕЖНЫЙ СПОСОБ ДЛЯ MVP:
        // Мы будем инжектить скрипт, который сам отправит данные обратно в главное окно через событие.
        return Ok(serde_json::json!({ "status": "injected" }));
    } else {
        Err(format!("Window {} not found", label))
    }
}