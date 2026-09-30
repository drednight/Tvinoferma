use tauri::{command, AppHandle, Manager, Url};
use tauri_utils::config::WebviewUrl;
use std::str::FromStr;
use tauri::WindowEvent; 
use tauri::Emitter; 

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        
        // Глобальный обработчик событий окон (закрытие)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let label = window.label();
                if label.starts_with("sync-win-") || label.starts_with("popup-sync-win-") {
                    println!("[RUST EVENT] Browser window closed: {}", label);
                    let _ = window.app_handle().emit_to(
                        "main", 
                        "browser-window-closed", 
                        serde_json::json!({ "label": label })
                    );
                }
            }
        })
        
        .invoke_handler(tauri::generate_handler![
            open_sync_window, 
            close_sync_window,
            check_window_exists,
            execute_script_in_window,
            fetch_and_parse_balance_v4,
            check_login_status_http,
            fetch_marathon_progress_v1,
            get_available_marathon_titles,
            parse_specific_marathon_page
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Открывает ВИДИМОЕ окно браузера (для ручного входа/действия)
#[command]
async fn open_sync_window(
    app: AppHandle, 
    char_id: String, 
    url: String,
    char_nick: Option<String>
) -> Result<String, String> {
    let label = format!("sync-win-{}", char_id);
    
    let window_title = match &char_nick {
        Some(nick) => format!("PW Sync: {}", nick),
        None => format!("PW Sync: {}", char_id),
    };

    if let Some(win) = app.get_webview_window(&label) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        let _ = win.set_title(&window_title);
        return Ok(label);
    }

    let parsed_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let profiles_dir = app_data_dir.join("pw-sync-profiles").join(&char_id);
    std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

    let _window = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .title(window_title)
        .inner_size(1200.0, 800.0) 
        .resizable(true)
        .data_directory(profiles_dir) 
        .build()
        .map_err(|e| e.to_string())?;

    // Позиционирование окна
    if let Ok(Some(main_monitor)) = app.primary_monitor() {
        let scale_factor = main_monitor.scale_factor();
        let logical_width = main_monitor.size().width as f64;
        let logical_height = main_monitor.size().height as f64;
        
        let win_width = 1200.0_f64;
        let win_height = 800.0_f64;

        let x_pos = ((logical_width - win_width) / 2.0) + 50.0; 
        let y_pos = (logical_height - win_height) / 2.0;

        if let Some(win) = app.get_webview_window(&label) {
            let physical_x = (x_pos * scale_factor) as i32;
            let physical_y = (y_pos * scale_factor) as i32;
            let _ = win.set_position(tauri::PhysicalPosition::new(physical_x, physical_y));
        }
    }

    // Патч против попапов
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    
    if let Some(win) = app.get_webview_window(&label) {
        let patch_script = r#"
            (function() {
                const originalOpen = window.open;
                window.open = function(url, name, specs) {
                    if (url && typeof url === 'string') {
                        const lowerUrl = url.toLowerCase();
                        if (lowerUrl.includes('vkplay') || lowerUrl.includes('oauth') || lowerUrl.includes('passport') || lowerUrl.includes('/login')) {
                            window.location.href = url;
                            return null;
                        }
                    }
                    try { return originalOpen.call(this, url, name, specs); } catch(e) { return null; }
                };
            })();
        "#;
        win.eval(patch_script).ok();
    }

    Ok(label)
}

/// Закрывает окно браузера по ID персонажа
#[command]
async fn close_sync_window(app: AppHandle, char_id: String) -> Result<(), String> {
    let base_label = format!("sync-win-{}", char_id);
    
    if let Some(win) = app.get_webview_window(&base_label) {
        win.close().map_err(|e| e.to_string())?;
    }
    
    for (_, window) in app.webview_windows() {
        if window.label().starts_with(&format!("popup-{}", base_label)) {
            let _ = window.close();
        }
    }
    
    Ok(())
}

/// Проверяет существование окна по лейблу
#[command]
fn check_window_exists(app: AppHandle, label: String) -> bool {
    app.get_webview_window(&label).is_some()
}

/// Выполняет произвольный JS в указанном окне
#[command]
async fn execute_script_in_window(app: AppHandle, label: String, script: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.eval(&script).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Window {} not found", label))
    }
}

