// src-tauri/src/lib.rs

use tauri::{command, AppHandle, Manager, Url};
use tauri_utils::config::WebviewUrl;
use std::str::FromStr;
use std::path::PathBuf;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        
        .invoke_handler(tauri::generate_handler![
            open_sync_window, 
            close_sync_window,
            execute_script_in_window,
            check_window_exists,
            // Новые команды для навигации
            navigate_to_url,
            go_back,
            go_forward,
            reload_page,
            inject_nav_bar // Специальная команда для быстрого инжекта
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Открывает окно синхронизации для персонажа С ИЗОЛЯЦИЕЙ ДАННЫХ
#[command]
async fn open_sync_window(app: AppHandle, char_id: String, url: String) -> Result<String, String> {
    let label = format!("sync-win-{}", char_id);
    
    if let Some(win) = app.get_webview_window(&label) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(label);
    }

    let parsed_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let profiles_dir = app_data_dir.join("pw-sync-profiles").join(&char_id);
    std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

    let _window = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .title(format!("PW Sync: {}", char_id))
        .inner_size(900.0, 700.0)
        .resizable(true)
        .data_directory(profiles_dir) 
        .build()
        .map_err(|e| e.to_string())?;

    Ok(label)
}

#[command]
async fn close_sync_window(app: AppHandle, char_id: String) -> Result<(), String> {
    let label = format!("sync-win-{}", char_id);
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
fn check_window_exists(app: AppHandle, label: String) -> bool {
    app.get_webview_window(&label).is_some()
}

#[command]
async fn execute_script_in_window(app: AppHandle, label: String, script: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.eval(&script).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Window {} not found", label))
    }
}

// --- НАВИГАЦИЯ ---

#[command]
async fn navigate_to_url(app: AppHandle, label: String, url: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        let parsed_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;
        window.navigate(parsed_url).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[command]
async fn go_back(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        // Используем JS history.back(), так как нативного метода может не быть
        window.eval("history.back();").map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[command]
async fn go_forward(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.eval("history.forward();").map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[command]
async fn reload_page(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.eval("location.reload();").map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Window {} not found", label))
    }
}

/// Быстрая команда для инжекта панели навигации
#[command]
async fn inject_nav_bar(app: AppHandle, label: String, char_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        let script = format!(r#"
            (function() {{
                const PANEL_ID = 'twinoferma-nav-panel-top';
                
                // Удаляем старую панель, если есть
                const oldPanel = document.getElementById(PANEL_ID);
                if (oldPanel) oldPanel.remove();

                // Создаем стили
                if (!document.getElementById('twinoferma-nav-styles')) {{
                    const style = document.createElement('style');
                    style.id = 'twinoferma-nav-styles';
                    style.innerHTML = `
                        #${{PANEL_ID}} {{
                            position: fixed; top: 0; left: 0; right: 0;
                            background: rgba(20, 20, 30, 0.98); border-bottom: 1px solid #444;
                            padding: 8px 15px; display: flex; justify-content: center; align-items: center;
                            gap: 10px; z-index: 999999; font-family: sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,0.5); height: 40px;
                        }}
                        body {{ margin-top: 40px !important; }}
                        .tf-nav-btn {{ background: #333; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; transition: background 0.2s; white-space: nowrap; }}
                        .tf-nav-btn:hover {{ background: #555; }}
                        .tf-separator {{ width: 1px; height: 20px; background: #555; margin: 0 5px; }}
                    `;
                    document.head.appendChild(style);
                }}

                const panel = document.createElement('div');
                panel.id = PANEL_ID;
                
                panel.innerHTML = `
                    <button class="tf-nav-btn" onclick="history.back()" title="Назад">⬅️</button>
                    <button class="tf-nav-btn" onclick="history.forward()" title="Вперед">➡️</button>
                    <button class="tf-nav-btn" onclick="location.reload()" title="Обновить">🔄</button>
                    <div class="tf-separator"></div>
                    <button class="tf-nav-btn" onclick="window.location.href='https://pwonline.ru/'" title="Главная">🏠 PW</button>
                    <button class="tf-nav-btn" onclick="window.location.href='https://pwonline.ru/chests2.php'" title="Монеты">💰 Монеты</button>
                    <button class="tf-nav-btn" onclick="window.location.href='https://pwonline.ru/supermarathon2.php'" title="Марафон">🏃 Марафон</button>
                    <div class="tf-separator"></div>
                    <button class="tf-nav-btn" style="background:#d32f2f;" onclick="window.__TAURI__.event.emit('close-window-request', {{label: '{label}'}})" title="Закрыть окно">❌ Закрыть</button>
                `;

                document.body.prepend(panel);
            }})();
        "#, label = label);

        window.eval(&script).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Window {} not found", label))
    }
}