/// БЫСТРАЯ ПРОВЕРКА ЛОГИНА ЧЕРЕЗ СКРЫТОЕ ОКНО
#[command]
async fn check_login_status_http(
    app: AppHandle, 
    char_id: String,
    timeout_seconds: Option<u64>
) -> Result<(), String> {
    let label = format!("sync-win-{}", char_id);
    let wait_time = std::time::Duration::from_secs(timeout_seconds.unwrap_or(5));
    
    println!("[HIDDEN CHECK] Starting status check for {} (Timeout: {:?})", char_id, wait_time);

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let profiles_dir = app_data_dir.join("pw-sync-profiles").join(&char_id);
    std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

    let window = match app.get_webview_window(&label) {
        Some(w) => w,
        None => {
            println!("[HIDDEN CHECK] Creating HIDDEN window...");
            let parsed_url = Url::from_str("https://pwonline.ru/usercp.php").map_err(|e| format!("Invalid URL: {}", e))?;
            
            let _win = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
                .title(format!("Hidden Sync: {}", char_id))
                .inner_size(800.0, 600.0)
                .resizable(false)
                .visible(false) 
                .data_directory(profiles_dir.clone()) 
                .build()
                .map_err(|e| e.to_string())?;
            
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            app.get_webview_window(&label).ok_or("Window creation failed")?
        }
    };

    let target_url = Url::from_str("https://pwonline.ru/usercp.php").unwrap();
    window.navigate(target_url).map_err(|e| e.to_string())?;
    
    tokio::time::sleep(wait_time / 2).await; 

    let checker_script = r#"
        (function() {
            function getResult() {
                const nicknameSpan = document.querySelector('.info__forumname');
                const welcomeText = document.body.innerText.includes("Добро пожаловать");
                if (nicknameSpan && welcomeText) return 'ONLINE';
                const bodyText = document.body.innerText || "";
                if (bodyText.includes("Вы не авторизованы")) return 'OFFLINE';
                return 'UNKNOWN'; 
            }
            let status = getResult();
            if (status === 'UNKNOWN') {
                setTimeout(() => { status = getResult(); finalize(status); }, 1000);
            } else { finalize(status); }
            function finalize(finalStatus) {
                if (finalStatus === 'ONLINE') window.location.hash = 'TF_STATUS_ONLINE';
                else window.location.hash = 'TF_STATUS_OFFLINE';
            }
        })();
    "#;

    window.eval(checker_script).map_err(|e| e.to_string())?;

    let max_attempts = (timeout_seconds.unwrap_or(5) as usize) * 2;
    
    for _ in 0..max_attempts {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(url) = window.url() {
            let url_str = url.as_str();
            if url_str.contains("#TF_STATUS_ONLINE") {
                println!("[HIDDEN CHECK] Result: ONLINE");
                let emit_result = app.emit("login-status-result-global", serde_json::json!({ "charId": char_id, "status": "online" }));
                match emit_result { Ok(_) => {}, Err(e) => println!("[HIDDEN CHECK] Emit Error: {:?}", e) }
                return Ok(());
            }
            if url_str.contains("#TF_STATUS_OFFLINE") {
                println!("[HIDDEN CHECK] Result: OFFLINE");
                let emit_result = app.emit("login-status-result-global", serde_json::json!({ "charId": char_id, "status": "offline" }));
                match emit_result { Ok(_) => {}, Err(e) => println!("[HIDDEN CHECK] Emit Error: {:?}", e) }
                return Ok(());
            }
        }
    }

    println!("[HIDDEN CHECK] Timeout after {:?}, assuming OFFLINE", wait_time);
    let emit_result = app.emit("login-status-result-global", serde_json::json!({ "charId": char_id, "status": "offline" }));
    match emit_result { Ok(_) => {}, Err(e) => println!("[HIDDEN CHECK] Emit Error: {:?}", e) }
    
    Ok(())
}

/// V4 FIX: Парсинг баланса с умной обработкой нуля и проверкой авторизации
#[command]
async fn fetch_and_parse_balance_v4(app: AppHandle, char_id: String) -> Result<(), String> {
    let label = format!("sync-win-{}", char_id);
    println!("==================================================");
    println!("[V4-FIX START] Checking balance for CharID: {}", char_id);

    let window = match app.get_webview_window(&label) {
        Some(w) => w,
        None => {
            println!("[V4-FIX WARN] Creating new window...");
            let _ = open_sync_window(app.clone(), char_id.clone(), "https://pwonline.ru/chests2.php".to_string(), None).await?;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            app.get_webview_window(&label).ok_or("Window creation failed")?
        }
    };

    println!("[V4-FIX ACTION] Navigating to chests2.php...");
    let target_url = Url::from_str("https://pwonline.ru/chests2.php").unwrap();
    window.navigate(target_url).map_err(|e| e.to_string())?;

    println!("[V4-FIX WAIT] Waiting 5 seconds for page load...");
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    let parser_script = r#"
        (function() {
            console.log('[PARSER-V4-SMART] Starting smart parse on chests2.php...');
            function reportResult(balance, errorType) {
                const errStr = errorType ? errorType.toString().replace(/[^a-zA-Z0-9_-]/g, '_') : "null";
                const balStr = (typeof balance === 'number' && !isNaN(balance)) ? balance.toString() : "-1";
                window.location.hash = `TF_BAL_${balStr}_${errStr}`;
            }
            try {
                const pointsInfo = document.querySelector('.points_info');
                const bodyText = document.body.innerText || "";
                const isNotLoggedIn = bodyText.includes("Вы не авторизованы") || bodyText.includes("Для доступа к разделу необходимо войти") || bodyText.includes("Ошибка авторизации") || window.location.href.includes("login.php") || window.location.href.includes("vkplay");
                if (isNotLoggedIn) { reportResult(null, 'not_logged_in'); return; }
                if (!pointsInfo) { reportResult(null, 'container_missing'); return; }
                const strongTag = pointsInfo.querySelector('strong');
                if (!strongTag) { reportResult(null, 'no_value_tag'); return; }
                const text = strongTag.innerText.trim();
                const cleanedText = text.replace(/[^0-9]/g, '');
                const numericValue = parseInt(cleanedText, 10);
                if (isNaN(numericValue)) { reportResult(null, 'parse_nan'); return; }
                if (numericValue === 0) {
                    const userNickElement = document.querySelector('.user-nick, .header-user-name, [class*="username"]');
                    if (!userNickElement) { reportResult(null, 'zero_no_user_session_expired'); } 
                    else { reportResult(0, null); }
                } else { reportResult(numericValue, null); }
            } catch (e) { reportResult(null, 'exception_' + e.message.substring(0, 20)); }
        })();
    "#;

    println!("[V4-FIX INJECT] Injecting smart parser...");
    window.eval(parser_script).map_err(|e| { println!("[V4-FIX ERROR] Eval inject failed: {}", e); e.to_string() })?;

    println!("[V4-FIX LOOP] Polling for results...");
    let mut found_data = false;
    let max_attempts = 20; 
    
    for i in 0..max_attempts {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let current_url_res = window.url(); 
        match current_url_res {
            Ok(current_url) => {
                let url_str = current_url.as_str();
                if url_str.contains("#TF_BAL_") {
                    println!("[V4-FIX SUCCESS] Found data in URL at attempt {}: {}", i+1, url_str);
                    if let Some(pos) = url_str.find("#TF_BAL_") {
                        let content_start = pos + 8; 
                        let content_end = url_str.len();
                        let content = &url_str[content_start..content_end];
                        let parts: Vec<&str> = content.splitn(2, '_').collect();
                        if parts.len() >= 2 {
                            let balance_str = parts[0];
                            let error_raw = parts[1];
                            let balance_opt: Option<i64> = balance_str.parse::<i64>().ok();
                            let final_balance = if balance_opt == Some(-1) { None } else { balance_opt };
                            let error: Option<String> = if error_raw == "null" { None } else { Some(error_raw.to_string()) };
                            println!("[V4-FIX PARSED] Balance: {:?}, Error: {:?}", final_balance, error);
                            let emit_result = app.emit("pw-balance-result-global", serde_json::json!({ "charId": char_id, "balance": final_balance, "error": error }));
                            match emit_result { Ok(_) => println!("[V4-FIX EMIT] Successfully emitted event."), Err(e) => println!("[V4-FIX EMIT] ERROR: {:?}", e) }
                            found_data = true;
                            break;
                        }
                    }
                }
            },
            Err(e) => { println!("[V4-FIX WARN] Could not read URL: {:?}", e); }
        }
    }

    if !found_data {
        println!("[V4-FIX TIMEOUT] Could not find valid data after {} attempts.", max_attempts);
        let emit_result = app.emit("pw-balance-result-global", serde_json::json!({ "charId": char_id, "balance": null, "error": "timeout_polling_smart" }));
        match emit_result { Ok(_) => {}, Err(e) => println!("[V4-FIX EMIT] ERROR: {:?}", e) }
    }

    println!("[V4-FIX END] Process finished.");
    println!("==================================================");
    
    Ok(())
}


// src-tauri/src/lib.rs

/// ПАРСЕР МАРАФОНА v1: Собирает прогресс по всем активным заданиям
#[command]
async fn fetch_marathon_progress_v1(app: AppHandle, char_id: String) -> Result<(), String> {
    let label = format!("sync-win-{}", char_id);
    println!("[MARATHON-PARSER] Starting parse for CharID: {}", char_id);

    let window = match app.get_webview_window(&label) {
        Some(w) => w,
        None => {
            println!("[MARATHON-PARSER] Creating hidden window...");
            let target_url_str = "https://pwonline.ru/supermarathon.php"; 
            let parsed_url = Url::from_str(target_url_str).map_err(|e| format!("Invalid URL: {}", e))?;
            let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let profiles_dir = app_data_dir.join("pw-sync-profiles").join(&char_id);
            std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

            let _win = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
                .title(format!("Marathon Sync: {}", char_id))
                .inner_size(800.0, 600.0)
                .resizable(false)
                .visible(false) 
                .data_directory(profiles_dir.clone()) 
                .build()
                .map_err(|e| e.to_string())?;
            
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            app.get_webview_window(&label).ok_or("Window creation failed")?
        }
    };

    let parser_script = r#"
        (function() {
            console.log('[MARATHON-JS] Starting marathon parsing...');
            function reportResult(data, error) {
                const errStr = error ? error.toString().replace(/[^a-zA-Z0-9_-]/g, '_') : "null";
                const dataStr = encodeURIComponent(JSON.stringify(data));
                window.location.hash = `TF_MARATHON_DATA_${errStr}_${dataStr}`;
            }
            try {
                const bodyText = document.body.innerText || "";
                if (bodyText.includes("Вы не авторизованы") || bodyText.includes("не имеете доступа")) {
                    reportResult(null, 'not_logged_in');
                    return;
                }
                const marathonContainer = document.querySelector('.season_marathon');
                if (!marathonContainer) {
                    reportResult([], 'container_not_found');
                    return;
                }
                const questBlocks = marathonContainer.querySelectorAll(':scope > div');
                const results = [];
                questBlocks.forEach(block => {
                    const titleEl = block.querySelector('b');
                    const title = titleEl ? titleEl.innerText.trim() : "Unknown Quest";
                    const progressEl = block.querySelector('.progress span');
                    let completed = 0;
                    let total = 0;
                    if (progressEl) {
                        const text = progressEl.innerText.trim();
                        const parts = text.split('/');
                        if (parts.length === 2) {
                            completed = parseInt(parts[0], 10) || 0;
                            total = parseInt(parts[1], 10) || 0;
                        }
                    }
                    if (total > 0 || completed > 0) {
                        results.push({ title: title, completed: completed, total: total, percentage: total > 0 ? Math.round((completed / total) * 100) : 0 });
                    }
                });
                reportResult(results, null);
            } catch (e) {
                reportResult(null, 'exception_' + e.message.substring(0, 20));
            }
        })();
    "#;

    println!("[MARATHON-PARSER] Injecting script...");
    window.eval(parser_script).map_err(|e| { println!("[MARATHON-PARSER ERROR] Eval failed: {}", e); e.to_string() })?;

    println!("[MARATHON-PARSER] Polling for results...");
    let max_attempts = 20; 
    
    for i in 0..max_attempts {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(url) = window.url() {
            let url_str = url.as_str();
            if url_str.contains("#TF_MARATHON_DATA_") {
                println!("[MARATHON-PARSER SUCCESS] Found data at attempt {}: {}", i+1, url_str.len());
                if let Some(pos) = url_str.find("#TF_MARATHON_DATA_") {
                    let content_start = pos + 17; 
                    let content_end = url_str.len();
                    let content = &url_str[content_start..content_end];
                    if let Some(split_idx) = content.find('_') {
                        let error_raw = &content[..split_idx];
                        let json_encoded = &content[split_idx + 1..];
                        let error: Option<String> = if error_raw == "null" { None } else { Some(error_raw.to_string()) };
                        let decoded_json = urlencoding::decode(json_encoded).unwrap_or_else(|_| "".into());
                        let data: serde_json::Value = serde_json::from_str(&decoded_json).unwrap_or(serde_json::Value::Null);
                        println!("[MARATHON-PARSER PARSED] Error: {:?}, Data Keys: {:?}", error, data.as_object().map(|o| o.keys().collect::<Vec<_>>()));
                        let emit_result = app.emit("marathon-progress-result-global", serde_json::json!({ "charId": char_id, "quests": data, "error": error }));
                        match emit_result { Ok(_) => println!("[MARATHON-PARSER EMIT] Successfully emitted event."), Err(e) => println!("[MARATHON-PARSER EMIT] ERROR: {:?}", e) }
                        return Ok(());
                    }
                }
            }
        }
    }

    println!("[MARATHON-PARSER TIMEOUT] Could not find valid data after {} attempts.", max_attempts);
    let emit_result = app.emit("marathon-progress-result-global", serde_json::json!({ "charId": char_id, "quests": [], "error": "timeout_parsing_marathon" }));
    match emit_result { Ok(_) => {}, Err(e) => println!("[MARATHON-PARSER EMIT] ERROR: {:?}", e) }
    
    Ok(())
}



/// БЫСТРЫЙ СКАН НАЗВАНИЙ МАРАФОНОВ (v4 - With Progress Events)
#[command]
async fn get_available_marathon_titles(app: AppHandle) -> Result<(), String> {
    println!("[TITLE SCANNER v4] Scanning for marathon titles...");

    let urls_to_check = vec![
        "https://pwonline.ru/supermarathon.php",
        "https://pwonline.ru/supermarathon2.php"
    ];

    // Отправляем событие начала сканирования (0%)
    let _ = app.emit("scan-progress-update", serde_json::json!({ "percent": 0, "message": "Подготовка..." }));

    let mut target_window = None;
    for (_, window) in app.webview_windows() {
        if window.label().starts_with("sync-win-") {
            target_window = Some(window);
            break;
        }
    }

    let base_window = match target_window {
        Some(w) => w,
        None => {
            println!("[TITLE SCANNER v4] No open windows found. Creating temporary hidden window...");
            let label = "sync-win-_title_scanner_v4_".to_string();
            let parsed_url = Url::from_str(urls_to_check[0]).map_err(|e| format!("Invalid URL: {}", e))?;
            
            let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let profiles_dir = app_data_dir.join("pw-sync-profiles").join("_title_scanner_v4_");
            std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

            let _win = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
                .title("Title Scanner v4")
                .inner_size(800.0, 600.0)
                .resizable(false)
                .visible(false) 
                .data_directory(profiles_dir.clone()) 
                .build()
                .map_err(|e| e.to_string())?;
            
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            app.get_webview_window(&label).ok_or("Temp window creation failed")?
        }
    };

    let mut results: Vec<serde_json::Value> = Vec::new();
    let total_urls = urls_to_check.len();

    for (index, url_str) in urls_to_check.iter().enumerate() {
        // Прогресс: 0%, 50%, 100%
        let percent = ((index as f64 / total_urls as f64) * 100.0) as u8;
        let _ = app.emit("scan-progress-update", serde_json::json!({ 
            "percent": percent, 
            "message": format!("Проверка: {}", url_str.split('/').last().unwrap_or("")) 
        }));

        println!("[TITLE SCANNER v4] Checking title on: {}", url_str);

        let target_url = Url::from_str(url_str).unwrap();
        base_window.navigate(target_url).map_err(|e| e.to_string())?;
        
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let parser_script = r#"
            (function() {
                function report(data, error) {
                    const errStr = error ? error.toString().replace(/[^a-zA-Z0-9_-]/g, '_') : "null";
                    const dataStr = encodeURIComponent(JSON.stringify(data));
                    window.location.hash = `TF_TITLE_V4_${errStr}_${dataStr}`;
                }
                try {
                    const bodyText = document.body.innerText || "";
                    if (bodyText.includes("Вы не авторизованы")) {
                         report(null, 'not_logged_in');
                         return;
                    }
                    const headers = document.querySelectorAll('h2');
                    let marathonName = null;
                    for (let h of headers) {
                        const text = h.innerText.trim();
                        if (text && text.length > 3 && !text.includes('Новости')) {
                            marathonName = text;
                            break;
                        }
                    }
                    if (!marathonName) {
                        report(null, 'no_title_found');
                        return;
                    }
                    report({ name: marathonName, url: window.location.href }, null);
                } catch (e) {
                    report(null, 'exception_' + e.message.substring(0, 20));
                }
            })();
        "#;

        base_window.eval(parser_script).map_err(|e| e.to_string())?;

        let max_attempts = 10;
        let mut found_on_this_page = false;

        for _i in 0..max_attempts {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            
            if let Ok(url_obj) = base_window.url() {
                let current_url_str = url_obj.as_str();
                
                if current_url_str.contains("#TF_TITLE_V4_") {
                    if let Some(pos) = current_url_str.find("#TF_TITLE_V4_") {
                        let content_start = pos + 13; 
                        let content_end = current_url_str.len();
                        let content = &current_url_str[content_start..content_end];
                        
                        if let Some(split_idx) = content.find('_') {
                            let error_raw = &content[..split_idx];
                            let json_encoded = &content[split_idx + 1..];
                            
                            let error: Option<String> = if error_raw == "null" { None } else { Some(error_raw.to_string()) };

                            if error.is_none() {
                                let decoded_result = urlencoding::decode(json_encoded);
                                
                                if let Ok(decoded_str) = decoded_result {
                                    if let Ok(data_val) = serde_json::from_str::<serde_json::Value>(&decoded_str) {
                                        let title_name = data_val["name"].as_str().unwrap_or("?");
                                        println!("[TITLE SCANNER v4] Found Title: {}", title_name);
                                        
                                        results.push(data_val);
                                        found_on_this_page = true;
                                    }
                                }
                            }
                            break; 
                        }
                    }
                }
            }
        }
        
        if !found_on_this_page {
             println!("[TITLE SCANNER v4] Timeout or no data on {}", url_str);
        }
    }

    // Финальный прогресс 100%
    let _ = app.emit("scan-progress-update", serde_json::json!({ "percent": 100, "message": "Готово" }));

    if base_window.label() == "sync-win-_title_scanner_v4_" {
         let _ = base_window.close();
    }

    let emit_result = app.emit(
        "marathon-titles-scanned-global", 
        serde_json::json!({
            "titles": results,
            "count": results.len()
        })
    );

    match emit_result {
        Ok(_) => println!("[TITLE SCANNER v4] Emitted {} titles.", results.len()),
        Err(e) => println!("[TITLE SCANNER v4] Emit Error: {:?}", e),
    }
    
    Ok(())
}


/// ДЕТАЛЬНЫЙ ПАРСИНГ КОНКРЕТНОЙ СТРАНИЦЫ МАРАФОНА (v4 - Robust Stage Parsing)
#[command]
async fn parse_specific_marathon_page(app: AppHandle, url: String) -> Result<(), String> {
    println!("[DETAIL PARSER v4] Parsing details from: {}", url);

    let mut target_window = None;
    for (_, window) in app.webview_windows() {
        if window.label().starts_with("sync-win-") {
            target_window = Some(window);
            break;
        }
    }

    let base_window = match target_window {
        Some(w) => w,
        None => {
            println!("[DETAIL PARSER v4] No open windows found. Creating temporary hidden window...");
            let label = "sync-win-_detail_parser_v4_".to_string();
            let parsed_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;
            
            let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let profiles_dir = app_data_dir.join("pw-sync-profiles").join("_detail_parser_v4_");
            std::fs::create_dir_all(&profiles_dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

            let _win = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
                .title("Detail Parser v4")
                .inner_size(800.0, 600.0)
                .resizable(false)
                .visible(false) 
                .data_directory(profiles_dir.clone()) 
                .build()
                .map_err(|e| e.to_string())?;
            
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            app.get_webview_window(&label).ok_or("Temp window creation failed")?
        }
    };

    let target_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    base_window.navigate(target_url).map_err(|e| e.to_string())?;
    
    println!("[DETAIL PARSER v4] Navigated. Waiting for load...");
    tokio::time::sleep(std::time::Duration::from_secs(6)).await; 

    let parser_script = r#"
        (function() {
            console.log('[DETAIL-PARSER-JS-v4] Starting deep parse with robust stages...');
            
            function reportResult(data, error) {
                const errStr = error ? error.toString().replace(/[^a-zA-Z0-9_-]/g, '_') : "null";
                const dataStr = encodeURIComponent(JSON.stringify(data));
                window.location.hash = `TF_DETAIL_V4_${errStr}_${dataStr}`;
            }

            try {
                const bodyText = document.body.innerText || "";
                if (bodyText.includes("Вы не авторизованы")) {
                     reportResult(null, 'not_logged_in');
                     return;
                }

                // 1. Название основного марафона
                const headerEl = document.querySelector('h2');
                const marathonName = headerEl ? headerEl.innerText.trim() : "Неизвестный Марафон";

                // 2. Парсинг этапов из .status_legend
                // Ищем блоки с текстом "Сроки проведения ... этапа ..."
                const legendBlock = document.querySelector('.status_legend');
                const stages = [];
                
                if (legendBlock) {
                    const paragraphs = legendBlock.querySelectorAll('p');
                    
                    paragraphs.forEach(p => {
                        const text = p.innerText.trim();
                        // Паттерн: "Сроки проведения первого этапа марафона (июнь): с 00:01 мск 30 мая до 23:59 мск 28 июня."
                        // Или просто: "(июнь): с ... до ..."
                        
                        const monthMatch = text.match(/\((.*?)\)/);
                        if (!monthMatch) return; // Не нашели месяц в скобках
                        
                        const stageMonthRaw = monthMatch[1].trim().toLowerCase(); // "июнь"
                        
                        // Ищем даты внутри этого же параграфа
                        // Паттерн: "с DD месяца ... до DD месяца"
                        const dateRegex = /с\s+\d{2}:\d{2}\s+мск\s+(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+до\s+\d{2}:\d{2}\s+мск\s+(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/gi;
                        const matches = [...text.matchAll(dateRegex)];
                        
                        if (matches.length > 0) {
                            const firstMatch = matches[0];
                            const startDay = parseInt(firstMatch[1]);
                            const startMonRaw = firstMatch[2].toLowerCase();
                            const endDay = parseInt(firstMatch[3]);
                            const endMonRaw = firstMatch[4].toLowerCase();

                            const monthMap = {
                                'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
                                'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
                                'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
                            };

                            const startMonNum = monthMap[startMonRaw] || '01';
                            const endMonNum = monthMap[endMonRaw] || '12';
                            const year = new Date().getFullYear(); 

                            const startDateISO = `${year}-${startMonNum}-${startDay.toString().padStart(2, '0')}`;
                            const endDateISO = `${year}-${endMonNum}-${endDay.toString().padStart(2, '0')}`;

                            stages.push({
                                name: stageMonthRaw.charAt(0).toUpperCase() + stageMonthRaw.slice(1), // Июнь
                                key: stageMonthRaw, // июнь
                                startDate: startDateISO,
                                endDate: endDateISO
                            });
                        }
                    });
                }

                // 3. Парсинг заданий
                const container = document.querySelector('.season_marathon');
                const quests = [];

                if (container) {
                    const questBlocks = container.querySelectorAll(':scope > div');
                    questBlocks.forEach(block => {
                        const titleEl = block.querySelector('b');
                        const descEl = block.querySelector('p'); 
                        const progressSpan = block.querySelector('.progress span');
                        
                        let totalGoal = 0;
                        if (progressSpan) {
                            const text = progressSpan.innerText.trim(); 
                            const parts = text.split('/');
                            if (parts.length === 2) {
                                totalGoal = parseInt(parts[1], 10) || 0;
                            }
                        }

                        if (titleEl && totalGoal > 0) {
                            const rawTitle = titleEl.innerText.trim();
                            // Извлекаем месяц из заголовка для привязки к этапу
                            // Пример: "Испытание снов (июль)" -> ключ "июль"
                            const monthInTitle = rawTitle.match(/\((.*?)\)/);
                            const associatedStageKey = monthInTitle ? monthInTitle[1].toLowerCase() : null;

                            // Чистое описание без префикса [месяц], если он был добавлен ранее
                            let cleanDescription = descEl ? descEl.innerText.trim() : "";
                            
                            quests.push({
                                id: crypto.randomUUID(), 
                                title: rawTitle,
                                description: cleanDescription,
                                goal: totalGoal,
                                stageKey: associatedStageKey 
                            });
                        }
                    });
                }

                const resultData = {
                    name: marathonName,
                    sourceUrl: window.location.href,
                    detectedAt: new Date().toISOString(),
                    stages: stages, 
                    quests: quests  
                };

                console.log('[DETAIL-PARSER-JS-v4] Success:', marathonName, 'Stages:', stages.length, 'Quests:', quests.length);
                reportResult(resultData, null);

            } catch (e) {
                console.error('[DETAIL-PARSER-JS-v4] Exception:', e);
                reportResult(null, 'exception_' + e.message.substring(0, 20));
            }
        })();
    "#;

    base_window.eval(parser_script).map_err(|e| e.to_string())?;

    let max_attempts = 20;
    let mut found = false;

    for _i in 0..max_attempts {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        
        if let Ok(url_obj) = base_window.url() {
            let current_url_str = url_obj.as_str();
            
            if current_url_str.contains("#TF_DETAIL_V4_") {
                if let Some(pos) = current_url_str.find("#TF_DETAIL_V4_") {
                    let content_start = pos + 14; 
                    let content_end = current_url_str.len();
                    let content = &current_url_str[content_start..content_end];
                    
                    if let Some(split_idx) = content.find('_') {
                        let error_raw = &content[..split_idx];
                        let json_encoded = &content[split_idx + 1..];
                        
                        let error: Option<String> = if error_raw == "null" { None } else { Some(error_raw.to_string()) };

                        if error.is_none() {
                            let decoded_result = urlencoding::decode(json_encoded);
                            
                            if let Ok(decoded_str) = decoded_result {
                                if let Ok(data_val) = serde_json::from_str::<serde_json::Value>(&decoded_str) {
                                    let emit_result = app.emit(
                                        "single-marathon-parsed-global", 
                                        serde_json::json!({ "marathon": data_val, "error": null })
                                    );
                                    
                                    if base_window.label() == "sync-win-_detail_parser_v4_" {
                                         let _ = base_window.close();
                                    }
                                    
                                    match emit_result {
                                        Ok(_) => println!("[DETAIL PARSER v4] Success."),
                                        Err(e) => println!("[DETAIL PARSER v4] Emit Error: {:?}", e),
                                    }
                                    return Ok(());
                                }
                            }
                        } else {
                             let emit_result = app.emit(
                                "single-marathon-parsed-global", 
                                serde_json::json!({ "marathon": null, "error": error })
                            );
                             if base_window.label() == "sync-win-_detail_parser_v4_" {
                                 let _ = base_window.close();
                            }
                            match emit_result {
                                Ok(_) => println!("[DETAIL PARSER v4] Sent error response."),
                                Err(e) => println!("[DETAIL PARSER v4] Emit Error: {:?}", e),
                            }
                            return Ok(());
                        }
                        found = true;
                        break; 
                    }
                }
            }
        }
    }

    if !found {
        if base_window.label() == "sync-win-_detail_parser_v4_" {
             let _ = base_window.close();
        }
        let emit_result = app.emit(
            "single-marathon-parsed-global", 
            serde_json::json!({ "marathon": null, "error": "timeout_parsing_details_v4" })
        );
        match emit_result {
            Ok(_) => println!("[DETAIL PARSER v4] Timeout sent."),
            Err(e) => println!("[DETAIL PARSER v4] Emit Error: {:?}", e),
        }
    }
    
    Ok(())
}